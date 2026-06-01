/**
 * Ripgrep Gate Extension
 *
 * AIDEV-NOTE: Hard gate blocking grep in bash tool calls.
 * Forces use of rg (ripgrep) instead. Complements the soft
 * instruction in AGENTS.md: "Never use grep in Bash. Use rg instead."
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// AIDEV-NOTE: Match grep/egrep/fgrep as standalone commands.
	// Won't false-positive on "ripgrep" or variable names containing "grep".
	const grepPattern = /\b(grep|egrep|fgrep)\b/;

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;

		if (grepPattern.test(command)) {
			return {
				block: true,
				reason: "Use `rg` (ripgrep) instead of `grep`. Rewrite the command with `rg`.",
			};
		}

		return undefined;
	});
}
