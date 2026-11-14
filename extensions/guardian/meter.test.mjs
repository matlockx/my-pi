import test from "node:test";
import assert from "node:assert/strict";

import { LOOP_BLOCK_AT, newMeter, onMessage, onToolCall, onToolResult, snapshot, sumSnapshots } from "./meter.mjs";

const text = (t) => [{ type: "text", text: t }];
let nextId = 0;

// Runs one tool call through the meter: tool_call, then (unless blocked) tool_result.
function call(meter, toolName, input, result, { isError = false, at = 0, end = at } = {}) {
	const toolCallId = `c${nextId++}`;
	const blocked = onToolCall(meter, { toolCallId, toolName, input }, at);
	if (blocked) return { blocked };
	return { note: onToolResult(meter, { toolCallId, toolName, input, content: text(result), isError }, end) };
}

test("onMessage sums cost, requests and tokens of assistant messages only", () => {
	const m = newMeter();
	onMessage(m, { role: "assistant", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, cost: { total: 0.25 } } });
	onMessage(m, { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } });
	onMessage(m, { role: "user", usage: { cost: { total: 9 } } });
	onMessage(m, { role: "assistant" });
	const s = snapshot(m);
	assert.equal(s.costUsd, 0.75);
	assert.equal(s.requests, 2);
	assert.deepEqual(s.tokens, { input: 11, output: 6, cacheRead: 100, cacheWrite: 2 });
});

test("an identical call and result gets a note from the third time and is blocked the fifth", () => {
	const m = newMeter();
	const input = { command: "go test ./..." };
	assert.equal(call(m, "bash", input, "FAIL").note, undefined);
	assert.equal(call(m, "bash", input, "FAIL").note, undefined);
	assert.match(call(m, "bash", input, "FAIL").note, /same result 3 times/);
	assert.match(call(m, "bash", input, "FAIL").note, /same result 4 times/);
	const fifth = call(m, "bash", input, "FAIL");
	assert.equal(fifth.blocked.block, true);
	assert.match(fifth.blocked.reason, /loop breaker/);
	assert.deepEqual(
		snapshot(m).loopBreaks.map((b) => [b.level, b.tool, b.count]),
		[["agent", "bash", LOOP_BLOCK_AT - 1]],
	);
});

test("a changed result restarts the count, so a re-read after an edit is not a loop", () => {
	const m = newMeter();
	const input = { path: "a.go" };
	call(m, "read", input, "v1");
	call(m, "read", input, "v1");
	assert.equal(call(m, "read", input, "v2").note, undefined);
	call(m, "read", input, "v2");
	assert.match(call(m, "read", input, "v2").note, /3 times/);
});

test("argument order does not make two identical calls different; wall-time lines are ignored", () => {
	const m = newMeter();
	call(m, "grep", { pattern: "x", path: "." }, "hit\nWall time: 1.0 seconds");
	call(m, "grep", { path: ".", pattern: "x" }, "hit\nWall time: 2.3 seconds");
	assert.match(call(m, "grep", { pattern: "x", path: "." }, "hit\nWall time: 0.4 seconds").note, /3 times/);
});

test("wait, todo and ask are never counted as loops", () => {
	const m = newMeter();
	for (let i = 0; i < 6; i++) {
		const r = call(m, "wait", {}, "still running");
		assert.equal(r.blocked, undefined);
		assert.equal(r.note, undefined);
	}
});

test("waste signals: third read of a path, repeated command, failed calls, edit retries, wait time", () => {
	const m = newMeter();
	call(m, "read", { path: "a.go" }, "1");
	call(m, "read", { path: "a.go" }, "2");
	call(m, "read", { path: "a.go" }, "3");
	call(m, "read", { path: "b.go" }, "1");
	call(m, "bash", { command: "make test" }, "ok 1");
	call(m, "bash", { command: "make test" }, "ok 2");
	call(m, "edit", { path: "a.go" }, "stale tag", { isError: true });
	call(m, "bash", { command: "false" }, "exit 1", { isError: true });
	call(m, "wait", {}, "done", { at: 1_000, end: 4_500 });
	assert.deepEqual(snapshot(m).waste, { repeatedReads: 1, repeatedCommands: 1, failedTools: 2, editRetries: 1, waitMs: 3_500 });
});

test("sumSnapshots adds figures and keeps every loop break", () => {
	const a = { costUsd: 0.1, requests: 1, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, waste: { repeatedReads: 1, repeatedCommands: 0, failedTools: 0, editRetries: 0, waitMs: 5 }, loopBreaks: [{ tool: "a" }] };
	const b = { costUsd: 0.2, requests: 2, tokens: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 }, waste: { repeatedReads: 0, repeatedCommands: 1, failedTools: 1, editRetries: 1, waitMs: 0 }, loopBreaks: [{ tool: "b" }] };
	const s = sumSnapshots([a, b]);
	assert.equal(s.costUsd, 0.3);
	assert.equal(s.requests, 3);
	assert.deepEqual(s.tokens, { input: 3, output: 3, cacheRead: 3, cacheWrite: 3 });
	assert.deepEqual(s.waste, { repeatedReads: 1, repeatedCommands: 1, failedTools: 1, editRetries: 1, waitMs: 5 });
	assert.deepEqual(s.loopBreaks.map((x) => x.tool), ["a", "b"]);
});
