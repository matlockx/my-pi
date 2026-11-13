/**
 * A minimal MCP tool server over stdio (newline-delimited JSON-RPC), for the
 * small servers of this repository that run as stdio children of the MCP
 * guard (mcp/vcluster, mcp/lifepace). It answers initialize, ping,
 * tools/list and tools/call; any other method gets method-not-found.
 */

import readline from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const ERROR_TEXT_CHARS = 1_000;

/**
 * Answer to one JSON-RPC message, null for notifications and responses.
 * tools is the catalogue tools/list returns, handlers maps a tool name to an
 * async function of its arguments whose result is returned as JSON text; a
 * thrown error becomes a tool error with its message (cut to 1 000
 * characters). serverInfo is { name, version }.
 */
export async function handleMessage({ tools, handlers, serverInfo }, msg) {
	if (msg?.id === undefined || typeof msg.method !== "string") return null;
	const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
	switch (msg.method) {
		case "initialize":
			return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo });
		case "ping":
			return ok({});
		case "tools/list":
			return ok({ tools });
		case "tools/call": {
			const handler = Object.hasOwn(handlers, msg.params?.name) ? handlers[msg.params.name] : undefined;
			if (!handler) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${msg.params?.name}` } };
			try {
				const result = await handler(msg.params?.arguments ?? {});
				return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
			} catch (err) {
				return ok({ content: [{ type: "text", text: err.message.slice(0, ERROR_TEXT_CHARS) }], isError: true });
			}
		}
		default:
			return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method ${msg.method} not found` } };
	}
}

/** Serves server ({ tools, handlers, serverInfo }) on stdin and stdout until stdin closes. */
export function serveStdin(server) {
	readline.createInterface({ input: process.stdin }).on("line", async (line) => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		const answer = await handleMessage(server, msg);
		if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
	});
}
