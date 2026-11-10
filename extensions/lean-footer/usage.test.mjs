import assert from "node:assert/strict";
import test from "node:test";

import { usageTotals } from "./usage.mjs";

const usage = (input, output, cacheRead, cacheWrite, total) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const assistant = (u) => ({ type: "message", message: { role: "assistant", usage: u } });

test("without a handoff the segment equals the session and covers every usage-carrying entry", () => {
	const r = usageTotals([
		{ type: "message", message: { role: "user", content: "go" } },
		assistant(usage(10, 20, 100, 0, 1)),
		{ type: "message", message: { role: "toolResult", usage: usage(1, 0, 0, 0, 0.5) } },
		{ type: "model_usage", purpose: "job-caption", usage: usage(5, 5, 0, 0, 0.25) },
		{ type: "compaction", method: "remote", usage: usage(0, 3, 0, 0, 0.25) },
		{ type: "custom" },
	]);
	assert.equal(r.handoffs, 0);
	assert.deepEqual(r.session, { input: 16, output: 28, cacheRead: 100, cacheWrite: 0, cost: 2 });
	assert.deepEqual(r.sinceHandoff, r.session);
});

test("a handoff restarts the segment; its own usage and remote compactions stay put", () => {
	const r = usageTotals([
		assistant(usage(10, 10, 0, 0, 5)),
		{ type: "compaction", method: "handoff", usage: usage(1, 1, 0, 0, 1) },
		assistant(usage(2, 3, 40, 10, 0.5)),
		{ type: "compaction", method: "remote" },
		assistant(usage(1, 1, 50, 0, 0.25)),
	]);
	assert.equal(r.handoffs, 1);
	assert.deepEqual(r.sinceHandoff, { input: 3, output: 4, cacheRead: 90, cacheWrite: 10, cost: 0.75 });
	assert.equal(r.session.cost, 6.75);
	assert.equal(r.cacheHit, (50 / 51) * 100);
});

test("only the last handoff counts", () => {
	const r = usageTotals([
		assistant(usage(1, 1, 0, 0, 1)),
		{ type: "compaction", method: "handoff" },
		assistant(usage(1, 1, 0, 0, 2)),
		{ type: "compaction", method: "handoff" },
	]);
	assert.equal(r.handoffs, 2);
	assert.deepEqual(r.sinceHandoff, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	assert.equal(r.session.cost, 3);
	assert.equal(r.cacheHit, 0);
});
