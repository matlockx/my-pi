import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { runTool } from "./cli";

// ── Helpers ───────────────────────────────────────────────────────────

/** Format CLI result as text for the LLM, with truncation for large output. */
function formatResult(result: { ok: boolean; raw: string }, toolName: string): {
	text: string;
	isError: boolean;
} {
	if (!result.ok) {
		return { text: `Error running ${toolName}: ${result.raw}`, isError: true };
	}

	const truncation = truncateHead(result.raw, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let text = truncation.content;
	if (truncation.truncated) {
		text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	}

	return { text, isError: false };
}

// ── Tool registration ─────────────────────────────────────────────────

export function registerCodebaseTools(pi: ExtensionAPI): void {
	// AIDEV-NOTE: Project param is optional in all tools — auto-injected from cwd by cli.ts.
	const optionalProject = Type.Optional(
		Type.String({ description: "Project slug. Default: auto-detected from cwd." }),
	);

	// ── get_architecture ──────────────────────────────────────────────
	pi.registerTool({
		name: "get_architecture",
		label: "Get Architecture",
		description:
			"Get a high-level overview of the codebase: node/edge counts, labels, and module structure.",
		promptSnippet:
			"get_architecture: High-level codebase overview — node/edge counts, labels, modules.",
		promptGuidelines: [
			"Use get_architecture for a quick structural overview of the codebase before diving into specifics.",
		],
		parameters: Type.Object({
			project: optionalProject,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await runTool("get_architecture", params, ctx.cwd);
			const { text, isError } = formatResult(result, "get_architecture");
			if (isError) throw new Error(text);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	// ── search_graph ──────────────────────────────────────────────────
	pi.registerTool({
		name: "search_graph",
		label: "Search Graph",
		description:
			"Search the code knowledge graph for symbols, functions, classes, or modules by name or keyword.",
		promptSnippet:
			"search_graph: Find symbols/entities in the codebase knowledge graph by name or keyword.",
		promptGuidelines: [
			"Use search_graph to discover functions, classes, interfaces, or modules by name before reading source files.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query (symbol name, keyword, etc.)" }),
			project: optionalProject,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await runTool("search_graph", params, ctx.cwd);
			const { text, isError } = formatResult(result, "search_graph");
			if (isError) throw new Error(text);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	// ── query_graph ───────────────────────────────────────────────────
	pi.registerTool({
		name: "query_graph",
		label: "Query Graph",
		description:
			"Run a Cypher-style query against the code knowledge graph. Use get_architecture first to see available labels and edge types.",
		promptSnippet:
			"query_graph: Run Cypher-style queries against the code graph (labels, edges, properties).",
		promptGuidelines: [
			"Use query_graph for flexible graph queries. Call get_architecture first to see available node labels and edge types.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					'Cypher query, e.g. MATCH (f:Function)-[:CALLS]->(t) WHERE f.name = "foo" RETURN f.name, t.name LIMIT 10',
			}),
			project: optionalProject,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await runTool("query_graph", params, ctx.cwd);
			const { text, isError } = formatResult(result, "query_graph");
			if (isError) throw new Error(text);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	// ── trace_path ────────────────────────────────────────────────────
	pi.registerTool({
		name: "trace_path",
		label: "Trace Path",
		description:
			"Trace call chains and dependency paths from/to a function or symbol in the code graph.",
		promptSnippet:
			"trace_path: Trace callers, callees, and dependency paths for a function/symbol.",
		promptGuidelines: [
			"Use trace_path to understand call chains and dependency relationships before refactoring shared code.",
		],
		parameters: Type.Object({
			function_name: Type.String({ description: "Function or symbol name to trace" }),
			direction: Type.Optional(
				Type.String({
					description: 'Trace direction: "callers", "callees", or "both" (default: "both")',
				}),
			),
			depth: Type.Optional(
				Type.Number({ description: "Max traversal depth (default: 3)" }),
			),
			project: optionalProject,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await runTool("trace_path", params, ctx.cwd);
			const { text, isError } = formatResult(result, "trace_path");
			if (isError) throw new Error(text);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	// ── get_code_snippet ──────────────────────────────────────────────
	pi.registerTool({
		name: "get_code_snippet",
		label: "Get Code Snippet",
		description:
			"Retrieve the source code for a specific graph node by its qualified name.",
		promptSnippet:
			"get_code_snippet: Retrieve source code for a symbol by its qualified_name from the graph.",
		promptGuidelines: [
			"Use get_code_snippet with a qualified_name from search_graph results to view source without reading the whole file.",
		],
		parameters: Type.Object({
			qualified_name: Type.String({
				description:
					"Fully qualified node name from search_graph results (e.g. project.module.Class.method)",
			}),
			project: optionalProject,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await runTool("get_code_snippet", params, ctx.cwd);
			const { text, isError } = formatResult(result, "get_code_snippet");
			if (isError) throw new Error(text);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	// ── search_code ───────────────────────────────────────────────────
	pi.registerTool({
		name: "search_code",
		label: "Search Code",
		description:
			"Search indexed source code for a text pattern, returning matching graph nodes and line numbers.",
		promptSnippet:
			"search_code: Text-pattern search across indexed code, returning graph nodes and match lines.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Text pattern to search for" }),
			project: optionalProject,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await runTool("search_code", params, ctx.cwd);
			const { text, isError } = formatResult(result, "search_code");
			if (isError) throw new Error(text);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	// ── index_status ──────────────────────────────────────────────────
	pi.registerTool({
		name: "index_status",
		label: "Index Status",
		description:
			"Check if the code graph index is current for this project (node/edge counts, staleness).",
		promptSnippet:
			"index_status: Check whether the codebase graph index is up-to-date.",
		parameters: Type.Object({
			project: optionalProject,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await runTool("index_status", params, ctx.cwd);
			const { text, isError } = formatResult(result, "index_status");
			if (isError) throw new Error(text);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	// ── detect_changes ────────────────────────────────────────────────
	pi.registerTool({
		name: "detect_changes",
		label: "Detect Changes",
		description:
			"Detect files changed since the last index and their impacted symbols in the graph.",
		promptSnippet:
			"detect_changes: Find files changed since last index and impacted graph symbols.",
		parameters: Type.Object({
			project: optionalProject,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await runTool("detect_changes", params, ctx.cwd);
			const { text, isError } = formatResult(result, "detect_changes");
			if (isError) throw new Error(text);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});
}
