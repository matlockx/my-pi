import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStorage } from "./storage";
import { MEMORY_PROTOCOL } from "./protocol";
import { exportShared, importShared, loadShareConfig, shareConfigPath, type ImportResult } from "./share";

function describeImport(r: ImportResult): string[] {
	const parts: string[] = [];
	if (r.changed) parts.push(`${r.changed} imported or updated`);
	if (r.removed) parts.push(`${r.removed} removed`);
	if (r.invalid.length) parts.push(`unreadable, skipped: ${r.invalid.join(", ")}`);
	if (r.missing.length) parts.push(`checkout missing, removals paused: ${r.missing.join(", ")}`);
	return parts;
}

/**
 * Register lifecycle hooks for shared repository import, auto-context injection and session summaries.
 */
export function registerHooks(pi: ExtensionAPI, storage: MemoryStorage): void {
	// --- Import shared repositories at session start ---
	pi.on("session_start", async (_event, ctx) => {
		try {
			const repos = loadShareConfig();
			if (!repos) return;
			const result = importShared(storage, repos);
			const parts = describeImport(result);
			if (parts.length === 0) return;
			const level = result.invalid.length || result.missing.length ? "warning" : "info";
			ctx.ui.notify(`Shared memory: ${parts.join("; ")}`, level);
		} catch (error) {
			ctx.ui.notify(`Shared memory: ${(error as Error).message}`, "error");
		}
	});

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

			// Last assistant message for summary; assistant content is always a block array.
			if (msg.role === "assistant") {
				for (const block of msg.content) {
					if (block.type === "text" && block.text) {
						lastAssistantSnippet = block.text.slice(0, 300);
						break;
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
 * Register user-facing commands: /remember, /recall and /memory-share.
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

	pi.registerCommand("memory-share", {
		description: "Import shared memories, then write local ones to the shared repositories (~/.pi/memory/shared.json)",
		handler: async (_args, ctx) => {
			let repos;
			try {
				repos = loadShareConfig();
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
				return;
			}
			if (!repos) {
				ctx.ui.notify(
					`No ${shareConfigPath()}; expected [{ "repo": "~/path/to/checkout", "projects": ["project-name"] }]`,
					"warning",
				);
				return;
			}

			try {
				const imported = importShared(storage, repos);
				const exported = exportShared(storage, repos);
				const parts = describeImport(imported);
				parts.push(`${exported.written} written for review`);
				if (exported.withheld.length)
					parts.push(`withheld, secret found (forget and save a clean copy): ${exported.withheld.join(", ")}`);
				if (exported.missing.length) parts.push(`export skipped, checkout missing: ${exported.missing.join(", ")}`);
				const warn =
					imported.invalid.length || imported.missing.length || exported.withheld.length || exported.missing.length;
				ctx.ui.notify(`Shared memory: ${parts.join("; ")}`, warn ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`Shared memory: ${(error as Error).message}`, "error");
			}
		},
	});
}
