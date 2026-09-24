import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";

import { abortable, McpHttpClient, McpStdioClient, resultText } from "./client.mjs";

// Fake MCP server: answers initialize, tools/list and tools/call; exits on "crash".
const FAKE_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
rl.on("line", (line) => {
	const m = JSON.parse(line);
	if (m.id === undefined) return;
	if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: "2025-06-18" } });
	else if (m.method === "tools/list") send({ method: "notifications/noise" }), send({ id: m.id, result: { tools: [{ name: "echo" }] } });
	else if (m.params?.name === "crash") process.exit(3);
	else if (m.params?.name === "echo") send({ id: m.id, result: { content: [{ type: "text", text: m.params.arguments.msg }] } });
	else send({ id: m.id, error: { code: -32601, message: "unknown" } });
});
`;

const fake = () => new McpStdioClient(process.execPath, ["-e", FAKE_SERVER]);

test("initialize, list and call tools; notifications are ignored", async () => {
	const c = fake();
	try {
		await c.initialize();
		assert.deepEqual(await c.listTools(), [{ name: "echo" }]);
		assert.equal(resultText(await c.callTool("echo", { msg: "hi" })), "hi");
		await assert.rejects(c.callTool("nope", {}), /unknown \(-32601\)/);
	} finally {
		c.close();
	}
});

test("server exit rejects pending and later requests", async () => {
	const c = fake();
	await c.initialize();
	await assert.rejects(c.callTool("crash", {}), /exited \(3\)/);
	assert.equal(c.closed, true);
	await assert.rejects(c.listTools(), /not running/);
});

test("missing binary rejects with ENOENT", async () => {
	const c = new McpStdioClient("definitely-not-a-binary-xyz");
	await assert.rejects(c.initialize(), (err) => err.code === "ENOENT");
});

let hasJflow = true;
try {
	execFileSync("jflow", ["--version"], { stdio: "ignore" });
} catch {
	hasJflow = false;
}

test("real jflow mcp exposes its tools", { skip: !hasJflow && "jflow not on PATH" }, async () => {
	const c = new McpStdioClient("jflow", ["mcp"]);
	try {
		await c.initialize();
		const names = (await c.listTools()).map((t) => t.name);
		for (const n of ["list_epics", "new_task", "commit", "pr"]) assert.ok(names.includes(n), n);
	} finally {
		c.close();
	}
});

// Fake streamable-HTTP server: SSE replies with a leading comment and an
// unrelated notification, session id required after initialize.
async function fakeHttpServer() {
	const sessions = new Set();
	const seen = [];
	const server = http.createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		seen.push({ method: req.method, sid: req.headers["mcp-session-id"] });
		if (req.method === "DELETE") return res.writeHead(204).end();
		const m = JSON.parse(body);
		if (m.method !== "initialize" && !sessions.has(req.headers["mcp-session-id"])) {
			return res.writeHead(404).end("session not found");
		}
		if (m.id === undefined) return res.writeHead(202).end();
		const headers = { "content-type": "text/event-stream" };
		let result;
		if (m.method === "initialize") {
			headers["mcp-session-id"] = "s1";
			sessions.add("s1");
			result = { protocolVersion: "2025-06-18" };
		} else if (m.method === "tools/list") result = { tools: [{ name: "echo" }] };
		else if (m.params?.name === "echo") result = { content: [{ type: "text", text: m.params.arguments.msg }] };
		res.writeHead(200, headers);
		res.write(": ok\n\n");
		res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`);
		const reply = result
			? { jsonrpc: "2.0", id: m.id, result }
			: { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } };
		// Split across chunks to exercise buffering.
		const ev = `event: message\r\ndata: ${JSON.stringify(reply)}\r\n\r\n`;
		res.write(ev.slice(0, 10));
		setTimeout(() => res.end(ev.slice(10)), 5);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return { server, sessions, seen, url: `http://127.0.0.1:${server.address().port}/` };
}

test("http: initialize, list and call tools over SSE with session id", async () => {
	const { server, seen, url } = await fakeHttpServer();
	const c = new McpHttpClient(url);
	try {
		await c.initialize();
		assert.equal(c.sessionId, "s1");
		assert.deepEqual(await c.listTools(), [{ name: "echo" }]);
		assert.equal(resultText(await c.callTool("echo", { msg: "hi" })), "hi");
		await assert.rejects(c.callTool("nope", {}), /unknown \(-32601\)/);
		assert.equal(c.closed, false, "JSON-RPC errors keep the session");
		assert.deepEqual(seen.slice(1).map((s) => s.sid), ["s1", "s1", "s1", "s1"]);
	} finally {
		c.close();
		server.close();
	}
});

test("http: unknown session (server restart) closes the client so it reconnects", async () => {
	const { server, sessions, url } = await fakeHttpServer();
	const c = new McpHttpClient(url);
	try {
		await c.initialize();
		sessions.clear();
		await assert.rejects(c.listTools(), /MCP HTTP 404/);
		assert.equal(c.closed, true);
	} finally {
		server.close();
	}
});

test("http: unreachable server rejects and closes", async () => {
	const { server, url } = await fakeHttpServer();
	server.close();
	await once(server, "close");
	const c = new McpHttpClient(url);
	await assert.rejects(c.initialize(), (err) => err.code === "ECONNREFUSED");
	assert.equal(c.closed, true);
});

test("http: real jflow mcp --http exposes its tools", { skip: !hasJflow && "jflow not on PATH" }, async () => {
	const probe = http.createServer().listen(0, "127.0.0.1");
	await once(probe, "listening");
	const addr = `127.0.0.1:${probe.address().port}`;
	probe.close();
	await once(probe, "close");

	const child = spawn("jflow", ["mcp", "--http", addr], { stdio: "ignore" });
	try {
		let names;
		for (let i = 0; i < 50 && !names; i++) {
			const c = new McpHttpClient(`http://${addr}/`);
			try {
				await c.initialize();
				names = (await c.listTools()).map((t) => t.name);
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			} finally {
				c.close();
			}
		}
		assert.ok(names, "jflow mcp --http did not come up");
		for (const n of ["list_epics", "new_task", "commit", "pr"]) assert.ok(names.includes(n), n);
	} finally {
		child.kill();
	}
});

test("abortable: abort rejects a never-settling call; no signal or settled call passes through", async () => {
	const ac = new AbortController();
	const hung = abortable(new Promise(() => {}), ac.signal);
	ac.abort();
	await assert.rejects(hung, /aborted/);
	await assert.rejects(abortable(Promise.resolve(1), AbortSignal.abort()), /aborted/);
	assert.equal(await abortable(Promise.resolve(2), new AbortController().signal), 2);
	assert.equal(await abortable(Promise.resolve(3)), 3);
	await assert.rejects(abortable(Promise.reject(new Error("boom")), new AbortController().signal), /boom/);
});
