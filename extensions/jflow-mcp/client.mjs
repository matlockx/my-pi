// Minimal MCP stdio client: newline-delimited JSON-RPC 2.0 over a child
// process. Only what the jflow bridge needs — initialize, tools/list,
// tools/call. ponytail: no pagination, cancellation or server->client
// requests; add them when a server needs them.

import { spawn } from "node:child_process";

export class McpStdioClient {
	constructor(command, args = [], options = {}) {
		this.nextId = 1;
		this.pending = new Map();
		this.buffer = "";
		this.closed = false;
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
			if (msg.error) entry.reject(new Error(`${msg.error.message ?? "MCP error"} (${msg.error.code})`));
			else entry.resolve(msg.result);
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

	async initialize() {
		await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "pi", version: "1" },
		});
		this.send({ method: "notifications/initialized" });
	}

	async listTools() {
		return (await this.request("tools/list", {})).tools ?? [];
	}

	callTool(name, args) {
		return this.request("tools/call", { name, arguments: args });
	}

	close() {
		this.closed = true;
		this.child.kill();
	}
}

/** Joins the text blocks of an MCP tool result. */
export function resultText(result) {
	return (result?.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
