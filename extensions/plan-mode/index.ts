/**
 * Plan Mode Extension
 *
 * AIDEV-NOTE: Enforces pure planning mode that prevents all file changes,
 * tool execution, and system mutations. Unlike /plan command which only
 * switches models, this extension hard-blocks any mutating operations.
 *
 * This ensures that when in "planning mode", the agent cannot:
 * - Edit or write files
 * - Run mutating bash commands
 * - Commit, push, or tag in git
 * - Make any system mutations
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// AIDEV-NOTE: Patterns for commands that could mutate the filesystem or system state
	const mutatingCommands = [
		/\b(edit|write|touch|rm|mv|cp|mkdir|chmod|chown)\b/i,
		/\bgit\s+(commit|push|tag|add|reset|checkout)\b/i,
		/\bnpm\s+(install|update|uninstall|publish)\b/i,
		/\byarn\s+(install|add|remove|publish)\b/i,
		/\bmake\b/i,
		/\bgo\s+(build|run|install)\b/i,
		/\bpython\s+(-m\s+)?(setup|install|build)\b/i,
	];

	// AIDEV-NOTE: Hard block any file editing operations - ensure this is caught early
	pi.on("tool_call", async (event) => {
		// Block file editing operations
		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason:
					"Plan mode prevents file edits. Use /build to implement changes.",
			};
		}

		// Block bash commands that could mutate state
		if (event.toolName === "bash") {
			const command = event.input.command as string;

			// Check for mutating bash commands
			for (const pattern of mutatingCommands) {
				if (pattern.test(command)) {
					return {
						block: true,
						reason:
							"Plan mode prevents mutating bash commands. Use /build to implement changes.",
					};
				}
			}

			// Also block grep/egrep/fgrep as a safety net (complements rg-gate)
			const grepPattern = /\b(grep|egrep|fgrep)\b/;
			if (grepPattern.test(command)) {
				return {
					block: true,
					reason: "Plan mode prevents grep usage. Use `rg` (ripgrep) instead.",
				};
			}
		}

		return undefined;
	});
}
