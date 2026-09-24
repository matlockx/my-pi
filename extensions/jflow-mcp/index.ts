/**
 * jflow MCP bridge
 *
 * pi has no MCP client. At session start this extension connects to jflow's
 * MCP server, discovers its tools via tools/list and registers each one as a
 * pi tool named `jflow_<name>` (jflow_new_task, jflow_commit, jflow_pr, ...).
 * Schemas come from the server, so new jflow tools show up without changes
 * here.
 *
 * Two modes:
 *   - JFLOW_MCP_URL unset: spawns `jflow mcp` (stdio) as a child of pi, so it
 *     runs with pi's (sandboxed) permissions. No-op when `jflow` is not on PATH.
 *   - JFLOW_MCP_URL set (e.g. http://127.0.0.1:8765/): connects to a server
 *     started outside the sandbox with `jflow mcp --http 127.0.0.1:8765`, so
 *     git/gh/acli get ~/.ssh and credentials. The sandbox must allow that
 *     localhost port.
 *
 * Every tool except the read-only ones in READ_ONLY needs confirmation: they
 * create Jira tasks, commit, push and open PRs. Without a UI they are blocked.
 * A prompt you type that says "jflow" (e.g. "create pr with jflow") is the
 * confirmation: jflow tools run without a dialog until your next prompt.
 * `/jflow-auto on` skips the dialog for the rest of the session (never
 * persisted; a new session starts with it off).
 *
 * Footer status: `jflow: stdio ✓`, `jflow: http auto ✓`, `jflow: http down`.
 * In HTTP mode this is UX, not a security boundary: the server has no auth,
 * so anything in the sandbox that can reach the port (the agent's bash too)
 * can call it directly.
 */

import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { abortable, McpHttpClient, McpStdioClient, resultText } from "./client.mjs";
import { inputApprovesJflow, statusText } from "./intent.mjs";

const COMMAND = "jflow";
const URL_ENV = "JFLOW_MCP_URL";
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
	type Client = McpStdioClient | McpHttpClient;
	let client: Client | undefined;
	let connecting: Promise<Client> | undefined;
	const url = process.env[URL_ENV]?.trim();
	const mode = url ? "http" : "stdio";
	// up: undefined = not installed/unknown, false = unreachable, true = answered.
	let up: boolean | undefined;
	let auto = false;

	type UiCtx = { hasUI: boolean; ui: { setStatus: (id: string, text: string | undefined) => void } };
	function showStatus(ctx: UiCtx, nowUp: boolean | undefined = up) {
		up = nowUp;
		if (ctx.hasUI) ctx.ui.setStatus("jflow-mcp", statusText({ mode, up, auto }));
	}

	// Memoised so parallel tool calls after a crash/restart share one new connection.
	function connect(cwd: string): Promise<Client> {
		if (client && !client.closed) return Promise.resolve(client);
		connecting ??= (async () => {
			const c = url ? new McpHttpClient(url) : new McpStdioClient(COMMAND, ["mcp"], { cwd });
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
			// Stdio without jflow installed is a silent no-op; a configured URL that fails is worth a warning.
			const missing = !url && (err as NodeJS.ErrnoException).code === "ENOENT";
			showStatus(ctx, missing ? undefined : false);
			if (!missing && ctx.hasUI) {
				const where = url ? ` at ${url} (started with 'jflow mcp --http'?)` : "";
				ctx.ui.notify(`jflow MCP unavailable${where}: ${(err as Error).message}`, "warning");
			}
			return;
		}
		showStatus(ctx, true);

		for (const tool of tools) {
			pi.registerTool({
				name: PREFIX + tool.name,
				label: `jflow ${tool.name}`,
				description: tool.description ?? tool.name,
				parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: "object" }),
				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					const args = { ...params };
					// Models sometimes pass relative or @-prefixed paths; jflow wants absolute.
					if (typeof args.path === "string") args.path = resolve(ctx.cwd, args.path.replace(/^@/, ""));

					if (!READ_ONLY.has(tool.name) && !approvedByPrompt && !auto) {
						if (!ctx.hasUI) throw new Error(`jflow ${tool.name} blocked — no UI available for confirmation`);
						const ok = await ctx.ui.confirm(
							`🔒 jflow ${tool.name}`,
							`${JSON.stringify(args, null, 2)}\n\nAllow this jflow operation?`,
						);
						if (!ok) throw new Error(`jflow ${tool.name} blocked by user`);
					}

					// Abort stops waiting but sends no MCP cancellation: a half-cancelled push/PR is worse
					// than letting jflow finish. Without this, a stuck git hook hangs the session unabortably.
					let c: Client;
					try {
						c = await connect(ctx.cwd);
					} catch (err) {
						showStatus(ctx, false);
						throw err;
					}
					showStatus(ctx, true);
					const result = await abortable(c.callTool(tool.name, args), signal);
					const text = resultText(result);
					if (result?.isError) throw new Error(text || `jflow ${tool.name} failed`);
					return { content: [{ type: "text", text }], details: {} };
				},
			});
		}
	});

	// Each user prompt resets the approval, so it never outlives the request that gave it.
	let approvedByPrompt = false;
	pi.on("input", async (event) => {
		approvedByPrompt = inputApprovesJflow(event);
		return { action: "continue" };
	});

	pi.registerCommand("jflow-auto", {
		description: "Run jflow MCP tools without confirmation for this session (on|off|status)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") auto = arg === "on";
			else if (arg !== "status") auto = !auto;
			showStatus(ctx);
			if (ctx.hasUI) ctx.ui.notify(`jflow auto-approve ${auto ? "on — tools push and edit Jira without asking" : "off"}`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		client?.close();
		client = undefined;
		auto = false; // auto-approve never carries into another session
	});
}
