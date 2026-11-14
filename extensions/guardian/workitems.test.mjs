import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectWorkItems, gitOutput, knownPrefixes, lastTracked, learnPrefixes, parseTrackId, prefixesToLearn, readState, repoOfRemote } from "./workitems.mjs";

const ids = (items) => items.map((i) => [i.id, i.source, i.primary]);

test("precedence: explicit, then branch, then PR round, then prompt; every id kept, one primary", () => {
	const items = collectWorkItems({
		explicit: { id: "OPS-7", kind: "jira" },
		branch: "feature/ABC-12-retry",
		prompt: "jflow watcher, round 1/10: PR #42 (https://github.com/acme/api/pull/42) has 2 threads. See ABC-9 too.",
		repo: "acme/api",
		known: new Set(["ABC"]),
	});
	assert.deepEqual(ids(items), [
		["OPS-7", "explicit", true],
		["ABC-12", "branch", false],
		["acme/api#42", "pr-round", false],
		["ABC-9", "prompt", false],
	]);
});

test("the branch key is primary without an explicit id", () => {
	const items = collectWorkItems({ branch: "ABC-12-fix", prompt: "fix it", known: new Set() });
	assert.deepEqual(ids(items), [["ABC-12", "branch", true]]);
});

test("UTF-8, SHA-256 and CVE ids are never Jira keys, even with a known prefix list", () => {
	const items = collectWorkItems({ prompt: "Use UTF-8 and SHA-256, see CVE-2024-1 and ISO-8601", known: new Set(["UTF", "SHA"]) });
	assert.deepEqual(items, []);
});

test("a prompt key with an unknown prefix is ignored until its prefix is known", () => {
	assert.deepEqual(collectWorkItems({ prompt: "like in ABC-12", known: new Set() }), []);
	assert.deepEqual(ids(collectWorkItems({ prompt: "like in ABC-12", known: new Set(["ABC"]) })), [["ABC-12", "prompt", true]]);
});

test("lowercase branch keys count only with a known prefix (dependabot branches stay empty)", () => {
	assert.deepEqual(collectWorkItems({ branch: "dependabot/github_actions/actions/checkout-7.0.1", known: new Set() }), []);
	assert.deepEqual(ids(collectWorkItems({ branch: "abc-12-retry", known: new Set(["ABC"]) })), [["ABC-12", "branch", true]]);
});

test("GitHub references: issue and PR URLs, owner/repo#N, issue:// and pr:// with the origin repo", () => {
	const items = collectWorkItems({
		prompt: "https://github.com/acme/api/issues/3 and https://github.com/acme/web/pull/8, acme/cli#4, issue://5, pr://acme/api/6",
		repo: "acme/api",
		known: new Set(),
	});
	assert.deepEqual(
		items.map((i) => [i.id, i.kind]),
		[["acme/api#3", "github-issue"], ["acme/web#8", "github-pr"], ["acme/cli#4", "github-issue"], ["acme/api#5", "github-issue"], ["acme/api#6", "github-pr"]],
	);
});

test("issue:// without a known repo keeps the raw reference", () => {
	assert.deepEqual(ids(collectWorkItems({ prompt: "see issue://5", known: new Set() })), [["issue://5", "prompt", true]]);
});

test("PR URLs count as pr-round only in a jflow watcher prompt", () => {
	const items = collectWorkItems({ prompt: "please look at https://github.com/acme/api/pull/42", known: new Set() });
	assert.deepEqual(ids(items), [["acme/api#42", "prompt", true]]);
});

test("parseTrackId accepts Jira keys in any case and GitHub references, nothing else", () => {
	assert.deepEqual(parseTrackId("abc-12"), { id: "ABC-12", kind: "jira" });
	assert.deepEqual(parseTrackId("https://github.com/acme/api/pull/9"), { id: "acme/api#9", kind: "github-pr" });
	assert.deepEqual(parseTrackId("pr://9", "acme/api"), { id: "acme/api#9", kind: "github-pr" });
	assert.equal(parseTrackId("not an id"), undefined);
});

test("repoOfRemote reads https and ssh GitHub remotes", () => {
	assert.equal(repoOfRemote("git@github.com:acme/api.git\n"), "acme/api");
	assert.equal(repoOfRemote("https://github.com/acme/api"), "acme/api");
	assert.equal(repoOfRemote("https://gitlab.com/acme/api.git"), undefined);
	assert.equal(repoOfRemote(undefined), undefined);
});

test("prefixes are learned from branch and explicit keys only and persisted without duplicates", () => {
	const path = join(mkdtempSync(join(tmpdir(), "guardian-")), "guardian-state.json");
	writeFileSync(path, JSON.stringify({ jiraProjects: ["OPS"] }));
	const items = collectWorkItems({ branch: "ABC-1", prompt: "OPS-2 and DEF-3", known: knownPrefixes(readState(path)) });
	assert.deepEqual(prefixesToLearn(items), ["ABC"]);
	assert.equal(learnPrefixes(path, ["ABC", "OPS"]), true);
	assert.equal(learnPrefixes(path, ["ABC"]), false);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { jiraProjects: ["OPS"], learnedJiraProjects: ["ABC"] });
	assert.deepEqual([...knownPrefixes(readState(path))].sort(), ["ABC", "OPS"]);
});

test("a missing or broken state file reads as empty", () => {
	const dir = mkdtempSync(join(tmpdir(), "guardian-"));
	assert.deepEqual(readState(join(dir, "missing.json")), {});
	writeFileSync(join(dir, "broken.json"), "{");
	assert.deepEqual(readState(join(dir, "broken.json")), {});
});

test("lastTracked takes the latest /track entry; /track off clears it", () => {
	const track = (item) => ({ type: "custom", customType: "guardian-track", data: { item } });
	const item = { id: "ABC-1", kind: "jira" };
	assert.deepEqual(lastTracked([track({ id: "OLD-1", kind: "jira" }), track(item), { type: "message" }], "guardian-track"), item);
	assert.equal(lastTracked([track(item), track(null)], "guardian-track"), undefined);
	assert.equal(lastTracked([track({ id: 3 })], "guardian-track"), undefined);
	assert.equal(lastTracked([], "guardian-track"), undefined);
});

test("gitOutput: trimmed stdout, undefined outside a repository or for empty output", async () => {
	const dir = mkdtempSync(join(tmpdir(), "guardian-git-"));
	assert.equal(await gitOutput(dir, ["branch", "--show-current"]), undefined, "not a repository");
	execFileSync("git", ["-C", dir, "init", "--quiet", "--initial-branch", "ABC-7-retry"]);
	assert.equal(await gitOutput(dir, ["branch", "--show-current"]), "ABC-7-retry");
	assert.equal(await gitOutput(dir, ["remote"]), undefined, "empty output");
});
