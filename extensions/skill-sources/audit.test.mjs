import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { auditData, listSkills, similarPairs, skillUsage } from "./audit.mjs";
import { SOURCE_FILE } from "./sources.mjs";

const SKILL = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nOne two three.\n`;

const readCall = (ts, path) => ({
	type: "message",
	timestamp: ts,
	message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path } }] },
});
const userText = (ts, text) => ({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });

function fixture(t) {
	const root = fs.mkdtempSync(join(os.tmpdir(), "skill-audit-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const skillsDir = join(root, "skills");
	const skill = (dir, name, description) => {
		fs.mkdirSync(join(skillsDir, dir, "ref"), { recursive: true });
		fs.writeFileSync(join(skillsDir, dir, "SKILL.md"), SKILL(name, description));
		fs.writeFileSync(join(skillsDir, dir, "ref/a.md"), "a");
	};
	skill("golang", "golang", "Go coding standards for services and tests.");
	skill("plan", "planner", "Plan a feature before building it.");
	skill("unused", "unused", "Go coding standards for services and libraries.");
	fs.mkdirSync(join(skillsDir, "no-skill"));
	const sessions = join(root, "sessions");
	const session = (rel, records) => {
		fs.mkdirSync(join(sessions, rel, ".."), { recursive: true });
		fs.writeFileSync(join(sessions, rel), records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n"));
	};
	return { root, skillsDir, sessions, session };
}

test("listSkills reads front matter and counts files, skipping directories without SKILL.md", (t) => {
	const { skillsDir } = fixture(t);

	const skills = listSkills(skillsDir);

	assert.deepEqual(
		skills.map((s) => [s.dir, s.name, s.files]),
		[
			["golang", "golang", 2],
			["plan", "planner", 2],
			["unused", "unused", 2],
		],
	);
});

test("listSkills returns nothing for a missing directory and falls back to the directory name", (t) => {
	const { root, skillsDir } = fixture(t);
	fs.mkdirSync(join(skillsDir, "bare"));
	fs.writeFileSync(join(skillsDir, "bare/SKILL.md"), "# no front matter");

	assert.deepEqual(listSkills(join(root, "missing")), []);
	const bare = listSkills(skillsDir).find((s) => s.dir === "bare");
	assert.deepEqual([bare.name, bare.description, bare.files], ["bare", "", 1]);
});

test("skillUsage counts sessions per skill from reads, skill:// and invocations, once per session", async (t) => {
	const { skillsDir, sessions, session } = fixture(t);
	session("p1/a.jsonl", [
		readCall("2026-10-20T10:00:00Z", "/Users/x/projects/my-pi/skills/golang/SKILL.md"),
		readCall("2026-10-21T10:00:00Z", "skill://golang/ref/a.md"),
		"not json SKILL.md",
		userText("2026-10-21T11:00:00Z", '<location>/Users/x/projects/my-pi/skills/unused/SKILL.md</location>'),
	]);
	session("p1/b/run-0/session.jsonl", [
		readCall("2026-05-01T10:00:00Z", "skill://planner"),
		readCall("2026-05-01T10:00:00Z", "/x/node_modules/pkg/skills/unused/SKILL.md"),
		readCall("2026-05-01T10:00:00Z", "/x/skills/other/SKILL.md"),
	]);
	session("p2/c.jsonl", [userText("2026-10-30T09:00:00Z", "/skill:golang explain")]);
	session("p2/d.jsonl", [userText("2026-10-30T09:00:00Z", '<skill name="planner" location="/x">body</skill>')]);
	session("p2/e.jsonl", [userText("2026-10-31T09:00:00Z", "body\n[Skill directory: /Users/x/my-pi/skills/plan]")]);
	fs.writeFileSync(join(sessions, "p2/notes.md"), JSON.stringify(readCall("2026-10-31T09:00:00Z", "skills/unused/SKILL.md")));
	session("p2/locked.jsonl", [readCall("2026-10-31T09:00:00Z", "skills/unused/SKILL.md")]);
	fs.chmodSync(join(sessions, "p2/locked.jsonl"), 0o000);

	const { usage, logs } = await skillUsage([sessions, join(sessions, "missing")], listSkills(skillsDir), new Date("2026-08-01"));

	assert.deepEqual([logs.files, logs.skipped], [5, 1]);
	assert.deepEqual(usage.get("golang"), { sessions: 2, recent: 2, lastUsed: new Date("2026-10-30T09:00:00Z") });
	assert.deepEqual(usage.get("plan"), { sessions: 3, recent: 2, lastUsed: new Date("2026-10-31T09:00:00Z") });
	assert.deepEqual(usage.get("unused"), { sessions: 0, recent: 0, lastUsed: null });
});

test("similarPairs reports description overlap at or above the threshold, highest first", () => {
	const skills = [
		{ dir: "a", description: "Go coding standards for services and tests." },
		{ dir: "b", description: "Go coding standards for services and libraries." },
		{ dir: "c", description: "Plan a feature before building it." },
		{ dir: "d", description: "" },
	];

	assert.deepEqual(similarPairs(skills, 0.5), [{ a: "a", b: "b", score: 0.6 }]);
	assert.deepEqual(similarPairs(skills, 0.9), []);
});

test("auditData combines usage, last change, source state and similar descriptions", async (t) => {
	const { skillsDir, sessions, session } = fixture(t);
	session("p/a.jsonl", [readCall("2026-10-20T10:00:00Z", "skills/golang/SKILL.md")]);
	fs.writeFileSync(
		join(skillsDir, "unused", SOURCE_FILE),
		JSON.stringify({ url: "https://github.com/o/r/tree/main/unused", owner: "o", repo: "r", ref: "main", path: "unused", kind: "dir", updates: true, files: {} }),
	);
	fs.writeFileSync(join(skillsDir, "plan", SOURCE_FILE), "{");
	const calls = [];

	const data = await auditData({
		skillsDir,
		sessionDirs: [sessions],
		windowDays: 30,
		now: () => new Date("2026-11-01T00:00:00Z"),
		lastChanged: async (dir) => (dir === "golang" ? "2026-10-03" : null),
		fetch: async (url) => (calls.push(url), new Response("", { status: 404 })),
	});

	assert.equal(data.generatedAt, "2026-11-01T00:00:00.000Z");
	assert.equal(data.sessionLogs.files, 1);
	const bySkill = Object.fromEntries(data.skills.map((s) => [s.skill, s]));
	assert.deepEqual(bySkill.golang.usage, { sessions: 1, last30Days: 1, lastUsed: "2026-10-20" });
	assert.equal(bySkill.golang.lastChanged, "2026-10-03");
	assert.equal(bySkill.golang.source, null);
	assert.equal(bySkill.golang.words, 15);
	assert.deepEqual(bySkill.unused.source, { url: "https://github.com/o/r/tree/main/unused", status: "gone", localEdits: [] });
	assert.match(bySkill.plan.source.status, /^error: .*unreadable/);
	assert.equal(calls.length, 1);
	assert.deepEqual(data.similarDescriptions.map((p) => [p.a, p.b]), [["golang", "unused"]]);
});

test("auditData reports a failed source check as an error and works without lastChanged", async (t) => {
	const { skillsDir, sessions } = fixture(t);
	const source = { url: "https://github.com/o/r/tree/main/unused", owner: "o", repo: "r", ref: "main", path: "unused", kind: "dir", updates: true, files: {} };
	fs.writeFileSync(join(skillsDir, "unused", SOURCE_FILE), JSON.stringify(source));

	const data = await auditData({ skillsDir, sessionDirs: [sessions], fetch: async () => new Response("", { status: 500 }) });

	const unused = data.skills.find((s) => s.skill === "unused");
	assert.deepEqual(unused.source, { url: source.url, status: "error: GitHub API /repos/o/r/git/trees/main:unused?recursive=1 answered 500" });
	assert.equal(unused.lastChanged, null);
	assert.deepEqual(unused.usage, { sessions: 0, last90Days: 0, lastUsed: null });
	assert.equal(data.sessionLogs.oldestFile, null);
});
