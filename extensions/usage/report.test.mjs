import assert from "node:assert/strict";
import test from "node:test";

import { HOUR_MS } from "./parse.mjs";
import { buildReport, limitDelta, parseWindow } from "./report.mjs";

const NOW = Date.parse("2026-11-13T12:30:00.000Z");
const H = (n) => NOW - n * HOUR_MS;
const hourOf = (t) => Math.floor(t / HOUR_MS) * HOUR_MS;
const row = (t, extra) => ({
	hour: hourOf(t),
	sessionId: "01a1a136-0000-0000-0000-000000000001",
	project: "shop",
	title: "Fix bug",
	agent: "main",
	feature: "user",
	provider: "anthropic",
	model: "claude-opus-5-5",
	account: "A",
	requests: 1,
	input: 10,
	output: 10,
	cacheRead: 100,
	cacheWrite: 0,
	cost: 1,
	premium: 0,
	...extra,
});
const snap = (t, limitId, usedFraction, resetsAt, window) => ({ recordedAt: t, provider: "anthropic", account: "A", limitId, label: limitId, window, usedFraction, resetsAt });
const p = (t, usedFraction) => ({ recordedAt: t, usedFraction });

test("parseWindow accepts limit windows, last:<N>h|d and ISO ranges, and rejects the rest", () => {
	assert.deepEqual(parseWindow("5h", NOW), { limit: "5 Hour", until: NOW });
	assert.deepEqual(parseWindow("last:3h", NOW), { since: H(3), until: NOW });
	assert.deepEqual(parseWindow("last:2d", NOW), { since: H(48), until: NOW });
	assert.deepEqual(parseWindow("2026-11-13T00:00:00Z..", NOW), { since: Date.parse("2026-11-13T00:00:00Z"), until: NOW });
	assert.throws(() => parseWindow("2026-11-13..2026-11-12", NOW), /window/);
	assert.throws(() => parseWindow("yesterday", NOW), /window/);
});

test("limitDelta measures from the last value before the window and counts through a reset", () => {
	const points = [p(H(6), 0.5), p(H(4), 0.6), p(H(3), 0.9), p(H(2), 0.1), p(H(1), 0.3)];
	assert.ok(Math.abs(limitDelta(points, H(5), NOW) - (0.1 + 0.3 + 0.1 + 0.2)) < 1e-9);
	assert.ok(Math.abs(limitDelta(points, H(2.5), NOW) - 0.3) < 1e-9, "no baseline gap: 0.9 -> 0.1 is a reset");
	assert.ok(Math.abs(limitDelta(points.slice(1), H(10), NOW) - (0.3 + 0.1 + 0.2)) < 1e-9, "no value before: the first is the baseline");
});

test("the current 5h window splits the limit's value by cost share and tells sessions apart", () => {
	const resets = NOW + 2 * HOUR_MS;
	const text = buildReport({
		rows: [
			row(H(2), { cost: 3 }),
			row(H(1), { cost: 1, sessionId: "01a1a136-0000-0000-0000-000000000002", title: "Review PR", feature: "jflow-watch" }),
			row(H(5), { cost: 100 }),
		],
		snapshots: [snap(H(0.5), "anthropic:5h", 0.4, resets, "5 Hour"), snap(H(0.5), "anthropic:7d", 0.6, NOW + 50 * HOUR_MS, "7 Day")],
		labels: { A: "anthropic: me" },
		now: NOW,
		window: "5h",
		groupBy: ["session", "feature"],
	});
	assert.match(text, /## anthropic: me/);
	assert.match(text, /anthropic:5h: now 40\.0%.*used in window \+40\.0%/);
	assert.match(text, /\| Fix bug \[00000001\] · user \| 1 \|.*\| 75\.0% \| 30\.0% \|/);
	assert.match(text, /\| Review PR \[00000002\] · jflow-watch \|.*\| 25\.0% \| 10\.0% \|/);
	assert.doesNotMatch(text, /100\.00/, "the row before the window start is outside");
});

test("Copilot groups are weighted by premium requests, not by cost", () => {
	const copilot = { provider: "github-copilot", account: "C", model: "gpt-6" };
	const text = buildReport({
		rows: [row(H(1), { ...copilot, cost: 9, premium: 1, feature: "a" }), row(H(1), { ...copilot, cost: 1, premium: 3, feature: "b" })],
		snapshots: [],
		labels: {},
		now: NOW,
		window: "last:5h",
		groupBy: ["feature"],
	});
	assert.match(text, /\| b \|.*\| 75\.0% \|/);
});

test("limit use far above the usual rate per tracked cost is flagged as untracked usage", () => {
	const closed = (end, used) => [snap(end - 4 * HOUR_MS, "anthropic:5h", used / 2, end, "5 Hour"), snap(end - HOUR_MS, "anthropic:5h", used, end, "5 Hour")];
	const rows = [];
	const snapshots = [];
	for (const day of [2, 3, 4]) {
		const end = NOW - day * 24 * HOUR_MS;
		rows.push(row(end - 2 * HOUR_MS, { cost: 10 }));
		snapshots.push(...closed(end, 0.1));
	}
	rows.push(row(H(1), { cost: 10 }));
	snapshots.push(snap(H(0.5), "anthropic:5h", 0.5, NOW + HOUR_MS, "5 Hour"));
	const text = buildReport({ rows, snapshots, labels: {}, now: NOW, window: "5h", groupBy: ["session"] });
	assert.match(text, /5\.0x the usual/);
	const normal = buildReport({ rows, snapshots: [...snapshots.slice(0, -1), snap(H(0.5), "anthropic:5h", 0.1, NOW + HOUR_MS, "5 Hour")], labels: {}, now: NOW, window: "5h", groupBy: ["session"] });
	assert.doesNotMatch(normal, /usual/);
});

test("unknown group keys are rejected with the allowed list", () => {
	assert.throws(
		() => buildReport({ rows: [], snapshots: [], labels: {}, now: NOW, window: "5h", groupBy: ["colour"] }),
		/groupBy: unknown colour; use account/,
	);
});
