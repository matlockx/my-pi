import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { CHOICES, installOne, removeOne, runDeps, updateAll } from "./flows.mjs";
import { DEPS_FILE, SOURCE_FILE, install, readSource } from "./sources.mjs";
import { SKILL, fakeGitHub } from "./test/fake-github.mjs";

/** UI that answers select/input/confirm from answers in order and records every dialog and notification. */
function fakeUi(answers) {
	const asked = [];
	const notes = [];
	const next = (kind, title, extra) => {
		asked.push({ kind, title, extra });
		if (!answers.length) throw new Error(`unexpected ${kind}: ${title}`);
		return answers.shift();
	};
	return {
		asked,
		notes,
		select: async (title, options) => next("select", title, options),
		input: async (title) => next("input", title),
		confirm: async (title, body) => next("confirm", title, body),
		notify: (message, level) => notes.push([level, message]),
	};
}

function setup(t, repos, answers) {
	const skillsDir = fs.mkdtempSync(join(os.tmpdir(), "skill-flows-"));
	t.after(() => fs.rmSync(skillsDir, { recursive: true, force: true }));
	const state = { repos };
	const deps = { fetch: fakeGitHub(state).fetch };
	const ui = answers ? fakeUi(answers) : null;
	return { skillsDir, state, deps, ui, env: { skillsDir, ui, deps } };
}

const REPO = () => ({ "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s"), "s/x.md": "x" } } } });

test("updateAll reports an empty skills folder", async (t) => {
	const { env, skillsDir } = setup(t, {});

	assert.equal(await updateAll(env), `No skills installed from GitHub links in ${skillsDir}.`);
});

test("updateAll reports one line per skill: current, updated, broken record and failed check", async (t) => {
	const repos = REPO();
	const { env, skillsDir, state, deps } = setup(t, repos);
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	await install("https://github.com/o/r/tree/main/s", { skillsDir, name: "copy", ...deps });
	fs.mkdirSync(join(skillsDir, "broken"));
	fs.writeFileSync(join(skillsDir, "broken", SOURCE_FILE), "{");
	repos["o/r"].refs.main["s/x.md"] = "x2";

	const lines = (await updateAll(env)).split("\n");

	assert.match(lines[0], /^broken: error: \.source\.json unreadable: /);
	assert.equal(lines[1], "copy: updated: wrote x.md");
	assert.equal(lines[2], "s: updated: wrote x.md");
	state.apiStatus = { status: 500, headers: {} };
	assert.match(await updateAll(env), /^broken: .*\ncopy: error: GitHub API .* answered 500\n/);
});

test("a gone source is kept and excluded, or skipped, as the user chooses", async (t) => {
	const repos = REPO();
	const { env, ui, skillsDir, deps } = setup(t, repos, [CHOICES.skip, CHOICES.keep]);
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	delete repos["o/r"];

	assert.equal(await updateAll(env), "s: source not found at https://github.com/o/r/tree/main/s; skipped");
	assert.equal(readSource(join(skillsDir, "s")).updates, true);
	assert.equal(await updateAll(env), "s: source not found; local copy kept and excluded from updates");
	assert.equal(readSource(join(skillsDir, "s")).updates, false);
	assert.deepEqual(ui.asked[0].extra, [CHOICES.keep, CHOICES.relink, CHOICES.skip]);
	assert.equal(await updateAll(env), "s: excluded from updates");
});

test("a gone source can be relinked after an empty and a wrong link, and the error is shown", async (t) => {
	const repos = REPO();
	const { env, ui, skillsDir, deps } = setup(t, repos, [
		CHOICES.relink,
		"",
		CHOICES.relink,
		"https://github.com/n/r2/tree/trunk/nope",
		CHOICES.relink,
		"https://github.com/n/r2/tree/trunk/skills/s",
	]);
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	delete repos["o/r"];
	repos["n/r2"] = { HEAD: "trunk", refs: { trunk: { "skills/s/SKILL.md": SKILL("s", "moved"), "skills/s/x.md": "x" } } };

	const out = await updateAll(env);

	assert.equal(out, "s: relinked to https://github.com/n/r2/tree/trunk/skills/s; updated: wrote SKILL.md");
	assert.equal(ui.notes.length, 1);
	assert.match(ui.notes[0][1], /^s: nothing found at https:\/\/github\.com\/n\/r2\/tree\/trunk\/nope/);
	assert.equal(ui.notes[0][0], "error");
	assert.equal(readSource(join(skillsDir, "s")).owner, "n");
});

test("without a UI, a gone source and local edits are reported for an interactive session", async (t) => {
	const repos = REPO();
	const { env, skillsDir, deps } = setup(t, repos);
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	fs.writeFileSync(join(skillsDir, "s/x.md"), "mine");
	repos["o/r"].refs.main["s/SKILL.md"] = SKILL("s", "v2");

	assert.equal(
		await updateAll(env),
		"s: upstream changed, not updated because of local edits in x.md; run /skills-update in an interactive session to decide",
	);
	delete repos["o/r"];
	assert.match(await updateAll(env), /^s: source not found at .*; run \/skills-update in an interactive session to keep or relink it$/);
});

test("local edits are overwritten, skipped, or kept with updates off, as the user chooses", async (t) => {
	const repos = REPO();
	const { env, skillsDir, deps } = setup(t, repos, [CHOICES.skipEdits, CHOICES.keepEdits, CHOICES.overwrite]);
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	await install("https://github.com/o/r/tree/main/s", { skillsDir, name: "t", ...deps });
	fs.writeFileSync(join(skillsDir, "s/x.md"), "mine");
	fs.writeFileSync(join(skillsDir, "t/x.md"), "mine");
	repos["o/r"].refs.main["s/SKILL.md"] = SKILL("s", "v2");

	assert.equal(await updateAll(env), "s: local edits kept; skipped this update\nt: local edits kept; excluded from updates");
	assert.equal(fs.readFileSync(join(skillsDir, "s/x.md"), "utf8"), "mine");
	assert.equal(readSource(join(skillsDir, "t")).updates, false);

	assert.equal(await updateAll(env), "s: updated: wrote SKILL.md, x.md\nt: excluded from updates");
	assert.equal(fs.readFileSync(join(skillsDir, "s/x.md"), "utf8"), "x");
	assert.equal(fs.readFileSync(join(skillsDir, "t/x.md"), "utf8"), "mine");
});

test("installOne reports the install, and asks before overwriting local edits on a re-install", async (t) => {
	const repos = REPO();
	const { env, skillsDir } = setup(t, repos, [CHOICES.overwrite]);
	const dir = join(skillsDir, "s");

	assert.equal(await installOne(env, "https://github.com/o/r/tree/main/s"), `s (${dir}): updated: wrote SKILL.md, x.md`);
	fs.writeFileSync(join(dir, "x.md"), "mine");
	repos["o/r"].refs.main["s/SKILL.md"] = SKILL("s", "v2");

	assert.equal(await installOne(env, "https://github.com/o/r/tree/main/s"), `s (${dir}): updated: wrote SKILL.md, x.md`);
	assert.equal(fs.readFileSync(join(dir, "x.md"), "utf8"), "x");
	assert.match(env.ui.asked[0].title, /^s: upstream changed, local edits in x\.md$/);
});

test("runDeps writes the script, shows it, and runs it only after the user agrees", async (t) => {
	const { env, skillsDir } = setup(t, {}, [false, true]);
	fs.mkdirSync(join(skillsDir, "s"));
	fs.writeFileSync(join(skillsDir, "s/SKILL.md"), SKILL("s"));
	const file = join(skillsDir, "s", DEPS_FILE);

	const declined = await runDeps(env, "s", "echo installed > marker");
	assert.equal(declined, `${file} not run: the user declined. Run it in a host shell: bash '${file}'`);
	assert.equal(fs.existsSync(join(skillsDir, "s/marker")), false);
	assert.match(env.ui.asked[0].extra, /echo installed > marker/);

	const ran = await runDeps(env, "s");
	assert.equal(ran, `${file} succeeded.\n--- output (last part) ---\n`);
	assert.equal(fs.readFileSync(join(skillsDir, "s/marker"), "utf8"), "installed\n");
});

test("runDeps tells sandbox failures from other failures, and needs a UI and a script", async (t) => {
	const { env, skillsDir } = setup(t, {}, [true, true]);
	fs.mkdirSync(join(skillsDir, "s"));
	fs.writeFileSync(join(skillsDir, "s/SKILL.md"), SKILL("s"));
	const file = join(skillsDir, "s", DEPS_FILE);

	await assert.rejects(runDeps(env, "s"), /does not exist; pass the script/);
	const blocked = await runDeps(env, "s", "echo 'ln: /x: Operation not permitted' >&2; exit 1");
	assert.match(blocked, /failed \(exit 1\)\.\nThe run was blocked by the sandbox or file permissions\. Run it in a host shell: bash '/);
	assert.match(blocked, /Operation not permitted/);
	const failed = await runDeps(env, "s", "echo 'fatal: repository not found'; exit 3");
	assert.match(failed, /failed \(exit 3\)\.\nIf this failed because of the sandbox, run it in a host shell: bash '/);
	assert.equal(await runDeps({ ...env, ui: null }, "s"), `${file} not run: no UI available to ask for permission. Run it in a host shell: bash '${file}'`);
});

test("removeOne deletes only after confirmation, names the way back, and refuses without a UI", async (t) => {
	const repos = REPO();
	const { env, skillsDir, deps } = setup(t, repos, [false, true, true]);
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	fs.mkdirSync(join(skillsDir, "own"));
	fs.writeFileSync(join(skillsDir, "own/SKILL.md"), SKILL("own"));

	assert.equal(await removeOne(env, "own"), "skill own kept: deletion declined");
	assert.equal(await removeOne(env, "own"), `deleted ${join(skillsDir, "own")}`);
	assert.equal(await removeOne(env, "s"), `deleted ${join(skillsDir, "s")}`);
	assert.match(env.ui.asked[0].extra, /Not installed from a link; only git can restore it/);
	assert.match(env.ui.asked[2].extra, /Installed from https:\/\/github\.com\/o\/r\/tree\/main\/s; \/skill-install can bring it back\./);
	await assert.rejects(removeOne({ ...env, ui: null }, "x"), /skill x not deleted: no UI available/);
});
