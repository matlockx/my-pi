import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a git repo with one committed Go file, removed when the test ends.
 *
 * @param {import("node:test").TestContext} t The running test.
 * @returns {{root: string, git: (...args: string[]) => string}}
 */
export function tempRepo(t) {
	const root = mkdtempSync(join(tmpdir(), "push-gate-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	writeFileSync(join(root, "main.go"), "package main\n");
	writeFileSync(join(root, ".gitignore"), "ignored/\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	return { root, git };
}
