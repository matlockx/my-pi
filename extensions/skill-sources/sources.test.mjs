import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
	SOURCE_FILE,
	blobSha,
	describe,
	exclude,
	install,
	listInstalled,
	parseGitHubUrl,
	readSource,
	refCandidates,
	relink,
	update,
} from "./sources.mjs";

const SKILL = (name, body = "Body.") => `---\nname: ${name}\ndescription: Test skill.\n---\n\n${body}\n`;

/**
 * Fake GitHub serving the trees API and raw downloads from state.repos:
 * { "<owner>/<repo>": { HEAD: "<default ref>", refs: { "<ref>": { "<path>": text | { text, mode } } } } }.
 */
function fakeGitHub(state) {
	const calls = [];
	const text = (c) => (typeof c === "string" ? c : c.text);
	const resp = (status, body = "", headers = {}) => new Response(body, { status, headers });
	const refsOf = (repo, ref) => repo?.refs[ref === "HEAD" ? repo.HEAD : ref];
	const fetch = async (url) => {
		calls.push(url);
		const u = new URL(url);
		if (u.hostname === "api.github.com") {
			if (state.rateLimited) return resp(403, "", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" });
			const m = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/.exec(u.pathname);
			const spec = decodeURIComponent(m[3]);
			const i = spec.indexOf(":");
			const files = refsOf(state.repos[`${m[1]}/${m[2]}`], i < 0 ? spec : spec.slice(0, i));
			const prefix = i < 0 || !spec.slice(i + 1) ? "" : `${spec.slice(i + 1)}/`;
			if (!files) return resp(404);
			const below = Object.entries(files).filter(([p]) => p.startsWith(prefix));
			if (!below.length) return resp(404);
			const recursive = u.searchParams.has("recursive");
			const tree = [];
			const dirs = new Set();
			for (const [p, c] of below) {
				const rel = p.slice(prefix.length);
				if (!recursive && rel.includes("/")) {
					dirs.add(rel.split("/")[0]);
					continue;
				}
				tree.push({ path: rel, type: "blob", mode: c.mode ?? "100644", sha: blobSha(Buffer.from(text(c))) });
			}
			for (const d of dirs) tree.push({ path: d, type: "tree", mode: "040000", sha: "t" });
			return Response.json({ sha: "root", tree, truncated: false });
		}
		const [owner, repoName, ...rest] = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const repo = state.repos[`${owner}/${repoName}`];
		for (let i = 1; i < rest.length; i++) {
			const files = refsOf(repo, rest.slice(0, i).join("/"));
			const c = files?.[rest.slice(i).join("/")];
			if (c !== undefined) return resp(200, state.corrupt ? "tampered" : text(c));
		}
		return resp(404);
	};
	return { fetch, calls, apiCalls: () => calls.filter((c) => c.startsWith("https://api.github.com")).length };
}

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

test("a rate limit is an error, not a gone source", async (t) => {
	const { skillsDir, state, deps } = setup(t, { "o/r": { HEAD: "main", refs: { main: { "s/SKILL.md": SKILL("s") } } } });
	await install("https://github.com/o/r/tree/main/s", { skillsDir, ...deps });
	state.rateLimited = true;

	await assert.rejects(update(entry(skillsDir, "s"), deps), /rate limit reached/);
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
