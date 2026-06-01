/**
 * Git Gate Extension
 *
 * AIDEV-NOTE: Hard gate on git commit/push/tag commands.
 * Intercepts bash tool calls and requires explicit user confirmation
 * before executing any git mutation (commit, push, tag operations).
 * This is a safety net on top of AGENTS.md soft instructions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// AIDEV-NOTE: Patterns cover common git mutation commands.
	// Read-only git commands (status, log, diff, branch --list, etc.) are NOT blocked.
	const gitMutationPatterns = [
		/\bgit\s+commit\b/i,
		/\bgit\s+push\b/i,
		/\bgit\s+tag\b/i,
	];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const matchedPattern = gitMutationPatterns.find((p) => p.test(command));

		if (!matchedPattern) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: "Git mutation blocked — no UI available for confirmation" };
		}

		const ok = await ctx.ui.confirm(
			"🔒 Git mutation detected",
			`Command:\n\n  ${command}\n\nAllow this git operation?`,
		);

		if (!ok) {
			return { block: true, reason: "Git operation blocked by user" };
		}

		return undefined;
	});
}
