/**
 * Thin wrapper around `codebase-memory-mcp cli <tool> <json>`.
 *
 * AIDEV-NOTE: stderr contains log lines (level=info …) that are not errors.
 * We only treat non-zero exit codes as failures. The "project" param is
 * auto-injected from cwd when not supplied by the caller.
 */

import { execFile } from "node:child_process";

const BINARY = "codebase-memory-mcp";

/** Convert cwd path to the project slug codebase-memory expects. */
export function cwdToProject(cwd: string): string {
	// /Users/martin.joehren/projects/my-pi → Users-martin.joehren-projects-my-pi
	return cwd.replace(/^\//, "").replaceAll("/", "-");
}

export interface CliResult {
	ok: boolean;
	/** Parsed JSON on success, raw string on parse failure. */
	data: unknown;
	/** Raw stdout for the tool result text. */
	raw: string;
}

/**
 * Run a single codebase-memory-mcp CLI tool invocation.
 *
 * @param tool   Tool name (e.g. "search_graph")
 * @param params JSON-serialisable params object
 * @param cwd    Working directory — used to derive project slug
 */
export function runTool(
	tool: string,
	params: Record<string, unknown>,
	cwd: string,
): Promise<CliResult> {
	// Auto-inject project when not explicitly provided
	const merged: Record<string, unknown> = { project: cwdToProject(cwd), ...params };
	const json = JSON.stringify(merged);

	return new Promise((resolve) => {
		execFile(
			BINARY,
			["cli", tool, json],
			{ cwd, maxBuffer: 1024 * 1024, timeout: 30_000 },
			(err, stdout, _stderr) => {
				const raw = stdout.trim();
				if (err) {
					resolve({ ok: false, data: raw || (err as Error).message, raw });
					return;
				}
				try {
					resolve({ ok: true, data: JSON.parse(raw), raw });
				} catch {
					resolve({ ok: true, data: raw, raw });
				}
			},
		);
	});
}
