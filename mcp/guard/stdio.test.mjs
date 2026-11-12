import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";

import { createGuard } from "./guard.mjs";
import { PROTOCOL_VERSION, StdioBridge } from "./stdio.mjs";

// Fake stdio MCP server. Reports every method it receives on stderr as "seen <method>".
// Tools: read_x and delete_file (two tools/list pages), echo, slow, ask_client (sends the
// client a ping, a roots/list and a notification, returns the answers), die (exits 3).
const FAKE = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const waiting = new Map();
process.stdout.write("starting fake server\\n");
rl.on("line", (line) => {
	const m = JSON.parse(line);
	if (m.method === undefined) { waiting.get(m.id)?.(m); return; }
	process.stderr.write("seen " + m.method + "\\n");
	if (m.id === undefined) return;
	const ok = (result) => send({ jsonrpc: "2.0", id: m.id, result });
	const text = (t) => ok({ content: [{ type: "text", text: JSON.stringify(t) }] });
	if (m.method === "initialize") return ok({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake" } });
	if (m.method === "tools/list") return m.params?.cursor
		? ok({ tools: [{ name: "delete_file", annotations: { destructiveHint: true } }] })
		: ok({ tools: [{ name: "read_x", annotations: { readOnlyHint: true } }], nextCursor: "p2" });
	const { name, arguments: args } = m.params;
	if (name === "echo") return text(args);
	if (name === "slow") return setTimeout(() => text(args), 150);
	if (name === "die") process.exit(3);
	if (name === "ask_client") {
		const answers = [];
		const ask = (id, method) => new Promise((r) => { waiting.set(id, r); send({ jsonrpc: "2.0", id, method }); });
		send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } });
		return ask("s1", "ping").then((a) => answers.push(a)).then(() => ask("s2", "roots/list")).then((a) => { answers.push(a); text(answers); });
	}
	send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } });
});
`;

/** Started bridge to a fresh fake server; seen lists the methods the server received. */
async function startBridge(t) {
	const child = spawn(process.execPath, ["-e", FAKE], { stdio: ["pipe", "pipe", "pipe"] });
	const seen = [];
	child.stderr.setEncoding("utf8").on("data", (s) => seen.push(...s.match(/(?<=seen ).+/g)));
	t.after(() => child.kill());
	const bridge = new StdioBridge(child);
	await bridge.start();
	return { bridge, child, seen };
}

/** Guard for "github" in front of bridge; the dialog answers answer and records prompts. */
async function startGuard(t, bridge, answer = "deny") {
	const prompts = [];
	const guard = createGuard({
		server: "github",
		policy: { owners: ["matlockx"], tools: bridge.tools },
		forward: bridge.forward,
		confirm: async (text) => (prompts.push(text), answer),
		log: () => {},
	});
	guard.listen(0, "127.0.0.1");
	await once(guard, "listening");
	t.after(() => guard.close());
	return { port: guard.address().port, prompts };
}

/** Sends method with body to the guard; resolves status and text. */
function send(port, method, body) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, method, path: "/mcp", headers: { "content-type": "application/json" } },
			(res) => {
				let text = "";
				res.setEncoding("utf8").on("data", (c) => (text += c));
				res.on("end", () => resolve({ status: res.statusCode, text }));
			},
		);
		req.on("error", reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const textOf = (answer) => JSON.parse(answer.result.content[0].text);

test("start initialises once, lists every tools/list page and keeps the annotations", async (t) => {
	const { bridge, seen } = await startBridge(t);

	assert.deepEqual(seen, ["initialize", "notifications/initialized", "tools/list", "tools/list"]);
	assert.equal(bridge.initResult.protocolVersion, PROTOCOL_VERSION);
	assert.deepEqual([...bridge.tools], [
		["read_x", { readOnlyHint: true }],
		["delete_file", { destructiveHint: true }],
	]);
});

test("a client initialize is answered from the cache; notifications get 202 and reach nobody", async (t) => {
	const { bridge, seen } = await startBridge(t);
	const g = await startGuard(t, bridge);
	seen.length = 0;

	const init = await send(g.port, "POST", { jsonrpc: "2.0", id: "c1", method: "initialize", params: {} });
	const note = await send(g.port, "POST", { jsonrpc: "2.0", method: "notifications/initialized" });

	assert.deepEqual(JSON.parse(init.text), { jsonrpc: "2.0", id: "c1", result: bridge.initResult });
	assert.equal(note.status, 202);
	assert.deepEqual(seen, []);
});

test("concurrent calls with the same client id each get their own answer", async (t) => {
	const { bridge } = await startBridge(t);
	const g = await startGuard(t, bridge);

	const [slow, fast] = await Promise.all([
		send(g.port, "POST", call(1, "slow", { who: "slow" })),
		send(g.port, "POST", call(1, "echo", { who: "fast" })),
	]);

	assert.deepEqual(textOf(JSON.parse(slow.text)), { who: "slow" });
	assert.deepEqual(textOf(JSON.parse(fast.text)), { who: "fast" });
	assert.equal(JSON.parse(slow.text).id, 1);
});

test("a batch is answered as an array without entries for its notifications", async (t) => {
	const { bridge } = await startBridge(t);
	const g = await startGuard(t, bridge);

	const res = await send(g.port, "POST", [{ jsonrpc: "2.0", method: "notifications/cancelled" }, call(5, "echo", { n: 5 })]);

	const answers = JSON.parse(res.text);
	assert.equal(answers.length, 1);
	assert.equal(answers[0].id, 5);
	assert.deepEqual(textOf(answers[0]), { n: 5 });
});

test("a denied call never reaches the server; an approved one does", async (t) => {
	const { bridge, seen } = await startBridge(t);
	const denied = await startGuard(t, bridge, "deny");
	seen.length = 0;
	const del = call(9, "delete_file", { owner: "matlockx", repo: "r", path: "p", branch: "b", message: "m" });

	const res = await send(denied.port, "POST", del);

	assert.equal(JSON.parse(res.text).result.isError, true);
	assert.equal(denied.prompts.length, 1);
	assert.deepEqual(seen, []);

	const approved = await startGuard(t, bridge, "allow");
	await send(approved.port, "POST", del);
	assert.deepEqual(seen, ["tools/call"]);
});

test("server requests are answered by the bridge: ping with a result, anything else with an error", async (t) => {
	const { bridge } = await startBridge(t);
	const g = await startGuard(t, bridge);

	const res = await send(g.port, "POST", call(2, "ask_client"));

	const [ping, roots] = textOf(JSON.parse(res.text));
	assert.deepEqual(ping, { jsonrpc: "2.0", id: "s1", result: {} });
	assert.equal(roots.id, "s2");
	assert.equal(roots.error.code, -32601);
	assert.match(roots.error.message, /^roots\/list is not supported behind the MCP guard$/);
});

test("GET and DELETE get 405", async (t) => {
	const { bridge } = await startBridge(t);
	const g = await startGuard(t, bridge);

	assert.equal((await send(g.port, "GET")).status, 405);
	assert.equal((await send(g.port, "DELETE")).status, 405);
});

test("a server exit answers pending calls with an error and emits exit", async (t) => {
	const { bridge } = await startBridge(t);
	const g = await startGuard(t, bridge);
	const exited = once(bridge, "exit");

	const res = await send(g.port, "POST", call(3, "die"));

	const answer = JSON.parse(res.text);
	assert.equal(answer.id, 3);
	assert.equal(answer.error.code, -32603);
	assert.match(answer.error.message, /^MCP server exited \(3\)$/);
	assert.deepEqual(await exited, [3, null]);
});
