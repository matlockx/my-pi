import assert from "node:assert/strict";
import test from "node:test";

import { agentOf, yieldObject } from "./agent.mjs";

test("agentOf: omp subagent contexts name the agent; everything else is the main agent", () => {
	assert.deepEqual(agentOf({ agent: { kind: "sub", id: "B1", name: "implementer" } }), { kind: "sub", id: "B1", name: "implementer" });
	assert.deepEqual(agentOf({ agent: { kind: "sub" } }), { kind: "sub", id: "sub", name: "sub" });
	for (const ctx of [{}, { agent: { kind: "main" } }, { agent: "sub" }, undefined]) assert.equal(agentOf(ctx).kind, "main");
});

test("yieldObject accepts the object or its JSON string and nothing else", () => {
	assert.deepEqual(yieldObject({ status: "done" }), { status: "done" });
	assert.deepEqual(yieldObject('{"status":"paused"}'), { status: "paused" });
	for (const bad of [undefined, null, "not json", "[1]", [1], 3]) assert.equal(yieldObject(bad), undefined);
});
