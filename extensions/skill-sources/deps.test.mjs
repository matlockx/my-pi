import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { OUTPUT_LIMIT, runDepsScript, sandboxBlocked, writeDepsScript } from "./deps.mjs";
import { DEPS_FILE } from "./sources.mjs";

function tmp(t) {
	const dir = fs.mkdtempSync(join(os.tmpdir(), "skill-deps-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("writeDepsScript adds a strict bash preamble when the script has no shebang and makes it executable", (t) => {
	const dir = tmp(t);

	const file = writeDepsScript(dir, "echo hi");

	assert.equal(file, join(dir, DEPS_FILE));
	assert.equal(fs.readFileSync(file, "utf8"), "#!/usr/bin/env bash\nset -euo pipefail\necho hi\n");
	assert.equal(fs.statSync(file).mode & 0o777, 0o755);
	writeDepsScript(dir, "#!/bin/sh\necho own\n");
	assert.equal(fs.readFileSync(file, "utf8"), "#!/bin/sh\necho own\n");
});

test("runDepsScript runs in the skill directory and reports exit code and combined output", async (t) => {
	const dir = tmp(t);
	const ok = await runDepsScript(writeDepsScript(dir, 'pwd; echo err >&2'));
	assert.equal(ok.code, 0);
	assert.equal(ok.timedOut, false);
	assert.match(ok.output, new RegExp(`${fs.realpathSync(dir)}\\n`));
	assert.match(ok.output, /err/);

	const failed = await runDepsScript(writeDepsScript(dir, "echo before; false; echo after"));
	assert.equal(failed.code, 1);
	assert.match(failed.output, /before/);
	assert.doesNotMatch(failed.output, /after/);
});

test("runDepsScript stops a script at the timeout and keeps only the end of long output", async (t) => {
	const dir = tmp(t);

	const slow = await runDepsScript(writeDepsScript(dir, "echo start; sleep 5"), { timeoutMs: 200 });
	assert.equal(slow.timedOut, true);
	assert.match(slow.output, /start/);

	const long = await runDepsScript(writeDepsScript(dir, `head -c ${OUTPUT_LIMIT * 2} /dev/zero | tr '\\0' a; echo END`));
	assert.equal(long.output.length, OUTPUT_LIMIT);
	assert.match(long.output, /END\n$/);
});

test("sandboxBlocked recognises permission and sandbox failures only", () => {
	assert.equal(sandboxBlocked("ln: /Users/m/bin/crapper: Operation not permitted"), true);
	assert.equal(sandboxBlocked("mkdir: /opt/x: Read-only file system"), true);
	assert.equal(sandboxBlocked("fatal: repository not found"), false);
	assert.equal(sandboxBlocked("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote"), false);
	assert.equal(sandboxBlocked("git@github.com: Permission denied (publickey).\nln: ~/bin/x: Permission denied"), true);
});
