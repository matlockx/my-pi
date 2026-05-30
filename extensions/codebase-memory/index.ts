/**
 * Codebase Memory Extension — structural code intelligence via codebase-memory-mcp
 *
 * Exposes graph-based code intelligence tools (get_architecture, search_graph,
 * trace_path, query_graph, get_code_snippet, search_code, index_status,
 * detect_changes) as native Pi tools by shelling out to the
 * `codebase-memory-mcp cli` interface.
 *
 * AIDEV-NOTE: Requires `codebase-memory-mcp` binary on PATH. The graph DB must
 * be initialised for the project (`codebase-memory-mcp install` or equivalent).
 * Project slug is auto-derived from cwd — no manual config needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodebaseTools } from "./tools";

export default function (pi: ExtensionAPI): void {
	registerCodebaseTools(pi);
}
