import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { DEPS_FILE, install } from "./sources.mjs";
import { CHECK_INTERVAL_MS, missingTools, providedCommands, reportSkills, startupMessage, upstreamFindings } from "./startup.mjs";
import { SKILL, fakeGitHub } from "./test/fake-github.mjs";

function tmp(t) {
	const root = fs.mkdtempSync(join(os.tmpdir(), "skill-startup-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

test("providedCommands reads every provides line, space- or comma-separated, without duplicates", () => {
	const script = "#!/usr/bin/env bash\n# provides: crapper dryer\n#provides:mutator, crapper\necho '# provides: not-a-comment'\n";

	assert.deepEqual(providedCommands(script), ["crapper", "dryer", "mutator"]);
	assert.deepEqual(providedCommands("#!/bin/sh\necho hi\n"), []);
});

test("missingTools lists declared commands that are not on PATH, per skill", (t) => {
	const root = tmp(t);
	const skillsDir = join(root, "skills");
	const bin = join(root, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(join(bin, "dryer"), "", { mode: 0o755 });
	for (const [skill, script] of [
		["ub-mode", "# provides: crapper dryer mutator\n"],
		["ready", "# provides: dryer\n"],
		["undeclared", "echo nothing declared\n"],
	]) {
		fs.mkdirSync(join(skillsDir, skill), { recursive: true });
		fs.writeFileSync(join(skillsDir, skill, DEPS_FILE), script);
	}
	fs.mkdirSync(join(skillsDir, "plain"));

	assert.deepEqual(missingTools(skillsDir, bin), [{ skill: "ub-mode", missing: ["crapper", "mutator"] }]);
	assert.deepEqual(missingTools(join(root, "nope"), bin), []);
});

test("upstreamFindings reports behind and gone skills and then waits a day before calling GitHub again", async (t) => {
	const root = tmp(t);
	const skillsDir = join(root, "skills");
	const statePath = join(root, "state/check.json");
	const repos = {
		"o/r": { HEAD: "main", refs: { main: { "a/SKILL.md": SKILL("a"), "b/SKILL.md": SKILL("b"), "c/SKILL.md": SKILL("c") } } },
	};
	const gh = fakeGitHub({ repos });
	const deps = { fetch: gh.fetch };
	for (const s of ["a", "b", "c"]) await install(`https://github.com/o/r/tree/main/${s}`, { skillsDir, ...deps });
	fs.mkdirSync(join(skillsDir, "broken"));
	fs.writeFileSync(join(skillsDir, "broken/.source.json"), "{");
	repos["o/r"].refs.main["a/SKILL.md"] = SKILL("a", "v2");
	delete repos["o/r"].refs.main["b/SKILL.md"];
	const now = Date.parse("2026-11-01T08:00:00Z");

	const first = await upstreamFindings({ skillsDir, statePath, now, deps });

	assert.deepEqual(first, [
		{ skill: "a", status: "behind" },
		{ skill: "b", status: "gone" },
	]);
	assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { lastCheck: now });
	const calls = gh.calls.length;
	assert.deepEqual(await upstreamFindings({ skillsDir, statePath, now: now + CHECK_INTERVAL_MS - 1, deps }), []);
	assert.equal(gh.calls.length, calls);
	assert.equal((await upstreamFindings({ skillsDir, statePath, now: now + CHECK_INTERVAL_MS, deps })).length, 2);
});

test("upstreamFindings keeps the old check time when a call fails, so the next session retries", async (t) => {
	const root = tmp(t);
	const skillsDir = join(root, "skills");
	const statePath = join(root, "check.json");
	const state = { repos: { "o/r": { HEAD: "main", refs: { main: { "a/SKILL.md": SKILL("a") } } } } };
	const deps = { fetch: fakeGitHub(state).fetch };
	await install("https://github.com/o/r/tree/main/a", { skillsDir, ...deps });
	state.apiStatus = { status: 403, headers: { "x-ratelimit-remaining": "0" } };
	const now = Date.parse("2026-11-01T08:00:00Z");

	assert.deepEqual(await upstreamFindings({ skillsDir, statePath, now, deps }), []);
	assert.equal(fs.existsSync(statePath), false);

	fs.writeFileSync(statePath, "not json");
	delete state.apiStatus;
	assert.deepEqual(await upstreamFindings({ skillsDir, statePath, now: now + 1000, deps }), []);
	assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { lastCheck: now + 1000 });
});

test("startupMessage lists each finding with the command that resolves it, or nothing", () => {
	assert.equal(startupMessage([], []), null);
	assert.equal(
		startupMessage(
			[{ skill: "ub-mode", missing: ["crapper", "dryer"] }],
			[
				{ skill: "a", status: "behind" },
				{ skill: "b", status: "gone" },
			],
		),
		[
			"my-pi skills:",
			"- ub-mode: crapper, dryer missing → /skill-install ub-mode",
			"- a: newer version upstream → /skills-update",
			"- b: source not found → /skills-update to keep or relink",
		].join("\n"),
	);
});

test("reportSkills shows one warning when there is something to do, nothing when clean, and an error when it fails", async (t) => {
	const root = tmp(t);
	const skillsDir = join(root, "skills");
	fs.mkdirSync(join(skillsDir, "ub-mode"), { recursive: true });
	fs.writeFileSync(join(skillsDir, "ub-mode", DEPS_FILE), "# provides: crapper\n");
	const shown = [];
	const ui = { notify: (text, level) => shown.push([level, text]) };
	const base = { skillsDir, statePath: join(root, "check.json"), deps: { fetch: fakeGitHub({ repos: {} }).fetch }, ui };

	const text = await reportSkills({ ...base, pathEnv: "" });
	assert.equal(text, "my-pi skills:\n- ub-mode: crapper missing → /skill-install ub-mode");
	assert.deepEqual(shown, [["warning", text]]);

	const bin = join(root, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(join(bin, "crapper"), "", { mode: 0o755 });
	assert.equal(await reportSkills({ ...base, pathEnv: bin }), null);
	assert.equal(shown.length, 1);

	fs.mkdirSync(join(root, "blocked"));
	const failed = await reportSkills({ ...base, statePath: join(root, "blocked"), pathEnv: bin });
	assert.match(failed, /^my-pi skills: check failed: /);
	assert.equal(shown[1][0], "error");

	const headlessState = join(root, "headless.json");
	assert.equal(await reportSkills({ ...base, statePath: headlessState, ui: null, pathEnv: "" }), null);
	assert.equal(fs.existsSync(headlessState), false);
});
