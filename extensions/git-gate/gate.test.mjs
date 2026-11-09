import test from "node:test";
import assert from "node:assert/strict";

import {
	blockReason,
	checkDirs,
	isCommit,
	OUTPUT_TAIL_LINES,
	stagingProblem,
	withoutHeredocs,
} from "./gate.mjs";

test("a heredoc body is data: git commands inside it neither trigger nor refuse", () => {
	const message = "git commit -q -F - <<'EOF'\nfix: run git add before git commit -a\nEOF";
	assert.equal(isCommit(message), true);
	assert.equal(stagingProblem(message), "");

	const script = "python3 - <<\"PY\"\nprint('git commit -m x')\nPY\necho done";
	assert.equal(isCommit(script), false);
	assert.equal(withoutHeredocs(script), "python3 - \necho done");

	// Commands after the delimiter line still count.
	const after = "cat <<-END\n\tnotes\n\tEND\ngit add a.go && git commit -m x";
	assert.match(stagingProblem(after), /separate commands/);
});

test("isCommit finds git commit, with -C and inside a chain, and nothing else", () => {
	for (const command of [
		"git commit -m x",
		"git -C ../repo commit -F -",
		"go test ./... && git commit -q -F - <<'EOF'\nmsg\nEOF",
		"cd /tmp/x; git commit --amend --no-edit",
	]) {
		assert.equal(isCommit(command), true, command);
	}
	for (const command of [
		"git status --porcelain",
		"git commit-tree abc -m x",
		"git log --grep commit",
		"echo committed",
		"",
	]) {
		assert.equal(isCommit(command), false, command);
	}
});

test("stagingProblem refuses staging in the same command and commit -a, not other flags", () => {
	for (const command of [
		"git add a.go && git commit -m x",
		"git -C repo add -A; git -C repo commit -m x",
		"git rm old.go && git commit -m x",
		"git mv a.go b.go && git commit -m x",
		"git commit -am x",
		"git commit -a -m x",
		"git commit --all -m x",
	]) {
		assert.match(stagingProblem(command), /stage and commit in separate commands/, command);
	}
	for (const command of [
		"git commit -m x",
		"git commit --amend --no-edit",
		"git commit -q -F - <<'EOF'\nfix: a -a b\nEOF",
		"git stash pop && git commit -m x",
	]) {
		assert.equal(stagingProblem(command), "", command);
	}
});

test("checkDirs resolves cd and -C against the start directory and home, else the start", () => {
	assert.deepEqual(checkDirs("git commit -m x", "/w/repo", "/h"), ["/w/repo"]);
	assert.deepEqual(checkDirs("cd ../other && git commit -m x", "/w/repo", "/h"), ["/w/other"]);
	assert.deepEqual(checkDirs("git -C ~/p/my-pi commit -m x", "/w", "/h"), ["/h/p/my-pi"]);
	assert.deepEqual(checkDirs("cd ~ && git commit -m x", "/w", "/h"), ["/h"]);
	assert.deepEqual(checkDirs("cd /a && git -C /a commit -m x", "/w", "/h"), ["/a"]);
});

test("blockReason names the script and status and keeps only the output's tail", () => {
	const lines = Array.from({ length: OUTPUT_TAIL_LINES + 5 }, (_, i) => `line ${i}`);
	const reason = blockReason("/w/repo", { code: 1, stdout: lines.join("\n"), stderr: "unformatted: a.go" });

	assert.match(reason, /\/w\/repo\/dev\/check exited 1; the commit did not run/);
	assert.match(reason, /unformatted: a\.go$/);
	assert.doesNotMatch(reason, /line 5\n/);
	assert.match(reason, /line 6\n/);

	assert.match(blockReason("/w/repo", { code: 143, killed: true }), /was stopped \(timeout\)/);
});
