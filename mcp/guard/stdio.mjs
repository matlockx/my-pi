/**
 * Stdio upstream for the MCP guard: the guard serves Streamable HTTP to the
 * client, and the guarded MCP server runs as a child process speaking
 * newline-delimited JSON-RPC on stdin and stdout. The server has no port, so
 * nothing can reach it without passing the guard.
 *
 * The bridge initialises the server once and lists its tools; every client
 * gets that cached initialize result, and the tool annotations feed the
 * policy. Request ids are rewritten per request, so concurrent clients never
 * collide. Client notifications are dropped (the bridge sent
 * notifications/initialized itself; a cancellation would name a rewritten id).
 * Server notifications are dropped. Server requests are answered by the
 * bridge: ping with an empty result, anything else (elicitation, roots,
 * sampling) with a method-not-found error, since the guard is the only party
 * that confirms anything. Answers are plain application/json; the bridge
 * issues no session id (a guard created with sessions issues its own,
 * guard.mjs), and GET and DELETE get 405 unless the guard answers them.
 *
 * DEV-NOTE: see my-pi notes/specs/2026-11-12-kube-aws-vcluster-mcp.md (Phase 1).
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import { createGuard, LISTEN_HOST, stopWithSignals } from "./guard.mjs";

/** Protocol version the bridge asks the server for. */
export const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "mcpguard", version: "1" };
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/**
 * Bridge to an MCP server that already runs as child (stdin and stdout piped).
 * Emits "exit" when the child exits; requests still pending then get an
 * internal error.
 */
export class StdioBridge extends EventEmitter {
	constructor(child) {
		super();
		this.child = child;
		this.nextId = 1;
		this.pending = new Map();
		this.initResult = null;
		/** Tool name to its annotations as listed by the server at start. */
		this.tools = new Map();
		readline.createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
		child.on("exit", (code, signal) => {
			for (const done of this.pending.values()) done({ error: { code: INTERNAL_ERROR, message: `MCP server exited (${signal ?? code})` } });
			this.pending.clear();
			this.emit("exit", code, signal);
		});
	}

	/** Handles one line of the server's stdout. */
	receive(line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			// Servers log to stderr; a stray stdout line is shown, not parsed.
			if (line.trim()) console.error(`mcpguard stdio: ignoring non-JSON line from the server: ${line.slice(0, 200)}`);
			return;
		}
		if (msg?.method !== undefined) {
			if (msg.id !== undefined) this.answerServer(msg);
			return;
		}
		const done = this.pending.get(msg?.id);
		if (!done) return;
		this.pending.delete(msg.id);
		done(msg);
	}

	/** Answers a request the server sent to its client. */
	answerServer(msg) {
		const reply =
			msg.method === "ping"
				? { result: {} }
				: { error: { code: METHOD_NOT_FOUND, message: `${msg.method} is not supported behind the MCP guard` } };
		this.write({ jsonrpc: "2.0", id: msg.id, ...reply });
	}

	write(msg) {
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	/** Sends method with params to the server; resolves its answer ({ result } or { error }) without the id. */
	request(method, params) {
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.pending.set(id, ({ result, error }) => resolve(error ? { error } : { result }));
			this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
		});
	}

	/** Initialises the server and records its tools' annotations; rejects when the server answers with an error. */
	async start() {
		const init = await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
		if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
		this.initResult = init.result;
		this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
		let cursor;
		do {
			const page = await this.request("tools/list", cursor ? { cursor } : undefined);
			if (page.error) throw new Error(`tools/list failed: ${page.error.message}`);
			for (const tool of page.result?.tools ?? []) this.tools.set(tool.name, tool.annotations ?? {});
			cursor = page.result?.nextCursor;
		} while (cursor);
	}

	/** Answer to one client message: null for notifications and responses, else a JSON-RPC response with the client's id. */
	async handle(msg) {
		if (msg?.id === undefined || typeof msg.method !== "string") return null;
		const answer =
			msg.method === "initialize" ? { result: this.initResult } : await this.request(msg.method, msg.params);
		return { jsonrpc: "2.0", id: msg.id, ...answer };
	}

	/** Guard forward function: answers a POST body (one message or a batch); 405 for any other method. */
	forward = async (req, res, body) => {
		if (req.method !== "POST") {
			req.resume();
			res.writeHead(405, { allow: "POST", "content-type": "text/plain" }).end("only POST is supported\n");
			return;
		}
		// The guard has parsed body before it calls forward, so it is JSON.
		const parsed = JSON.parse(body.toString("utf8"));
		const batch = Array.isArray(parsed);
		const answers = (await Promise.all((batch ? parsed : [parsed]).map((m) => this.handle(m)))).filter(Boolean);
		if (answers.length === 0) {
			res.writeHead(202).end();
			return;
		}
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(batch ? answers : answers[0]));
	};
}

/**
 * Starts command with args and env as a stdio MCP server, initialises it
 * within startTimeoutMs, then serves a guard on listenPort whose policy gets
 * the server's tool annotations as `tools` (a Map of tool name to
 * annotations). guard holds the createGuard options other than forward. The
 * process exits when the server exits or does not initialise in time;
 * SIGTERM and SIGINT stop both. name prefixes the log lines.
 */
export async function serveStdio({ name, command, args, env, listenPort, guard, startTimeoutMs = 10_000 }) {
	const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "inherit"] });
	child.on("error", (err) => {
		console.error(`${name}: cannot start ${command}: ${err.message}`);
		process.exit(1);
	});
	const bridge = new StdioBridge(child);
	bridge.on("exit", (code, signal) => {
		console.error(`${name}: ${command} exited (${signal ?? code})`);
		process.exit(1);
	});
	stopWithSignals(child);
	let timer;
	try {
		await Promise.race([
			bridge.start(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`not initialised after ${startTimeoutMs} ms`)), startTimeoutMs);
			}),
		]);
	} catch (err) {
		console.error(`${name}: ${err.message}`);
		child.kill("SIGTERM");
		process.exit(1);
	} finally {
		clearTimeout(timer);
	}
	const server = createGuard({ ...guard, policy: { ...guard.policy, tools: bridge.tools }, forward: bridge.forward });
	server.listen(listenPort, LISTEN_HOST, () => {
		console.error(`${name}: up on http://${LISTEN_HOST}:${listenPort}/mcp (stdio: ${command}, ${bridge.tools.size} tools)`);
	});
}
