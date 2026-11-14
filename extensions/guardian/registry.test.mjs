import test from "node:test";
import assert from "node:assert/strict";

import { newMeter, onMessage, onToolCall, onToolResult } from "./meter.mjs";
import { buildRunRecord, endAgent, joinRun, registry, startRun } from "./registry.mjs";

const costly = (usd) => {
	const m = newMeter();
	onMessage(m, { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: usd } } });
	return m;
};

test("the registry is shared per scope and created once", () => {
	const scope = {};
	assert.equal(registry(scope), registry(scope));
	assert.notEqual(registry(scope), registry({}));
});

test("the run record sums the main session and the subagents of this run only", () => {
	const reg = registry({});
	startRun(reg, { runId: "r1", sessionId: "s", startedAt: 1 });
	joinRun(reg, { id: "Old", role: "task", meter: costly(9) });
	startRun(reg, { runId: "r2", sessionId: "s", startedAt: 2 });
	assert.equal(joinRun(reg, { id: "Builder", role: "implementer", meter: costly(1.5) }), "r2");
	joinRun(reg, { id: "QA", role: "qa", meter: costly(0.5) });
	endAgent(reg, "Builder");

	const record = buildRunRecord({
		run: reg.run, mode: "off", mainMeter: costly(0.25), agents: [...reg.agents.values()],
		branch: "ABC-1", workItems: [{ id: "ABC-1", kind: "jira", source: "branch", primary: true }], endedAt: 3,
	});
	assert.equal(record.costUsd, 2.25);
	assert.equal(record.requests, 3);
	assert.deepEqual(
		record.perAgent.map((a) => [a.id, a.role, a.costUsd, a.running]),
		[["Main", "main", 0.25, false], ["Builder", "implementer", 1.5, false], ["QA", "qa", 0.5, true]],
	);
	assert.deepEqual([record.runId, record.mode, record.startedAt, record.endedAt, record.branch], ["r2", "off", 2, 3, "ABC-1"]);
});

test("loop breaks carry the agent they happened in", () => {
	const reg = registry({});
	startRun(reg, { runId: "r", sessionId: "s", startedAt: 0 });
	const sub = newMeter();
	for (let i = 0; i < 5; i++) {
		const toolCallId = `c${i}`;
		if (onToolCall(sub, { toolCallId, toolName: "bash", input: { command: "x" } }, 0)) break;
		onToolResult(sub, { toolCallId, toolName: "bash", input: { command: "x" }, content: [{ type: "text", text: "same" }], isError: false }, 0);
	}
	joinRun(reg, { id: "Builder", role: "implementer", meter: sub });
	const record = buildRunRecord({ run: reg.run, mode: "off", mainMeter: newMeter(), agents: [...reg.agents.values()], workItems: [], endedAt: 1 });
	assert.deepEqual(record.loopBreaks.map((b) => [b.agent, b.tool]), [["Builder", "bash"]]);
});

test("starting a run drops ended agents of earlier runs and keeps running ones", () => {
	const reg = registry({});
	startRun(reg, { runId: "r1", sessionId: "s", startedAt: 0 });
	joinRun(reg, { id: "Done", role: "task", meter: newMeter() });
	joinRun(reg, { id: "Busy", role: "task", meter: newMeter() });
	endAgent(reg, "Done");
	startRun(reg, { runId: "r2", sessionId: "s", startedAt: 1 });
	assert.deepEqual([...reg.agents.keys()], ["Busy"]);
});
