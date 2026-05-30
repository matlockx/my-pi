import { Type } from "typebox";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStorage } from "./storage";

export function registerTools(pi: ExtensionAPI, storage: MemoryStorage): void {
	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description: "Persist an insight, decision, or pattern to cross-session memory.",
		promptSnippet:
			"memory_save: Persist an insight, decision, or pattern to cross-session memory.",
		promptGuidelines: [
			"Use memory_save after completing bug fixes, making architecture decisions, discovering non-obvious codebase behavior, or establishing patterns. Include relevant file paths in the files parameter.",
		],
		parameters: Type.Object({
			content: Type.String({
				description:
					"The insight or decision to remember. Format: What/Why/Where/Learned.",
			}),
			type: Type.Optional(
				Type.String({
					description:
						"Memory type: pattern, preference, architecture, bug, workflow, fact, decision, discovery, session-summary",
				}),
			),
			concepts: Type.Optional(
				Type.String({
					description: "Comma-separated key concepts for search",
				}),
			),
			files: Type.Optional(
				Type.String({
					description: "Comma-separated relevant file paths",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const project = basename(ctx.cwd);
			const sessionFile = ctx.sessionManager.getSessionFile();

			const id = storage.save({
				content: params.content,
				type: params.type ?? "fact",
				concepts: params.concepts ?? null,
				files: params.files ?? null,
				project,
				session_id: sessionFile ?? null,
			});

			ctx.ui.notify(`💾 Memory saved: ${(params.type ?? "fact")} — ${params.content.slice(0, 80)}`, "info");

			return {
				content: [
					{
						type: "text" as const,
						text: `Saved memory ${id} (${params.type ?? "fact"}) for project "${project}".`,
					},
				],
				details: { id, project },
			};
		},
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search cross-session memory for past decisions, patterns, and discoveries.",
		promptSnippet:
			"memory_recall: Search cross-session memory for past decisions, patterns, and discoveries.",
		promptGuidelines: [
			"Use memory_recall at the start of work on unfamiliar topics, when the user references past work, or when a problem seems like it was solved before.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search terms or keywords",
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Max results to return (default 10)",
				}),
			),
			project: Type.Optional(
				Type.String({
					description:
						"Filter by project name. Default: current project. Use '*' for all projects.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const currentProject = basename(ctx.cwd);
			const projectFilter =
				params.project === "*" ? undefined : (params.project ?? currentProject);
			const limit = params.limit ?? 10;

			const results = storage.search(params.query, projectFilter, limit);

			ctx.ui.notify(`🔍 Memory recall: "${params.query}" → ${results.length} result${results.length === 1 ? "" : "s"}`, "info");

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No memories found for query "${params.query}"${projectFilter ? ` in project "${projectFilter}"` : ""}.`,
						},
					],
					details: undefined,
				};
			}

			const formatted = results
				.map(
					(m) =>
						`[${m.id}] (${m.type}) ${m.content}${m.concepts ? `\n  concepts: ${m.concepts}` : ""}${m.files ? `\n  files: ${m.files}` : ""}\n  project: ${m.project} | ${m.created_at}`,
				)
				.join("\n\n");

			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${results.length} memor${results.length === 1 ? "y" : "ies"}:\n\n${formatted}`,
					},
				],
				details: { count: results.length },
			};
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description: "Delete a specific memory by ID.",
		promptSnippet: "memory_forget: Delete a specific memory by ID.",
		parameters: Type.Object({
			id: Type.String({ description: "Memory ID to delete" }),
			reason: Type.Optional(
				Type.String({ description: "Reason for deletion" }),
			),
		}),
		async execute(_toolCallId, params) {
			const deleted = storage.delete(params.id);

			ctx.ui.notify(
				deleted ? `🗑️ Memory deleted: ${params.id}` : `⚠️ Memory ${params.id} not found`,
				deleted ? "info" : "warning",
			);

			return {
				content: [
					{
						type: "text" as const,
						text: deleted
							? `Deleted memory ${params.id}.${params.reason ? ` Reason: ${params.reason}` : ""}`
							: `Memory ${params.id} not found.`,
					},
				],
				details: { deleted },
			};
		},
	});
}
