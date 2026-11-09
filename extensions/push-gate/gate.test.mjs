import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	blockReason,
	commandDir,
	contentFingerprint,
	gatesRun,
	hasGatedSource,
	hasSonar,
	pushTarget,
	staleGates,
} from "./gate.mjs";
import { tempRepo } from "./test-repo.mjs";

test("pushTarget catches jflow pushes and git push, nothing else", () => {
	assert.deepEqual(pushTarget("jflow_pr", { path: "/repo/a" }), { dir: "/repo/a" });
	assert.deepEqual(pushTarget("jflow_review_resolve", {}), { dir: "" });
	assert.deepEqual(pushTarget("bash", { command: "git push origin HEAD" }), { dir: "" });
	assert.deepEqual(pushTarget("bash", { command: "git -C ../svc push -u origin x" }), { dir: "../svc" });
	assert.deepEqual(pushTarget("bash", { command: "cd /a && cd '/b c' && git push" }), { dir: "/b c" });

	assert.equal(pushTarget("jflow_commit", { path: "/repo/a" }), null);
	assert.equal(pushTarget("bash", { command: "git status && git log origin/main..HEAD" }), null);
	assert.equal(pushTarget("bash", { command: "git stash push" }), null);
});

test("commandDir ignores cd targets built from variables", () => {
	assert.equal(commandDir("cd $REPO && dryer"), "");
	assert.equal(commandDir("cd /a && cd $X && dryer"), "/a");
});

test("gatesRun recognises coverage and duplication runs, not help or complexity-only runs", () => {
	assert.deepEqual(gatesRun("crapper --threshold 10 a.go b.go"), ["coverage"]);
	assert.deepEqual(gatesRun("crapper --threshold 10 x.go && dryer --threshold 0.8"), ["coverage", "dryer"]);
	assert.deepEqual(gatesRun("go test -coverprofile=c.out ./..."), ["coverage"]);
	assert.deepEqual(gatesRun("uv run pytest --cov=app"), ["coverage"]);
	assert.deepEqual(gatesRun("npm run coverage"), ["coverage"]);

	assert.deepEqual(gatesRun("crapper --no-coverage a.go"), []);
	assert.deepEqual(gatesRun("crapper --help; dryer -h"), []);
	assert.deepEqual(gatesRun("go test ./internal/..."), []);
	assert.deepEqual(gatesRun("npm test"), []);
});

test("gatesRun does not count a mention, a lookup or a missing tool as a gate run", () => {
	assert.deepEqual(gatesRun("cd /repo && crapper --threshold 10 a.go"), ["coverage"]);
	assert.deepEqual(gatesRun("FOO=1 dryer --threshold 0.8"), ["dryer"]);

	assert.deepEqual(gatesRun("command -v crapper dryer"), []);
	assert.deepEqual(gatesRun("which dryer; echo 'run crapper later'"), []);
	assert.deepEqual(gatesRun("rg -n crapper agents/AGENTS.md"), []);
	assert.deepEqual(gatesRun("dryer --threshold 0.8", "bash: dryer: command not found"), []);
	assert.deepEqual(gatesRun("crapper --threshold 10 a.go", "fish: Unknown command: crapper"), []);
});

test("staleGates lists every gate whose run does not match the current content", () => {
	assert.deepEqual(staleGates({}, "t1"), ["coverage", "dryer"]);
	assert.deepEqual(staleGates({ coverage: "t1", dryer: "t0" }, "t1"), ["dryer"]);
	assert.deepEqual(staleGates({ coverage: "t1", dryer: "t1" }, "t1"), []);
});

test("hasGatedSource is false for repos without scored source", () => {
	assert.equal(hasGatedSource(["main.tf", "README.md", "deploy/values.yaml", "run.sh"]), false);
	assert.equal(hasGatedSource(["README.md", "internal/x/y.go"]), true);
	assert.equal(hasGatedSource(["extensions/a/gate.mjs"]), true);
});

test("blockReason names the stale gates and the rules file", () => {
	const crap = blockReason(["coverage"], false, "/x/quality-gates.md");
	assert.match(crap, /crapper --threshold 10/);
	assert.doesNotMatch(crap, /dryer/);
	assert.match(crap, /\/x\/quality-gates\.md/);
	assert.match(crap, /\/push-gate skip/);
	assert.match(blockReason(["coverage", "dryer"], true, "d"), /coverage tool \(Sonar.*dryer --threshold 0\.8/);
});

test("contentFingerprint survives a commit of the same content and changes on an edit", async (t) => {
	const { root, git } = tempRepo(t);
	writeFileSync(join(root, "main.go"), "package main\n\nfunc main() {}\n");
	writeFileSync(join(root, "new.go"), "package main\n");
	const beforeCommit = await contentFingerprint(root);

	git("add", "-A");
	git("commit", "-qm", "work");
	assert.equal(await contentFingerprint(root), beforeCommit, "committing the gated content keeps the gate current");

	writeFileSync(join(root, "main.go"), "package main\n\nfunc main() { panic(1) }\n");
	assert.notEqual(await contentFingerprint(root), beforeCommit, "an edit after the gate run makes it stale");
});

test("contentFingerprint ignores gate outputs and ignored files, and leaves the user's index alone", async (t) => {
	const { root, git } = tempRepo(t);
	writeFileSync(join(root, "staged.go"), "package main\n");
	git("add", "staged.go");
	const status = git("status", "--porcelain");
	const before = await contentFingerprint(root);

	mkdirSync(join(root, ".metrics"));
	writeFileSync(join(root, ".metrics", "crap.edn"), "{}");
	mkdirSync(join(root, "target", "coverage"), { recursive: true });
	writeFileSync(join(root, "target", "coverage", "lcov.info"), "x");
	mkdirSync(join(root, "ignored"));
	writeFileSync(join(root, "ignored", "a.go"), "package x\n");

	assert.equal(await contentFingerprint(root), before);
	assert.equal(
		git("status", "--porcelain").split("\n").filter((l) => !l.startsWith("??")).join("\n"),
		status.split("\n").filter((l) => !l.startsWith("??")).join("\n"),
		"staging area unchanged",
	);
});

test("hasSonar reads sonar-project.properties and workflow files", async (t) => {
	const { root } = tempRepo(t);
	assert.equal(await hasSonar(root), false);
	mkdirSync(join(root, ".github", "workflows"), { recursive: true });
	writeFileSync(join(root, ".github", "workflows", "ci.yml"), "steps:\n  - uses: actions/checkout@v4\n");
	assert.equal(await hasSonar(root), false);
	writeFileSync(join(root, ".github", "workflows", "q.yaml"), "  - uses: SonarSource/sonarqube-scan-action@v5\n");
	assert.equal(await hasSonar(root), true);
});
