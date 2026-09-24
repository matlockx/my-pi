// Minimal MCP clients: stdio (newline-delimited JSON-RPC 2.0 over a child
// process) and streamable HTTP (POST per message, JSON or SSE response).
// Only what the jflow bridge needs — initialize, tools/list, tools/call.
// ponytail: no pagination, cancellation or server->client requests; add them
// when a server needs them.

import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

const PROTOCOL_VERSION = "2025-06-18";

class McpClient {
	nextId = 1;
	closed = false;

	async initialize() {
		await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "pi", version: "1" },
		});
		await this.notify("notifications/initialized");
	}

	async listTools() {
		return (await this.request("tools/list", {})).tools ?? [];
	}

	callTool(name, args) {
		return this.request("tools/call", { name, arguments: args });
	}
}

/**
 * Rejects when `signal` aborts, without cancelling `p`: the caller stops waiting,
 * the server-side work (commit, push, PR) still runs to completion.
 */
export function abortable(p, signal) {
	if (!signal) return p;
	return new Promise((resolve, reject) => {
		const onAbort = () =>
			reject(new Error("aborted — stopped waiting; jflow may still finish server-side, check git/Jira state"));
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function rpcResult(msg) {
	if (msg.error) throw new Error(`${msg.error.message ?? "MCP error"} (${msg.error.code})`);
	return msg.result;
}

/** Talks to an MCP server it spawns as a child process. */
export class McpStdioClient extends McpClient {
	constructor(command, args = [], options = {}) {
		super();
		this.pending = new Map();
		this.buffer = "";
		// stderr is ignored: an undrained pipe fills up and blocks the server.
		this.child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "ignore"] });
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.onData(chunk));
		this.child.on("error", (err) => this.fail(err));
		this.child.on("exit", (code, signal) => this.fail(new Error(`${command} exited (${signal ?? code})`)));
		this.child.stdin.on("error", (err) => this.fail(err));
	}

	onData(chunk) {
		this.buffer += chunk;
		let nl;
		while ((nl = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			const entry = msg.id === undefined ? undefined : this.pending.get(msg.id);
			if (!entry) continue; // notification or server request: ignored
			this.pending.delete(msg.id);
			try {
				entry.resolve(rpcResult(msg));
			} catch (err) {
				entry.reject(err);
			}
		}
	}

	fail(err) {
		this.closed = true;
		for (const { reject } of this.pending.values()) reject(err);
		this.pending.clear();
	}

	send(msg) {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
	}

	request(method, params) {
		if (this.closed) return Promise.reject(new Error("MCP server is not running"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ id, method, params });
		});
	}

	async notify(method, params) {
		this.send({ method, params });
	}

	close() {
		this.closed = true;
		this.child.kill();
	}
}

/**
 * Talks to an already running MCP server over streamable HTTP.
 * Uses node:http, not fetch: jflow sends response headers only when a tool
 * finishes, and fetch aborts after 300 s without headers (a long `pr`).
 */
export class McpHttpClient extends McpClient {
	constructor(url) {
		super();
		try {
			this.url = new URL(url);
		} catch {
			throw new Error(`invalid JFLOW_MCP_URL: ${url}`);
		}
		this.sessionId = undefined;
	}

	/** POSTs one JSON-RPC message; resolves with the response for `id`, or undefined for notifications. */
	post(msg) {
		const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
		const headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"content-length": Buffer.byteLength(body),
		};
		if (this.sessionId) {
			headers["mcp-session-id"] = this.sessionId;
			headers["mcp-protocol-version"] = PROTOCOL_VERSION;
		}
		const lib = this.url.protocol === "https:" ? https : http;

		return new Promise((resolve, reject) => {
			const fail = (err) => {
				this.closed = true;
				reject(err);
			};
			const req = lib.request(this.url, { method: "POST", headers }, (res) => {
				res.setEncoding("utf8");
				const sid = res.headers["mcp-session-id"];
				if (sid) this.sessionId = sid;

				if (res.statusCode === 202) {
					res.resume();
					return resolve(undefined);
				}
				let buf = "";
				if (res.statusCode < 200 || res.statusCode >= 300) {
					res.on("data", (c) => (buf += c));
					// 404 = unknown session (server restarted): closed, so the caller reconnects.
					res.on("end", () => fail(new Error(`MCP HTTP ${res.statusCode}: ${buf.trim()}`)));
					return;
				}

				let done = false;
				const deliver = (text) => {
					let parsed;
					try {
						parsed = JSON.parse(text);
					} catch {
						return;
					}
					for (const m of [parsed].flat()) {
						if (done || m.id !== msg.id) continue;
						done = true;
						res.destroy();
						try {
							resolve(rpcResult(m));
						} catch (err) {
							reject(err);
						}
					}
				};

				const sse = String(res.headers["content-type"]).includes("text/event-stream");
				res.on("data", (chunk) => {
					buf += chunk;
					if (!sse) return;
					let end;
					while ((end = buf.search(/\r?\n\r?\n/)) >= 0) {
						const event = buf.slice(0, end);
						buf = buf.slice(end).replace(/^\r?\n\r?\n/, "");
						const data = event
							.split(/\r?\n/)
							.filter((l) => l.startsWith("data:"))
							.map((l) => l.slice(5).trimStart())
							.join("\n");
						if (data) deliver(data);
					}
				});
				res.on("end", () => {
					if (!sse) deliver(buf);
					if (!done) fail(new Error(`MCP HTTP response ended without a reply to ${msg.method}`));
				});
				res.on("error", (err) => done || fail(err));
			});
			req.on("error", fail);
			req.end(body);
		});
	}

	request(method, params) {
		if (this.closed) return Promise.reject(new Error("MCP server is not reachable"));
		return this.post({ id: this.nextId++, method, params });
	}

	notify(method, params) {
		return this.post({ method, params });
	}

	close() {
		this.closed = true;
		if (!this.sessionId) return;
		const lib = this.url.protocol === "https:" ? https : http;
		// Best effort: tell the server to drop the session.
		lib.request(this.url, { method: "DELETE", headers: { "mcp-session-id": this.sessionId } })
			.on("error", () => {})
			.end();
	}
}

/** Joins the text blocks of an MCP tool result. */
export function resultText(result) {
	return (result?.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
