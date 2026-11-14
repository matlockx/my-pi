import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyDialog, applyPatch } from "./apply.mjs";
import { diffSince, orchestratorRegistry, orphanWorkspaces, patchStats, progressBreak, qaTriggers, roundPatches, snapshotTree, withDeadline, writeRoundPatch } from "./rounds.mjs";

test("orchestratorRegistry fills fields an older registry lacks and keeps existing ones", () => {
	const rounds = new Map([["b1", [{ round: 1 }]]]);
	const scope = { [Symbol.for("my-pi.orchestrator.registry")]: { rounds, budget: "off" } };
	const reg = orchestratorRegistry(scope);
	assert.equal(reg.rounds, rounds);
	assert.equal(reg.budget, "off");
	assert.deepEqual([...reg.owed], []);
	for (const f of ["qa", "budgets"]) assert.ok(reg[f] instanceof Map);
	assert.equal(orchestratorRegistry(scope), reg);
});

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function repo(files) {
	const dir = mkdtempSync(join(tmpdir(), "orch-repo-"));
	git(dir, "init", "-q");
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	git(dir, "add", ".");
	git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return dir;
}

const verified = { testsRun: [{ command: "go test ./...", passed: true }], lintRun: [{ command: "golangci-lint run", passed: true }] };

test("a round patch holds only the Builder's changes, not the user's uncommitted ones, and leaves the index alone", async () => {
	const dir = repo({ "a.txt": "one\n" });
	writeFileSync(join(dir, "a.txt"), "one\nuser edit\n");
	const baseline = await snapshotTree(dir);
	writeFileSync(join(dir, "a.txt"), "one\nuser edit\nbuilder edit\n");
	writeFileSync(join(dir, "new.txt"), "fresh\n");
	const patch = await diffSince(dir, baseline);
	assert.match(patch, /\+builder edit/);
	assert.match(patch, /new file mode[\s\S]*\+fresh/);
	assert.doesNotMatch(patch, /\+user edit/);
	assert.equal(git(dir, "status", "--porcelain"), " M a.txt\n?? new.txt\n");
});

test("apply_change applies the round patch to a checkout that has the user's edit, and refuses one that conflicts", async () => {
	const work = repo({ "a.txt": "one\n" });
	writeFileSync(join(work, "a.txt"), "one\nuser edit\n");
	const baseline = await snapshotTree(work);
	writeFileSync(join(work, "a.txt"), "one\nuser edit\nbuilder edit\n");
	const patch = await diffSince(work, baseline);
	const artifacts = mkdtempSync(join(tmpdir(), "orch-art-"));
	const { path } = writeRoundPatch(artifacts, "Builder", patch);

	const checkout = repo({ "a.txt": "one\n" });
	writeFileSync(join(checkout, "a.txt"), "one\nuser edit\n");
	assert.deepEqual(await applyPatch(checkout, path, patch), { ok: true });
	assert.equal(readFileSync(join(checkout, "a.txt"), "utf8"), "one\nuser edit\nbuilder edit\n");

	const moved = repo({ "a.txt": "something else\n" });
	const refused = await applyPatch(moved, path, patch);
	assert.equal(refused.ok, false);
	assert.match(refused.error, /does not apply.*kept at/s);
	assert.equal(readFileSync(join(moved, "a.txt"), "utf8"), "something else\n");
	assert.match((await applyPatch(moved, path, "")).error, /empty/);
});

test("round patches are numbered per Builder in order", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-art-"));
	assert.equal(writeRoundPatch(dir, "B.1", "x").round, 1);
	assert.equal(writeRoundPatch(dir, "B.1", "y").round, 2);
	writeRoundPatch(dir, "Other", "z");
	assert.deepEqual(roundPatches(dir, "B.1").map((r) => r.round), [1, 2]);
});

const diff = (path, body, header = "") => `diff --git a/${path} b/${path}\n${header}--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;

test("QA triggers: size, deleted test, weakened assertion, risky path, missing verification", () => {
	assert.deepEqual(qaTriggers(diff("cmd/main.go", "-a\n+b"), verified), []);
	const big = diff("cmd/main.go", Array.from({ length: 41 }, (_, i) => `+line ${i}`).join("\n"));
	assert.match(qaTriggers(big, verified)[0], /41 changed lines/);
	assert.match(qaTriggers(diff("pkg/a_test.go", "-x", "deleted file mode 100644\n"), verified)[0], /test file deleted: pkg\/a_test.go/);
	assert.match(qaTriggers(diff("pkg/a_test.go", "-\tassert.Equal(t, 1, got)\n+\t_ = got"), verified)[0], /assertions removed/);
	assert.match(qaTriggers(diff("db/migrations/002_add.sql", "+ALTER TABLE x"), verified)[0], /risky path/);
	assert.deepEqual(qaTriggers(diff("cmd/main.go", "+b"), { testsRun: [], lintRun: [] }), ["Builder ran no tests", "Builder ran no linter"]);
});

test("patchStats marks submodule pointer changes as nested", () => {
	assert.equal(patchStats(diff("vendor/lib", "-Subproject commit 1\n+Subproject commit 2")).nested, true);
	assert.equal(patchStats(diff("a.go", "+x")).nested, false);
});

test("progressBreak: identical patches, a repeated finding, the same failing test, a returning finding", () => {
	const qa = (findings, failing = []) => ({ verdict: "CONCERNS", findings, testsRun: failing.map((command) => ({ command, passed: false })) });
	const f = (file, text) => ({ severity: "MED", file, text });
	assert.match(progressBreak([{ hash: "a" }, { hash: "a" }], []), /changed nothing/);
	assert.equal(progressBreak([{ hash: "a" }, { hash: "b" }], [qa([f("a.go", "x")])]), undefined);
	assert.match(progressBreak([], [qa([f("a.go", "Nil check missing at line 12")]), qa([f("a.go", "nil check missing at line 14")])]), /same finding again/);
	assert.match(progressBreak([], [qa([], ["go test ./pkg"]), qa([], ["go test ./pkg"])]), /same test failed twice/);
	assert.match(progressBreak([], [qa([f("a.go", "x")]), qa([f("b.go", "y")]), qa([f("a.go", "x")])]), /fixed earlier came back/);
	assert.equal(progressBreak([], [qa([f("a.go", "x")]), qa([f("b.go", "y")])]), undefined);
});

test("orphanWorkspaces lists workspaces whose owner process is gone", () => {
	const root = mkdtempSync(join(tmpdir(), "orch-wt-"));
	for (const [name, pid] of [["live", 1], ["dead", 2]]) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, ".omp-isolation-owner.json"), JSON.stringify({ pid, id: name }));
	}
	mkdirSync(join(root, "foreign"));
	assert.deepEqual(orphanWorkspaces(root, (pid) => pid === 1).map((o) => o.pid), [2]);
	assert.deepEqual(orphanWorkspaces(join(root, "missing"), () => false), []);
});

test("applyDialog names the QA state and warns when applying overrides required QA", () => {
	const patch = diff("a.go", "-a\n+b");
	assert.match(applyDialog({ builder: "B", round: 2, patch, qa: undefined, qaRequired: false }).title, /round 2.*no QA \(not required\).*a\.go \(\+1 -1\)/);
	assert.match(applyDialog({ builder: "B", round: 1, patch, qa: undefined, qaRequired: true }).title, /QA required but not run\. Applying overrides QA/);
	assert.match(applyDialog({ builder: "B", round: 1, patch, qa: { verdict: "PASS", findings: [] }, qaRequired: true }).title, /QA PASS\./);
});

test("withDeadline passes a fast result through and rejects a slow one at the deadline", async () => {
	assert.equal(await withDeadline(Promise.resolve("patch"), 50, "late"), "patch");
	const started = Date.now();
	await assert.rejects(withDeadline(new Promise(() => {}), 30, "round patch took over 0.03 s"), /round patch took over/);
	assert.ok(Date.now() - started < 1_000, "does not wait for the hung work");
	await assert.rejects(withDeadline(Promise.reject(new Error("git failed")), 50, "late"), /git failed/);
});
