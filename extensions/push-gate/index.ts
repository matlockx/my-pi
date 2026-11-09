/**
 * Push Gate Extension
 *
 * Blocks a push (`jflow_pr`, `jflow_review_resolve`, `git push` in bash) until the
 * coverage gate and the duplication gate (AGENTS.md G-15, G-18) have run on exactly the
 * content being pushed. The rules themselves live in agents/quality-gates.md; the block
 * message points the agent there, so they need not sit in AGENTS.md on every turn.
 *
 * A gate counts as run when a bash command matching it finished in that repository; the
 * tree fingerprint taken then must equal the one at push time. `/push-gate skip` lets the
 * next push of the session's repository through once.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	blockReason,
	commandDir,
	contentFingerprint,
	gatesRun,
	hasGatedSource,
	hasSonar,
	pushTarget,
	repoRoot,
	staleGates,
	trackedFiles,
} from "./gate.mjs";

const DOC_PATH = fileURLToPath(new URL("../../agents/quality-gates.md", import.meta.url));

export default function (pi: ExtensionAPI) {
	/** Tree fingerprint at each gate's last run, per repository root. */
	const ran = new Map<string, { coverage?: string; dryer?: string }>();
	/** Roots whose next push the user waived with /push-gate skip. */
	const skipped = new Set<string>();

	const absolute = (ctx: ExtensionContext, dir: string) =>
		resolve(ctx.cwd, dir.replace(/^~(?=\/|$)/, homedir()));

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String(event.input.command ?? "");
		const output = event.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		const gates = gatesRun(command, output);
		if (gates.length === 0) return undefined;

		const root = await repoRoot(absolute(ctx, commandDir(command)));
		if (!root) return undefined;
		// DEV-NOTE: recorded whatever the exit code: crapper exits 2 over the threshold, and
		// the gate rules say to read the report and fix findings, which the push then reruns.
		const fingerprint = await contentFingerprint(root);
		const entry = ran.get(root) ?? {};
		for (const gate of gates) entry[gate] = fingerprint;
		ran.set(root, entry);
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const target = pushTarget(event.toolName, event.input);
		if (!target) return undefined;

		const root = await repoRoot(absolute(ctx, target.dir));
		if (!root) return undefined;
		if (skipped.delete(root)) return undefined;
		if (!hasGatedSource(await trackedFiles(root))) return undefined;

		const stale = staleGates(ran.get(root) ?? {}, await contentFingerprint(root));
		if (stale.length === 0) return undefined;
		return { block: true, reason: blockReason(stale, await hasSonar(root), DOC_PATH) };
	});

	pi.registerCommand("push-gate", {
		description: "Quality gates before a push: skip (let the next push through once) | status",
		handler: async (args, ctx) => {
			const root = await repoRoot(ctx.cwd);
			if (!root) {
				if (ctx.hasUI) ctx.ui.notify("push-gate: not inside a git repository", "warning");
				return;
			}
			if (args.trim().toLowerCase() === "skip") {
				skipped.add(root);
				if (ctx.hasUI) ctx.ui.notify(`push-gate: next push of ${root} allowed without gates`, "info");
				return;
			}
			const stale = staleGates(ran.get(root) ?? {}, await contentFingerprint(root));
			if (ctx.hasUI) {
				ctx.ui.notify(
					stale.length === 0
						? `push-gate: gates current for ${root}`
						: `push-gate: ${stale.join(", ")} not run on the current content of ${root}`,
					"info",
				);
			}
		},
	});
}
