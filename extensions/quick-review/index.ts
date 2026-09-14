/**
 * Auto Quick-Review Extension
 *
 * DEV-NOTE: Runs the /quick-review prompt automatically when the agent loop ends
 * with uncommitted changes in the working tree — the point at which the agent
 * would normally propose a commit message. An extension enforces this where an
 * AGENTS.md instruction can be skipped.
 *
 * The prompt body is read from prompts/quick-review.md, so the manual command and
 * the automatic trigger share one source of truth.
 *
 * Opt out for the current session with /quick-review-auto off.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { promptBody, shouldAutoReview } from "./gate.mjs";

const PROMPT_PATH = fileURLToPath(
	new URL("../../prompts/quick-review.md", import.meta.url),
);

export default function (pi: ExtensionAPI) {
	const reviewed = new Set<string>();
	let count = 0;
	let disabled = false;
	let running = false;

	/** Fingerprints the uncommitted changes; returns "" for a clean tree or a non-git directory. */
	async function diffFingerprint(cwd: string): Promise<string> {
		const status = await pi.exec("git", ["status", "--porcelain"], { cwd });
		if (status.code !== 0 || !status.stdout.trim()) return "";

		const diff = await pi.exec("git", ["diff", "HEAD"], { cwd });
		return createHash("sha1")
			.update(status.stdout)
			.update(diff.stdout ?? "")
			.digest("hex");
	}

	async function runReview(ctx: ExtensionContext, hash: string) {
		const body = promptBody(await readFile(PROMPT_PATH, "utf8"));
		reviewed.add(hash);
		count += 1;
		if (ctx.hasUI)
			ctx.ui.notify("Auto quick-review of uncommitted changes", "info");
		pi.sendUserMessage(body);
	}

	pi.on("agent_end", async (_event, ctx) => {
		// DEV-NOTE: sendUserMessage starts another agent loop, which ends in this same
		// handler. `running` drops that echo; the fingerprint set and the budget in
		// gate.mjs stop a review/fix ping-pong from looping indefinitely.
		if (running) {
			running = false;
			return;
		}

		const hash = await diffFingerprint(ctx.cwd);
		const { review } = shouldAutoReview({ hash, reviewed, count, disabled });
		if (!review) return;

		running = true;
		await runReview(ctx, hash);
	});

	pi.registerCommand("quick-review-auto", {
		description: "Toggle the automatic quick review at the end of an agent turn",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") disabled = false;
			else if (arg === "off") disabled = true;
			else disabled = !disabled;

			if (ctx.hasUI) {
				ctx.ui.notify(
					`Auto quick-review ${disabled ? "disabled" : "enabled"} for this session`,
					"info",
				);
			}
		},
	});
}
