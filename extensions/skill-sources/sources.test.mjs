import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
	DEPS_FILE,
	SOURCE_FILE,
	blobSha,
	check,
	describe,
	exclude,
	frontMatter,
	install,
	listInstalled,
	parseGitHubUrl,
	preview,
	readSource,
	refCandidates,
	relink,
	remove,
	update,
} from "./sources.mjs";
import { SKILL, fakeGitHub } from "./test/fake-github.mjs";

function setup(t, repos) {
	const skillsDir = fs.mkdtempSync(join(os.tmpdir(), "skill-sources-"));
	t.after(() => fs.rmSync(skillsDir, { recursive: true, force: true }));
	const state = { repos };
	const gh = fakeGitHub(state);
	const deps = { fetch: gh.fetch, now: () => new Date("2026-11-01T10:00:00Z") };
	return { skillsDir, state, gh, deps };
}

const entry = (skillsDir, name) => listInstalled(skillsDir).find((e) => e.name === name);

test("parseGitHubUrl accepts blob, tree, repository and raw links", () => {
	assert.deepEqual(parseGitHubUrl("https://github.com/o/r/blob/main/skills/x/SKILL.md"), {
		owner: "o",
		repo: "r",
		kind: "file",
		rest: ["main", "skills", "x", "SKILL.md"],
	});
	assert.deepEqual(parseGitHubUrl("https://github.com/o/r/tree/main/skills/x/?tab=readme#top"), {
		owner: "o",
		repo: "r",
		kind: "dir",
		rest: ["main", "skills", "x"],
	});
	assert.deepEqual(parseGitHubUrl("https://github.com/o/r.git"), { owner: "o", repo: "r", kind: "dir", rest: [] });
	assert.equal(parseGitHubUrl("https://raw.githubusercontent.com/o/r/main/a.md").kind, "file");
	assert.throws(() => parseGitHubUrl("https://gitlab.com/o/r"), /not a GitHub link/);
	assert.throws(() => parseGitHubUrl("https://github.com/o/r/issues/1"), /unsupported GitHub link/);
	assert.throws(() => parseGitHubUrl("https://raw.githubusercontent.com/o/r/main"), /without ref and file path/);
	assert.throws(() => parseGitHubUrl("skills/x"), /not a URL/);
});

test("refCandidates keeps at least one path segment for files and allows an empty path for directories", () => {
	assert.deepEqual(refCandidates(parseGitHubUrl("https://github.com/o/r/blob/feat/x/SKILL.md")), [
		{ ref: "feat", path: "x/SKILL.md" },
		{ ref: "feat/x", path: "SKILL.md" },
	]);
	assert.deepEqual(refCandidates(parseGitHubUrl("https://github.com/o/r/tree/main")), [{ ref: "main", path: "" }]);
	assert.deepEqual(refCandidates(parseGitHubUrl("https://github.com/o/r")), [{ ref: null, path: "" }]);
});

test("installs a skill directory with its files, modes and recorded blob SHAs", async (t) => {
	const { skillsDir, deps } = setup(t, {
		"o/r": {
			HEAD: "main",
			refs: {
				main: {
					"skills/pdf/SKILL.md": SKILL("PDF Tools"),
					"skills/pdf/scripts/run.sh": { text: "#!/bin/sh\n", mode: "100755" },
					"skills/other/SKILL.md": SKILL("other"),
				},
			},
		},
	});

	const r = await install("https://github.com/o/r/tree/main/skills/pdf", { skillsDir, ...deps });

	assert.equal(r.name, "pdf-tools");
	assert.equal(r.status, "updated");
	const dir = join(skillsDir, "pdf-tools");
	assert.equal(fs.readFileSync(join(dir, "SKILL.md"), "utf8"), SKILL("PDF Tools"));
	assert.equal(fs.statSync(join(dir, "scripts/run.sh")).mode & 0o777, 0o755);
	assert.equal(fs.existsSync(join(dir, "other")), false);
	const src = readSource(dir);
	assert.equal(src.ref, "main");
	assert.equal(src.path, "skills/pdf");
	assert.equal(src.updates, true);
	assert.deepEqual(Object.keys(src.files).sort(), ["SKILL.md", "scripts/run.sh"]);
	assert.equal(src.files["SKILL.md"], blobSha(Buffer.from(SKILL("PDF Tools"))));
});

test("installs a single file link as <name>/SKILL.md, resolving a branch name with a slash", async (t) => {
	const md = "---\ndescription: No name here.\n---\nText\n";
	const { skillsDir, deps } = setup(t, { "o/r": { refs: { "feat/x": { "skills/review/SKILL.md": md } } } });

	const r = await install("https://github.com/o/r/blob/feat/x/skills/review/SKILL.md", { skillsDir, ...deps });

	assert.equal(r.name, "review");
	assert.equal(fs.readFileSync(join(skillsDir, "review/SKILL.md"), "utf8"), md);
	const src = readSource(join(skillsDir, "review"));
	assert.equal(src.ref, "feat/x");
	assert.equal(src.kind, "file");
});

test("install refuses a directory not installed from a link, a different source and a file without front matter", async (t) => {
	const { skillsDir, deps } = setup(t, {
		"o/r": { HEAD: "main", refs: { main: { "a/SKILL.md": SKILL("mine"), "b/SKILL.md": SKILL("mine"), "c.md": "plain" } } },
	});
	fs.mkdirSync(join(skillsDir, "mine"));
	fs.writeFileSync(join(skillsDir, "mine/SKILL.md"), "own skill");

	await assert.rejects(install("https://github.com/o/r/tree/main/a", { skillsDir, ...deps }), /was not installed from a link/);
	assert.equal(fs.readFileSync(join(skillsDir, "mine/SKILL.md"), "utf8"), "own skill");

	await install("https://github.com/o/r/tree/main/a", { skillsDir, name: "a", ...deps });
	await assert.rejects(
		install("https://github.com/o/r/tree/main/b", { skillsDir, name: "a", ...deps }),
		/is installed from https:\/\/github.com\/o\/r\/tree\/main\/a/,
	);
	await assert.rejects(install("https://github.com/o/r/blob/main/c.md", { skillsDir, ...deps }), /no front matter/);
	assert.equal(fs.existsSync(join(skillsDir, "c")), false);
});

test("install of a missing link fails without creating anything", async (t) => {
	const { skillsDir, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "a/SKILL.md": SKILL("a") } } } });

	await assert.rejects(install("https://github.com/o/r/tree/main/zzz", { skillsDir, ...deps }), /nothing found/);
	assert.deepEqual(fs.readdirSync(skillsDir), []);
});

test("update downloads only changed files, removes deleted ones and reports up to date afterwards", async (t) => {
	const { skillsDir, state, gh, deps } = setup(t, {
		"o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s"), "s/ref/a.md": "a", "s/b.md": "b" } } },
	});
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	const main = state.repos["o/r"].refs.main;
	main["s/b.md"] = "b2";
	delete main["s/ref/a.md"];
	main["s/c.md"] = "c";
	const before = gh.calls.length;

	const r = await update(entry(skillsDir, "s"), deps);

	assert.equal(describe(r), "updated: wrote b.md, c.md; removed ref/a.md");
	const downloads = gh.calls.slice(before).filter((c) => c.startsWith("https://raw.githubusercontent.com"));
	assert.equal(downloads.length, 2);
	assert.equal(fs.readFileSync(join(skillsDir, "s/b.md"), "utf8"), "b2");
	assert.equal(fs.existsSync(join(skillsDir, "s/ref")), false);
	assert.equal(readSource(join(skillsDir, "s")).updatedAt, "2026-11-01T10:00:00.000Z");

	const again = await update(entry(skillsDir, "s"), deps);
	assert.equal(describe(again), "up to date");
});

test("update reports a gone source without touching the files, and skips excluded skills without a call", async (t) => {
	const { skillsDir, state, gh, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s") } } } });
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	delete state.repos["o/r"];

	assert.equal((await update(entry(skillsDir, "s"), deps)).status, "gone");
	assert.equal(fs.readFileSync(join(skillsDir, "s/SKILL.md"), "utf8"), SKILL("s"));

	exclude(entry(skillsDir, "s"));
	const calls = gh.calls.length;
	assert.equal((await update(entry(skillsDir, "s"), deps)).status, "excluded");
	assert.equal(gh.calls.length, calls);
	assert.equal(readSource(join(skillsDir, "s")).updates, false);
});

test("update keeps local edits unless overwrite is set", async (t) => {
	const { skillsDir, state, deps } = setup(t, {
		"o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s"), "s/x.md": "x" } } },
	});
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	fs.writeFileSync(join(skillsDir, "s/x.md"), "my edit");

	const unchanged = await update(entry(skillsDir, "s"), deps);
	assert.equal(describe(unchanged), "up to date; local edits kept in x.md");

	state.repos["o/r"].refs.main["s/SKILL.md"] = SKILL("s", "New body.");
	const blocked = await update(entry(skillsDir, "s"), deps);
	assert.equal(blocked.status, "local-edits");
	assert.deepEqual(blocked.edits, ["x.md"]);
	assert.equal(fs.readFileSync(join(skillsDir, "s/SKILL.md"), "utf8"), SKILL("s"));

	const forced = await update(entry(skillsDir, "s"), deps, { overwrite: true });
	assert.equal(describe(forced), "updated: wrote SKILL.md, x.md");
	assert.equal(fs.readFileSync(join(skillsDir, "s/x.md"), "utf8"), "x");
});

test("a download that does not match its blob SHA writes nothing", async (t) => {
	const { skillsDir, state, deps } = setup(t, {
		"o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s"), "s/x.md": "x" } } },
	});
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	const main = state.repos["o/r"].refs.main;
	main["s/SKILL.md"] = SKILL("s", "v2");
	main["s/x.md"] = "x2";
	state.corrupt = true;
	const sourceBefore = fs.readFileSync(join(skillsDir, "s", SOURCE_FILE), "utf8");

	await assert.rejects(update(entry(skillsDir, "s"), deps), /changed upstream during the download/);
	assert.equal(fs.readFileSync(join(skillsDir, "s/x.md"), "utf8"), "x");
	assert.equal(fs.readFileSync(join(skillsDir, "s", SOURCE_FILE), "utf8"), sourceBefore);
});

test("API failures are errors with their cause, not a gone source", async (t) => {
	const { skillsDir, state, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s") } } } });
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	const cases = [
		[{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" } }, /GitHub API rate limit reached; set GITHUB_TOKEN/],
		[{ status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1798000000" } }, /rate limit reached until .+; set/],
		[{ status: 403, headers: {} }, /answered 403$/],
		[{ status: 401, headers: {} }, /rejected the token in GITHUB_TOKEN\/GH_TOKEN \(401\)/],
		[{ status: 500, headers: {} }, /GitHub API \/repos\/o\/r\/git\/trees\/main:s\?recursive=1 answered 500$/],
	];

	for (const [apiStatus, message] of cases) {
		state.apiStatus = apiStatus;
		await assert.rejects(update(entry(skillsDir, "s"), deps), message);
	}
});

test("tree listings that are truncated or lack SKILL.md are refused", async (t) => {
	const { skillsDir, state, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s"), "d/x.md": "x" } } } });

	await assert.rejects(install("https://github.com/o/r/tree/main/d", { skillsDir, ...deps }), /no SKILL.md at the top of d/);
	state.truncated = true;
	await assert.rejects(install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps }), /s has too many files/);
	assert.deepEqual(fs.readdirSync(skillsDir), []);
});

test("installs a repository root and a file link at the repository root", async (t) => {
	const { skillsDir, deps } = setup(t, {
		"o/whole": { HEAD: "main", refs: { main: { "SKILL.md": SKILL("whole"), "ref/a.md": "a" } } },
		"o/single": { HEAD: "main", refs: { main: { "SKILL.md": SKILL("single") } } },
	});

	const whole = await install("https://github.com/o/whole", { skillsDir, ...deps });
	const single = await install("https://github.com/o/single/blob/main/SKILL.md", { skillsDir, ...deps });

	assert.equal(whole.name, "whole");
	assert.equal(readSource(join(skillsDir, "whole")).ref, null);
	assert.equal(fs.readFileSync(join(skillsDir, "whole/ref/a.md"), "utf8"), "a");
	assert.equal(single.name, "single");
	assert.equal(readSource(join(skillsDir, "single")).path, "SKILL.md");
});

test("install refuses a name that sanitises to nothing", async (t) => {
	const { skillsDir, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s") } } } });

	await assert.rejects(install("https://github.com/o/r/tree/main/s", { skillsDir, name: "!!!", ...deps }), /invalid skill name: !!!/);
});

test("describe names every result status and lists skipped paths only for current and updated", () => {
	const skipped = ["link"];
	assert.equal(describe({ status: "excluded" }), "excluded from updates");
	assert.equal(describe({ status: "gone" }), "source not found");
	assert.equal(describe({ status: "current", edits: [], skipped }), "up to date; skipped symlinks/submodules: link");
	assert.equal(describe({ status: "current", edits: ["a.md"], skipped: [] }), "up to date; local edits kept in a.md");
	assert.equal(
		describe({ status: "local-edits", edits: ["a.md"], skipped }),
		"upstream changed, not updated because of local edits in a.md",
	);
	assert.equal(
		describe({ status: "updated", changed: ["a.md"], removed: ["b.md"], skipped }),
		"updated: wrote a.md; removed b.md; skipped symlinks/submodules: link",
	);
	assert.equal(describe({ status: "behind" }), "behind");
});

test("relink saves the new link, keeps edit detection and syncs from the new source", async (t) => {
	const { skillsDir, state, deps } = setup(t, {
		"o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s"), "s/x.md": "x" } } },
		"n/r2": { HEAD: "trunk", refs: { trunk: { "skills/s/SKILL.md": SKILL("s", "moved"), "skills/s/x.md": "x" } } },
	});
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	delete state.repos["o/r"];
	await assert.rejects(relink(entry(skillsDir, "s"), "https://github.com/n/r2/tree/trunk/nope", deps), /nothing found/);

	const r = await relink(entry(skillsDir, "s"), "https://github.com/n/r2/tree/trunk/skills/s", deps);

	assert.equal(describe(r), "updated: wrote SKILL.md");
	const src = readSource(join(skillsDir, "s"));
	assert.equal(src.url, "https://github.com/n/r2/tree/trunk/skills/s");
	assert.equal(src.owner, "n");
	assert.equal(src.path, "skills/s");
	assert.equal((await update(entry(skillsDir, "s"), deps)).status, "current");
});

test("reinstalling an excluded skill from the same link re-enables updates", async (t) => {
	const { skillsDir, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s") } } } });
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	exclude(entry(skillsDir, "s"));

	const r = await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });

	assert.equal(r.status, "current");
	assert.equal(readSource(join(skillsDir, "s")).updates, true);
});

test("reinstalling an excluded skill with local edits re-enables updates without overwriting the edits", async (t) => {
	const { skillsDir, state, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s") } } } });
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	exclude(entry(skillsDir, "s"));
	fs.writeFileSync(join(skillsDir, "s/SKILL.md"), SKILL("s", "mine"));
	state.repos["o/r"].refs.main["s/SKILL.md"] = SKILL("s", "v2");

	const r = await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });

	assert.equal(r.status, "local-edits");
	assert.equal(fs.readFileSync(join(skillsDir, "s/SKILL.md"), "utf8"), SKILL("s", "mine"));
	assert.equal(readSource(join(skillsDir, "s")).updates, true);
	assert.equal((await update(entry(skillsDir, "s"), deps)).status, "local-edits");
});

test("listInstalled ignores own skills and reports an unreadable record", (t) => {
	const { skillsDir } = setup(t, {});
	fs.mkdirSync(join(skillsDir, "own"));
	fs.writeFileSync(join(skillsDir, "own/SKILL.md"), SKILL("own"));
	fs.mkdirSync(join(skillsDir, "broken"));
	fs.writeFileSync(join(skillsDir, "broken", SOURCE_FILE), "{");

	const list = listInstalled(skillsDir);

	assert.deepEqual(list.map((e) => e.name), ["broken"]);
	assert.match(list[0].error, /unreadable/);
});

test("frontMatter reads quoted and folded values and returns null without front matter", () => {
	assert.deepEqual(frontMatter(`---\nname: "go"\ndescription: 'Go rules.'\n---\nx`), { name: "go", description: "Go rules." });
	assert.deepEqual(frontMatter("---\nname: x\ndescription: >\n  Line one\n  line two.\nother: y\n---\n"), {
		name: "x",
		description: "Line one line two.",
	});
	assert.deepEqual(frontMatter("---\nfoo: bar\n---\n"), { name: undefined, description: undefined });
	assert.equal(frontMatter("# no front matter"), null);
});

test("check reports current, behind, gone and excluded without writing", async (t) => {
	const { skillsDir, state, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s") } } } });
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	fs.writeFileSync(join(skillsDir, "s/SKILL.md"), "edited");
	const record = fs.readFileSync(join(skillsDir, "s", SOURCE_FILE), "utf8");

	assert.deepEqual(await check(entry(skillsDir, "s"), deps), { status: "current", edits: ["SKILL.md"] });
	state.repos["o/r"].refs.main["s/extra.md"] = "new";
	assert.equal((await check(entry(skillsDir, "s"), deps)).status, "behind");
	delete state.repos["o/r"];
	assert.equal((await check(entry(skillsDir, "s"), deps)).status, "gone");
	assert.equal(fs.readFileSync(join(skillsDir, "s/SKILL.md"), "utf8"), "edited");
	assert.equal(fs.readFileSync(join(skillsDir, "s", SOURCE_FILE), "utf8"), record);
	exclude(entry(skillsDir, "s"));
	assert.equal((await check(entry(skillsDir, "s"), deps)).status, "excluded");
});

test("remove asks with the directory and link, and deletes only after confirmation", async (t) => {
	const { skillsDir, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s") } } } });
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	fs.mkdirSync(join(skillsDir, "own/ref"), { recursive: true });
	fs.writeFileSync(join(skillsDir, "own/SKILL.md"), SKILL("own"));
	fs.writeFileSync(join(skillsDir, "own/ref/a.md"), "a");
	const asked = [];
	const answer = (ok) => async (info) => (asked.push(info), ok);

	const declined = await remove(skillsDir, "own", answer(false));
	assert.deepEqual(declined, { dir: join(skillsDir, "own"), url: null, deleted: false });
	assert.ok(fs.existsSync(join(skillsDir, "own/ref/a.md")));

	assert.equal((await remove(skillsDir, "own", answer(true))).deleted, true);
	assert.deepEqual(await remove(skillsDir, "s", answer(true)), {
		dir: join(skillsDir, "s"),
		url: "https://github.com/o/r/tree/main/s",
		deleted: true,
	});
	assert.deepEqual(asked.map((a) => a.url), [null, null, "https://github.com/o/r/tree/main/s"]);
	assert.deepEqual(fs.readdirSync(skillsDir), []);
});

test("remove refuses names outside the skills directory, non-skills, symlinks and missing skills without asking", async (t) => {
	const { skillsDir } = setup(t, {});
	const outside = fs.mkdtempSync(join(os.tmpdir(), "skill-outside-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.writeFileSync(join(outside, "SKILL.md"), SKILL("x"));
	fs.symlinkSync(outside, join(skillsDir, "linked"));
	fs.mkdirSync(join(skillsDir, "notes"));
	fs.writeFileSync(join(skillsDir, "notes/readme.md"), "x");
	let asked = 0;
	const confirm = async () => (asked++, true);

	for (const name of ["", "..", "../x", "a/b", ".hidden"])
		await assert.rejects(remove(skillsDir, name, confirm), /invalid skill name/);
	await assert.rejects(remove(skillsDir, "linked", confirm), /not a skill directory/);
	await assert.rejects(remove(skillsDir, "notes", confirm), /has no SKILL.md/);
	await assert.rejects(remove(skillsDir, "nope", confirm), /no skill nope/);
	assert.equal(asked, 0);
	assert.ok(fs.existsSync(join(outside, "SKILL.md")));
	assert.ok(fs.existsSync(join(skillsDir, "notes/readme.md")));
});

test("preview reads the text files behind a link without writing, skipping binaries and oversized files", async (t) => {
	const { skillsDir, deps } = setup(t, {
		"o/r": {
			HEAD: "main",
			refs: { main: { "s/SKILL.md": SKILL("Tools"), "s/ref/a.md": "see https://x", "s/img.bin": "a\0b", "s/big.md": "x".repeat(50) } },
		},
	});

	const p = await preview("https://github.com/o/r/tree/main/s", { maxFileBytes: 40, ...deps });

	assert.equal(p.name, "tools");
	assert.equal(p.src.path, "s");
	assert.deepEqual(p.files, ["SKILL.md", "big.md", "img.bin", "ref/a.md"]);
	assert.deepEqual(Object.keys(p.texts).sort(), ["SKILL.md", "ref/a.md"]);
	assert.deepEqual(fs.readdirSync(skillsDir), []);

	const capped = await preview("https://github.com/o/r/tree/main/s", { maxTotalBytes: 10, ...deps });
	assert.deepEqual(Object.keys(capped.texts), ["SKILL.md"]);
});

test("an upstream .skill-deps.sh is never installed, and update keeps and never removes the local one", async (t) => {
	const { skillsDir, state, deps } = setup(t, {
		"o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s"), [`s/${DEPS_FILE}`]: "rm -rf ~" } } },
	});
	const r = await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	assert.deepEqual(r.skipped, [DEPS_FILE]);
	assert.equal(fs.existsSync(join(skillsDir, "s", DEPS_FILE)), false);

	fs.writeFileSync(join(skillsDir, "s", DEPS_FILE), "mine");
	const main = state.repos["o/r"].refs.main;
	main["s/SKILL.md"] = SKILL("s", "v2");
	main[`s/${DEPS_FILE}`] = "changed upstream";
	assert.equal((await update(entry(skillsDir, "s"), deps)).status, "updated");
	delete main[`s/${DEPS_FILE}`];
	await update(entry(skillsDir, "s"), deps);

	assert.equal(fs.readFileSync(join(skillsDir, "s", DEPS_FILE), "utf8"), "mine");
	assert.equal(Object.hasOwn(readSource(join(skillsDir, "s")).files, DEPS_FILE), false);
});
