import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStorage } from "./storage";
import { MEMORY_PROTOCOL } from "./protocol";

/**
 * Register lifecycle hooks for auto-context injection and session summaries.
 */
export function registerHooks(pi: ExtensionAPI, storage: MemoryStorage): void {
	// --- Inject relevant memories + protocol into system prompt before each agent turn ---
	pi.on("before_agent_start", async (event, ctx) => {
		const project = basename(ctx.cwd);
		const memories = storage.getByProject(project, 5);

		let memoryBlock = `\n\n${MEMORY_PROTOCOL}\n`;

		if (memories.length > 0) {
			memoryBlock += "\n### Relevant memories for this project:\n";
			for (const m of memories) {
				const concepts = m.concepts ? ` (${m.concepts})` : "";
				memoryBlock += `- [${m.type}] ${m.content}${concepts} — ${m.created_at}\n`;
			}
		}

		return {
			systemPrompt: event.systemPrompt + memoryBlock,
		};
	});

	// --- Auto-save session summary on quit ---
	pi.on("session_shutdown", async (event, ctx) => {
		// Only auto-summarize on quit, not on reload/fork/new/resume
		if (event.reason !== "quit") return;

		const project = basename(ctx.cwd);
		const entries = ctx.sessionManager.getBranch();

		// Extract first user message as the session goal
		let goal = "";
		const filesTouched = new Set<string>();
		let lastAssistantSnippet = "";

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const msg = entry.message;

			// First user message = goal
			if (msg.role === "user" && !goal) {
				if (typeof msg.content === "string") {
					goal = msg.content.slice(0, 200);
				} else if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "text" && block.text) {
							goal = block.text.slice(0, 200);
							break;
						}
					}
				}
			}

			// Collect file paths from tool results (write/edit tools)
			if (msg.role === "toolResult" && msg.toolName) {
				const toolName = msg.toolName;
				if (
					toolName === "write" ||
					toolName === "edit" ||
					toolName === "Read" ||
					toolName === "read"
				) {
					// Try to extract file path from tool input stored in details
					const details = msg.details as Record<string, unknown> | undefined;
					if (details) {
						const filePath =
							(details.filePath as string | undefined) ??
							(details.path as string | undefined);
						if (filePath) filesTouched.add(filePath);
					}
				}
			}

			// Last assistant message for summary
			if (msg.role === "assistant") {
				if (typeof msg.content === "string") {
					lastAssistantSnippet = msg.content.slice(0, 300);
				} else if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "text" && block.text) {
							lastAssistantSnippet = block.text.slice(0, 300);
							break;
						}
					}
				}
			}
		}

		// Only save if there was meaningful interaction
		if (!goal) return;

		const fileList =
			filesTouched.size > 0
				? `\nFiles: ${[...filesTouched].slice(0, 15).join(", ")}`
				: "";
		const outcome = lastAssistantSnippet
			? `\nOutcome: ${lastAssistantSnippet}`
			: "";

		const summary = `Session summary — Goal: ${goal}${fileList}${outcome}`;

		const sessionFile = ctx.sessionManager.getSessionFile();

		storage.save({
			content: summary,
			type: "session-summary",
			concepts: "session,summary",
			files:
				filesTouched.size > 0
					? [...filesTouched].slice(0, 15).join(",")
					: null,
			project,
			session_id: sessionFile ?? null,
		});

		ctx.ui.notify("📝 Session summary saved to memory", "info");
	});
}

/**
 * Register user-facing commands: /remember and /recall.
 */
export function registerCommands(
	pi: ExtensionAPI,
	storage: MemoryStorage,
): void {
	pi.registerCommand("remember", {
		description: "Save an insight to cross-session memory (/remember <text>)",
		handler: async (args, ctx) => {
			const content = args.trim();
			if (!content) {
				ctx.ui.notify("Usage: /remember <insight to save>", "error");
				return;
			}

			const project = basename(ctx.cwd);
			const sessionFile = ctx.sessionManager.getSessionFile();

			const id = storage.save({
				content,
				type: "fact",
				concepts: null,
				files: null,
				project,
				session_id: sessionFile ?? null,
			});

			ctx.ui.notify(`Saved memory ${id}`, "info");
		},
	});

	pi.registerCommand("recall", {
		description: "Search cross-session memory (/recall <query>)",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /recall <search query>", "error");
				return;
			}

			const project = basename(ctx.cwd);
			const results = storage.search(query, project, 10);

			if (results.length === 0) {
				ctx.ui.notify(`No memories found for "${query}"`, "info");
				return;
			}

			const lines = results.map(
				(m) => `[${m.type}] ${m.content.slice(0, 100)}`,
			);
			ctx.ui.notify(
				`${results.length} memor${results.length === 1 ? "y" : "ies"} found:\n${lines.join("\n")}`,
				"info",
			);
		},
	});
}
