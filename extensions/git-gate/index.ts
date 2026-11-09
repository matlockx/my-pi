/**
 * Git Gate Extension
 *
 * DEV-NOTE: runs the repository's own pre-commit check before an agent's `git commit`
 * (owner decision 2026-11-09, after a commit split between two issues reached CI
 * unformatted). A repository opts in with an executable `dev/check` at its top level:
 * it checks the staged tree, exit 0 lets the commit run, any other status blocks it
 * and hands the output to the agent. A repository without `dev/check` commits as before.
 * The user's approval of a commit stays the chat's "commit"; this gate asks nothing.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { blockReason, checkDirs, isCommit, stagingProblem } from "./gate.mjs";

/** How long one dev/check may run before the commit is blocked as timed out. */
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

export default function (pi: ExtensionAPI) {
	/** The top-level directory of the working tree dir is in; "" outside one. */
	async function repoRoot(dir: string): Promise<string> {
		try {
			const out = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
			return out.code === 0 ? out.stdout.trim() : "";
		} catch {
			return "";
		}
	}

	/** Reports whether root has a dev/check file. */
	async function hasCheck(root: string): Promise<boolean> {
		try {
			return (await stat(path.join(root, "dev", "check"))).isFile();
		} catch {
			return false;
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const input = event.input as { command?: unknown; cwd?: unknown };
		const command = typeof input.command === "string" ? input.command : "";
		if (!isCommit(command)) return undefined;

		const base = typeof input.cwd === "string" ? path.resolve(ctx.cwd, input.cwd) : ctx.cwd;
		const roots = new Set<string>();
		for (const dir of checkDirs(command, base, homedir())) {
			const root = await repoRoot(dir);
			if (root && (await hasCheck(root))) roots.add(root);
		}
		if (roots.size === 0) return undefined;

		const problem = stagingProblem(command);
		if (problem) return { block: true, reason: problem };

		for (const root of roots) {
			if (ctx.hasUI) ctx.ui.notify(`git-gate: running ${path.join(root, "dev", "check")}`, "info");

			const script = path.join(root, "dev", "check");
			try {
				const result = await pi.exec(script, [], { cwd: root, timeout: CHECK_TIMEOUT_MS });
				if (result.code !== 0) return { block: true, reason: blockReason(root, result) };
			} catch (err) {
				return {
					block: true,
					reason: `git-gate: ${script} could not run (${err instanceof Error ? err.message : String(err)}); the commit did not run.`,
				};
			}
		}
		return undefined;
	});
}
