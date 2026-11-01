/**
 * The dependency install script of a skill: DEPS_FILE next to SKILL.md,
 * written by the agent after analysing the skill and run only after the user
 * agrees. The file is local to my-pi; skill updates never replace or delete it.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { DEPS_FILE } from "./sources.mjs";

export const OUTPUT_LIMIT = 8_000;
const PREAMBLE = "#!/usr/bin/env bash\nset -euo pipefail\n";

/**
 * Writes script to dir/DEPS_FILE, executable. A script without a shebang gets
 * a bash shebang and `set -euo pipefail`. Returns the file path.
 */
export function writeDepsScript(dir, script) {
	const text = script.startsWith("#!") ? script : `${PREAMBLE}${script}`;
	const file = join(dir, DEPS_FILE);
	fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
	fs.chmodSync(file, 0o755);
	return file;
}

/**
 * Runs file with bash in its own directory. Resolves { code, signal,
 * timedOut, output }, output being the combined stdout and stderr, cut to the
 * last OUTPUT_LIMIT characters.
 */
export function runDepsScript(file, { timeoutMs = 600_000, signal } = {}) {
	return new Promise((done) => {
		const child = spawn("bash", [file], { cwd: dirname(file), signal, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let timedOut = false;
		const append = (chunk) => {
			output = (output + chunk).slice(-OUTPUT_LIMIT);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);
		const finish = (code, sig) => {
			clearTimeout(timer);
			done({ code, signal: sig, timedOut, output });
		};
		child.on("error", (err) => {
			append(`\n${err.message}\n`);
			finish(null, null);
		});
		child.on("close", finish);
	});
}

/**
 * Reports whether output shows the run was stopped by a sandbox or file
 * permissions rather than by the script itself. SSH authentication failures
 * ("Permission denied (publickey)") do not count.
 */
export function sandboxBlocked(output) {
	const text = String(output).replace(/Permission denied \((?:publickey|password|keyboard-interactive)[^)]*\)/gi, "");
	return /Operation not permitted|Read-only file system|Permission denied|sandbox|EPERM|EACCES/i.test(text);
}
