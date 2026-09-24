/**
 * regkb MCP bridge
 *
 * Registers the read-only tools of the regkb gambling-regulation knowledge base
 * (reg_search, reg_get, reg_compare, reg_sources) as pi tools. At session start
 * it spawns `uv --directory $REGKB_DIR run regkb serve` (stdio MCP) and takes
 * the tool schemas from tools/list, so new regkb tools need no change here.
 *
 * REGKB_DIR defaults to ~/github/regkb. No-op when that directory or its
 * data/regkb.db is missing, or when `uv` is not on PATH. The tools only read
 * the database, so they run without confirmation.
 *
 * Under a sandbox (nono), the server needs read access to REGKB_DIR, uv's
 * cache and the Hugging Face model cache (~/.cache/huggingface); otherwise
 * the bridge reports it as unavailable.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// Shared with the jflow bridge; the regkb server only needs its stdio client.
import { McpStdioClient, resultText } from "../jflow-mcp/client.mjs";

const START_TIMEOUT_MS = 30_000; // uv may sync the environment on first start
const CALL_TIMEOUT_MS = 120_000; // the first search loads the embedding model

type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref()),
	]);
}

function withAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return p;
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export default function (pi: ExtensionAPI) {
	const dir = process.env.REGKB_DIR?.trim() || join(homedir(), "github", "regkb");
	let client: McpStdioClient | undefined;
	let connecting: Promise<McpStdioClient> | undefined;

	// Memoised so parallel tool calls after a crash share one restart.
	function connect(): Promise<McpStdioClient> {
		if (client && !client.closed) return Promise.resolve(client);
		connecting ??= (async () => {
			const c = new McpStdioClient("uv", ["--directory", dir, "run", "--quiet", "regkb", "serve"], { cwd: dir });
			try {
				await withTimeout(c.initialize(), START_TIMEOUT_MS, "regkb start");
			} catch (err) {
				c.close();
				throw err;
			}
			client = c;
			return c;
		})().finally(() => {
			connecting = undefined;
		});
		return connecting;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!existsSync(join(dir, "data", "regkb.db"))) return;
		let tools: McpTool[];
		try {
			tools = await withTimeout((await connect()).listTools(), START_TIMEOUT_MS, "regkb tools/list");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // uv not installed
			if (ctx.hasUI) ctx.ui.notify(`regkb MCP unavailable: ${(err as Error).message}`, "warning");
			return;
		}

		for (const tool of tools) {
			pi.registerTool({
				name: tool.name,
				label: `regkb ${tool.name}`,
				description: tool.description ?? tool.name,
				parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: "object" }),
				async execute(_toolCallId, params, signal) {
					const c = await connect();
					const result = await withAbort(
						withTimeout(c.callTool(tool.name, params), CALL_TIMEOUT_MS, `regkb ${tool.name}`),
						signal,
					);
					const text = resultText(result);
					if (result?.isError) throw new Error(text || `regkb ${tool.name} failed`);
					return { content: [{ type: "text", text }], details: {} };
				},
			});
		}
	});

	pi.on("session_shutdown", async () => {
		client?.close();
		client = undefined;
	});
}
