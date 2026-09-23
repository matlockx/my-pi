import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { McpStdioClient, resultText } from "./client.mjs";

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
