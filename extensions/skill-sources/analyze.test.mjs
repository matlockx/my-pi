import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { analyze, dependencyFacts, findCommands, findLinks, findSkillRefs, onPath } from "./analyze.mjs";
import { DEPS_FILE, SOURCE_FILE } from "./sources.mjs";

const UB = [
	"---\nname: ub-mode\ndescription: x\n---",
	"## Crapper\n* Use the crapper tool\n## Dryer\n* Use the dryer tool to eliminate duplication.",
	"Paired with [Mutator](https://github.com/unclebob/mutator) and https://github.com/unclebob/dryer.git.",
	"See https://github.com/orgs/acme and (https://example.com/doc).",
	"```bash\n$ ./mutator --scan src\nsudo apt install foo\n# comment\nFOO=1 make\ncd x\n```",
	"```clojure\n(defn crap [] 1)\n```",
	"Also run the `uml` command. Combine with the review skill and `ponytail` skill, /skill:plan and skill://golang/ref.md.",
].join("\n\n");

function tmp(t) {
	const root = fs.mkdtempSync(join(os.tmpdir(), "skill-analyze-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

test("findLinks returns distinct links with their GitHub repository", () => {
	assert.deepEqual(findLinks({ "SKILL.md": UB, "b.md": "again https://github.com/unclebob/mutator" }), [
		{ url: "https://github.com/unclebob/mutator", file: "SKILL.md", github: { owner: "unclebob", repo: "mutator" } },
		{ url: "https://github.com/unclebob/dryer.git", file: "SKILL.md", github: { owner: "unclebob", repo: "dryer" } },
		{ url: "https://github.com/orgs/acme", file: "SKILL.md", github: null },
		{ url: "https://example.com/doc", file: "SKILL.md", github: null },
	]);
});

test("findCommands reads shell blocks and tool phrases, ignoring builtins, assignments, comments and other languages", () => {
	assert.deepEqual(findCommands({ "SKILL.md": UB }), ["apt", "crapper", "dryer", "mutator", "uml"]);
	assert.deepEqual(findCommands({ "a.md": "```json\n{\"a\": 1}\n```\nno tools here" }), []);
});

test("findSkillRefs finds skill references in every supported form", () => {
	assert.deepEqual(findSkillRefs({ "SKILL.md": UB }), ["golang", "plan", "ponytail", "review"]);
});

test("onPath finds executable files only", (t) => {
	const root = tmp(t);
	const a = join(root, "a");
	const b = join(root, "b");
	fs.mkdirSync(a);
	fs.mkdirSync(b);
	fs.writeFileSync(join(a, "tool"), "x");
	fs.writeFileSync(join(b, "tool"), "#!/bin/sh\n", { mode: 0o755 });
	fs.mkdirSync(join(a, "dirtool"));

	assert.equal(onPath("tool", [a, b].join(":")), join(b, "tool"));
	assert.equal(onPath("dirtool", a), null);
	assert.equal(onPath("tool", ""), null);
});

test("dependencyFacts marks present commands and installed skills and leaves out the skill itself", (t) => {
	const root = tmp(t);
	const bin = join(root, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(join(bin, "dryer"), "", { mode: 0o755 });
	fs.mkdirSync(join(root, "skills/plan"), { recursive: true });
	fs.writeFileSync(join(root, "skills/plan/SKILL.md"), "x");

	const f = dependencyFacts({ "SKILL.md": `${UB}\nthe ub-mode skill` }, { skillsDir: join(root, "skills"), self: "ub-mode", pathEnv: bin });

	assert.deepEqual(
		f.commands.filter((c) => ["crapper", "dryer"].includes(c.name)),
		[
			{ name: "crapper", path: null },
			{ name: "dryer", path: join(bin, "dryer") },
		],
	);
	assert.deepEqual(f.skills, [
		{ name: "golang", installed: false },
		{ name: "plan", installed: true },
		{ name: "ponytail", installed: false },
		{ name: "review", installed: false },
	]);
});

test("analyze of an own skill reads the local files, excluding the records, and returns the deps script", async (t) => {
	const skillsDir = join(tmp(t), "skills");
	fs.mkdirSync(join(skillsDir, "ub-mode/ref"), { recursive: true });
	fs.writeFileSync(join(skillsDir, "ub-mode/SKILL.md"), UB);
	fs.writeFileSync(join(skillsDir, "ub-mode/ref/x.md"), "Use the zzz tool.");
	fs.writeFileSync(join(skillsDir, "ub-mode", DEPS_FILE), "echo run crapper-install tool");
	let calls = 0;

	const a = await analyze("ub-mode", { skillsDir, pathEnv: "", fetch: async () => (calls++, new Response("", { status: 500 })) });

	assert.equal(calls, 0);
	assert.equal(a.origin, "local");
	assert.equal(a.installed, true);
	assert.deepEqual(a.files, ["SKILL.md", "ref/x.md"]);
	assert.equal(a.depsScript, "echo run crapper-install tool");
	assert.ok(a.facts.commands.some((c) => c.name === "zzz"));
	assert.ok(!a.facts.commands.some((c) => c.name === "crapper-install"));
});

test("analyze of a link-installed skill whose link is gone falls back to the local copy and says so", async (t) => {
	const skillsDir = join(tmp(t), "skills");
	fs.mkdirSync(join(skillsDir, "ub-mode"), { recursive: true });
	fs.writeFileSync(join(skillsDir, "ub-mode/SKILL.md"), UB);
	const source = { url: "https://github.com/o/r", owner: "o", repo: "r", ref: null, path: "", kind: "dir", updates: true, files: {} };
	fs.writeFileSync(join(skillsDir, "ub-mode", SOURCE_FILE), JSON.stringify(source));

	const a = await analyze("ub-mode", { skillsDir, pathEnv: "", fetch: async () => new Response("", { status: 404 }) });

	assert.equal(a.origin, "local");
	assert.equal(a.url, "https://github.com/o/r");
	assert.match(a.note, /link not readable .*nothing found/);
	assert.deepEqual(a.files, ["SKILL.md"]);
});

test("analyze refuses names that are not skills", async (t) => {
	const skillsDir = join(tmp(t), "skills");
	fs.mkdirSync(skillsDir);

	await assert.rejects(analyze("../x", { skillsDir, pathEnv: "" }), /invalid skill name/);
	await assert.rejects(analyze("nope", { skillsDir, pathEnv: "" }), /no skill nope/);
});
