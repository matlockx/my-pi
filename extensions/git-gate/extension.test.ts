/**
 * Wiring test for the tool_call handler: drives it against a mock ExtensionAPI and a
 * temporary repository directory.
 * Run: `node --experimental-strip-types --test extension.test.ts`
 *
 * The command parsing is covered by gate.test.mjs.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import extension from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Exec = { stdout: string; stderr: string; code: number; killed: boolean };

/** A repository directory, with a dev/check file where withCheck and a pre-commit hook of the given mode where hookMode. */
function repo(withCheck: boolean, hookMode?: number): string {
	const root = mkdtempSync(path.join(tmpdir(), "git-gate-"));
	if (withCheck) {
		mkdirSync(path.join(root, "dev"));
		writeFileSync(path.join(root, "dev", "check"), "#!/bin/sh\n", { mode: 0o755 });
	}
	if (hookMode !== undefined) {
		mkdirSync(path.join(root, "hooks"));
		writeFileSync(path.join(root, "hooks", "pre-commit"), "#!/bin/sh\n", { mode: hookMode });
	}
	return root;
}

/** Loads the extension; `git rev-parse` answers root (and root/hooks/pre-commit for --git-path), dev/check answers check. */
function setup(root: string, check: Exec | Error) {
	let handler: Handler | undefined;
	const ran: string[] = [];
	const pi = {
		on: (name: string, fn: Handler) => {
			if (name === "tool_call") handler = fn;
		},
		exec: async (cmd: string, args: string[]) => {
			ran.push([cmd, ...args].join(" "));
			if (cmd === "git" && args.includes("--git-path")) {
				return { stdout: `${path.join(root, "hooks", "pre-commit")}\n`, stderr: "", code: 0, killed: false };
			}
			if (cmd === "git") return { stdout: `${root}\n`, stderr: "", code: 0, killed: false };
			if (check instanceof Error) throw check;
			return check;
		},
	};
	extension(pi as never);
	const ctx = { cwd: root, hasUI: true, ui: { notify: () => {} } };
	const call = (command: string, toolName = "bash") => handler!({ toolName, input: { command } }, ctx);
	return { call, ran };
}

const ok: Exec = { stdout: "", stderr: "", code: 0, killed: false };

test("a passing dev/check lets the commit run", async () => {
	const root = repo(true);
	const { call, ran } = setup(root, ok);

	assert.equal(await call("git commit -m x"), undefined);
	assert.deepEqual(ran.at(-1), path.join(root, "dev", "check"));
});

test("a failing dev/check blocks the commit with its output", async () => {
	const root = repo(true);
	const { call } = setup(root, { stdout: "", stderr: "not gofmt-clean: a.go", code: 1, killed: false });

	const result = (await call("git commit -m x")) as { block: boolean; reason: string };
	assert.equal(result.block, true);
	assert.match(result.reason, /exited 1; the commit did not run/);
	assert.match(result.reason, /not gofmt-clean: a\.go/);
});

test("a dev/check that cannot start blocks the commit", async () => {
	const root = repo(true);
	const { call } = setup(root, new Error("EACCES"));

	const result = (await call("git commit -m x")) as { block: boolean; reason: string };
	assert.equal(result.block, true);
	assert.match(result.reason, /could not run \(EACCES\)/);
});

test("staging in the commit's own command is refused before the check runs", async () => {
	const root = repo(true);
	const { call, ran } = setup(root, ok);

	const result = (await call("git add a.go && git commit -m x")) as { block: boolean; reason: string };
	assert.equal(result.block, true);
	assert.match(result.reason, /separate commands/);
	assert.equal(ran.includes(path.join(root, "dev", "check")), false);
});

test("a repository without dev/check, other git commands and other tools pass untouched", async () => {
	const bare = setup(repo(false), ok);
	assert.equal(await bare.call("git add a.go && git commit -m x"), undefined);

	const root = repo(true);
	const { call, ran } = setup(root, { stdout: "", stderr: "", code: 1, killed: false });
	assert.equal(await call("git push origin main"), undefined);
	assert.equal(await call("git commit -m x", "read"), undefined);
	assert.deepEqual(ran, []);
});

test("a repository with an executable pre-commit hook of its own commits without the gate", async () => {
	const root = repo(true, 0o755);
	const { call, ran } = setup(root, { stdout: "", stderr: "", code: 1, killed: false });

	assert.equal(await call("git commit -m x"), undefined);
	assert.equal(await call("git add a.go && git commit -m x"), undefined);
	assert.equal(ran.includes(path.join(root, "dev", "check")), false);
});

test("a pre-commit hook that is not executable leaves the gate on", async () => {
	const root = repo(true, 0o644);
	const { call, ran } = setup(root, ok);

	assert.equal(await call("git commit -m x"), undefined);
	assert.deepEqual(ran.at(-1), path.join(root, "dev", "check"));
});
