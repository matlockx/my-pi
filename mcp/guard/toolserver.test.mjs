import test from "node:test";
import assert from "node:assert/strict";

import { handleMessage } from "./toolserver.mjs";

const TOOLS = [{ name: "ok_tool" }, { name: "bad_tool" }];
const server = {
	tools: TOOLS,
	serverInfo: { name: "fake", version: "1" },
	handlers: { ok_tool: async (args) => ({ got: args }), bad_tool: async () => { throw new Error("boom"); } },
};
const msg = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

test("handleMessage answers initialize, tools/list and tools/call; tool errors become isError results", async () => {
	assert.equal((await handleMessage(server, msg(1, "initialize", {}))).result.serverInfo.name, "fake");
	assert.deepEqual((await handleMessage(server, msg(2, "tools/list"))).result.tools, TOOLS);
	const ok = await handleMessage(server, msg(3, "tools/call", { name: "ok_tool", arguments: { a: 1 } }));
	assert.deepEqual(JSON.parse(ok.result.content[0].text), { got: { a: 1 } });
	const err = await handleMessage(server, msg(4, "tools/call", { name: "bad_tool" }));
	assert.deepEqual(err.result, { content: [{ type: "text", text: "boom" }], isError: true });
	assert.equal((await handleMessage(server, msg(5, "tools/call", { name: "nope" }))).error.code, -32602);
	assert.equal((await handleMessage(server, msg(6, "tools/call", { name: "toString" }))).error.code, -32602);
	assert.equal((await handleMessage(server, msg(7, "resources/list"))).error.code, -32601);
	assert.equal(await handleMessage(server, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
});
