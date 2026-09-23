/**
 * jflow MCP bridge
 *
 * pi has no MCP client. This extension spawns `jflow mcp` (stdio) at session
 * start, discovers its tools via tools/list and registers each one as a pi
 * tool named `jflow_<name>` (jflow_new_task, jflow_commit, jflow_pr, ...).
 * Schemas come from the server, so new jflow tools show up without changes
 * here.
 *
 * Every tool except the read-only ones in READ_ONLY needs confirmation: they
 * create Jira tasks, commit, push and open PRs. Without a UI they are blocked.
 *
 * No-op when `jflow` is not on PATH.
 */

import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { McpStdioClient, resultText } from "./client.mjs";

const COMMAND = "jflow";
const PREFIX = "jflow_";
const START_TIMEOUT_MS = 10_000;
// Unknown (new) tools fail closed and need confirmation.
const READ_ONLY = new Set(["list_epics"]);

type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref()),
	]);
}

export default function (pi: ExtensionAPI) {
	let client: McpStdioClient | undefined;
	let connecting: Promise<McpStdioClient> | undefined;

	// Memoised so parallel tool calls after a crash share one restarted server.
	function connect(cwd: string): Promise<McpStdioClient> {
		if (client && !client.closed) return Promise.resolve(client);
		connecting ??= (async () => {
			const c = new McpStdioClient(COMMAND, ["mcp"], { cwd });
			try {
				await withTimeout(c.initialize(), START_TIMEOUT_MS);
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
		let tools: McpTool[];
		try {
			tools = await withTimeout((await connect(ctx.cwd)).listTools(), START_TIMEOUT_MS);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT" && ctx.hasUI) {
				ctx.ui.notify(`jflow MCP unavailable: ${(err as Error).message}`, "warning");
			}
			return;
		}

		for (const tool of tools) {
			pi.registerTool({
				name: PREFIX + tool.name,
				label: `jflow ${tool.name}`,
				description: tool.description ?? tool.name,
				parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: "object" }),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const args = { ...params };
					// Models sometimes pass relative or @-prefixed paths; jflow wants absolute.
					if (typeof args.path === "string") args.path = resolve(ctx.cwd, args.path.replace(/^@/, ""));

					if (!READ_ONLY.has(tool.name)) {
						if (!ctx.hasUI) throw new Error(`jflow ${tool.name} blocked — no UI available for confirmation`);
						const ok = await ctx.ui.confirm(
							`🔒 jflow ${tool.name}`,
							`${JSON.stringify(args, null, 2)}\n\nAllow this jflow operation?`,
						);
						if (!ok) throw new Error(`jflow ${tool.name} blocked by user`);
					}

					// ponytail: no MCP cancellation on abort — a half-cancelled push/PR is worse than waiting.
					const result = await (await connect(ctx.cwd)).callTool(tool.name, args);
					const text = resultText(result);
					if (result?.isError) throw new Error(text || `jflow ${tool.name} failed`);
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
