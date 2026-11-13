import assert from "node:assert/strict";
import test from "node:test";

import { completedPeriods, digest, isReady, lastSeen, MAX_WAIT_MS, pace, periodOf, timeAbove } from "./digest.mjs";
import { HOUR_MS } from "./parse.mjs";

const TZ = "Europe/Berlin";
const iso = (ms) => new Date(ms).toISOString();

test("periods follow local midnight across a DST change and use ISO week keys", () => {
	const day = periodOf("daily", Date.parse("2026-10-25T12:00:00Z"), TZ);
	assert.deepEqual([day.key, iso(day.start), iso(day.end)], ["2026-10-25", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"], "25-hour day");
	const week = periodOf("weekly", Date.parse("2026-11-13T12:00:00Z"), TZ);
	assert.deepEqual([week.key, iso(week.start), iso(week.end)], ["2026-W46", "2026-11-08T23:00:00.000Z", "2026-11-15T23:00:00.000Z"]);
	assert.equal(periodOf("weekly", Date.parse("2027-01-01T12:00:00Z"), TZ).key, "2026-W53", "a Friday 1 January belongs to the old year");
	assert.equal(periodOf("weekly", Date.parse("2026-01-01T12:00:00Z"), TZ).key, "2026-W01", "a Thursday 1 January starts week 1");
	const month = periodOf("monthly", Date.parse("2026-03-31T22:30:00Z"), TZ);
	assert.deepEqual([month.key, iso(month.start), iso(month.end)], ["2026-04", "2026-03-31T22:00:00.000Z", "2026-04-30T22:00:00.000Z"], "local time decides the month");
});

test("completed periods exclude the current one and go back the backfill count", () => {
	const keys = completedPeriods(Date.parse("2026-11-13T12:00:00Z"), TZ).map((p) => p.key);
	assert.deepEqual(keys.slice(0, 2), ["2026-11-12", "2026-11-11"]);
	assert.deepEqual(keys.slice(7), ["2026-W45", "2026-W44", "2026-W43", "2026-W42", "2026-10", "2026-09"]);
});

test("a period is ready once every active device synced after its end, or after the maximum wait", () => {
	const period = periodOf("daily", Date.parse("2026-11-12T12:00:00Z"), TZ);
	const rows = [{ device: "a", hour: period.start + HOUR_MS }, { device: "b", hour: period.start + 2 * HOUR_MS }];
	const synced = (b) => lastSeen(rows, [{ device: "a", recordedAt: period.end + 1 }, { device: "b", recordedAt: b }]);
	assert.equal(isReady(period, rows, synced(period.end + 5), period.end + HOUR_MS), true);
	assert.equal(isReady(period, rows, synced(period.end - 5), period.end + HOUR_MS), false, "b may still push rows of the period");
	assert.equal(isReady(period, rows, synced(period.end - 5), period.end + MAX_WAIT_MS), true, "no device blocks a report forever");
	assert.equal(isReady(period, rows, synced(period.end + 5), period.end - 1), false, "never before the period ends");
});

test("time at a level counts only inside the period and caps sleep gaps at two hours", () => {
	const at = (h, v) => ({ recordedAt: h * HOUR_MS, usedFraction: v });
	const points = [at(0, 1), at(1, 1), at(2, 0.5), at(3, 1), at(10, 0.2)];
	assert.equal(timeAbove(points, 1, 0, 24 * HOUR_MS), 4 * HOUR_MS, "0-2 h, then 3-5 h of a 7-hour gap");
	assert.equal(timeAbove(points, 1, 0.5 * HOUR_MS, 24 * HOUR_MS), 3.5 * HOUR_MS);
	assert.equal(timeAbove(points, 0.9, 0, 0), 0);
});

test("pace projects the window's average rate and stays silent early in a window", () => {
	const week = 7 * 24 * HOUR_MS;
	const point = (elapsedH, used) => ({ recordedAt: elapsedH * HOUR_MS, usedFraction: used, resetsAt: week, window: "7 Day" });
	const half = pace(point(84, 0.6));
	assert.equal(half.atReset.toFixed(2), "1.20");
	assert.equal(half.fullAt, 140 * HOUR_MS, "100% after 84 h / 0.6");
	assert.equal(pace(point(84, 0.3)).fullAt, undefined, "60% at reset never reaches 100%");
	assert.equal(pace(point(6, 0.2)), undefined, "6 h of a week is too little to project");
	assert.equal(pace(point(84, 0)), undefined);
});

test("digest sums the period, splits automation, drops idle limits and flags unlabelled accounts", () => {
	const period = periodOf("daily", Date.parse("2026-11-12T12:00:00Z"), TZ);
	const row = (h, feature, cost, account = "acc") => ({
		hour: period.start + h * HOUR_MS,
		sessionId: `s-${feature}`,
		project: "shop",
		title: "Fix <b>",
		agent: "main",
		feature,
		provider: "anthropic",
		model: "m",
		account,
		device: "a",
		requests: 1,
		input: 10,
		output: 5,
		cacheRead: 90,
		cacheWrite: 0,
		cost,
		premium: 0,
	});
	const rows = [row(9, "user", 3), row(10, "quick-review-fix", 1), row(11, "command:/review", 1, "other-hash"), row(-2, "user", 7)];
	const snap = (h, limitId, v) => ({ device: "a", account: "acc", limitId, label: limitId, window: "5 Hour", recordedAt: period.start + h * HOUR_MS, usedFraction: v, resetsAt: period.start + 20 * HOUR_MS });
	const limits = [snap(9, "5h", 0.2), snap(12, "5h", 0.6), snap(9, "fable", 0), snap(12, "fable", 0)];
	const d = digest({ period, rows, limits, labels: { acc: "anthropic: me" }, tz: TZ, now: period.end + HOUR_MS, generator: "a" });
	assert.equal(d.totals.cost, 5);
	assert.equal(d.previousTotals.cost, 7);
	assert.equal(d.totals.cacheHit, 0.9);
	assert.equal(d.automatic, 1, "slash commands count as your prompts");
	const [mine, other] = d.accounts;
	assert.deepEqual([mine.label, mine.labelled, mine.limits.map((l) => [l.id, l.peak])], ["anthropic: me", true, [["5h", 0.6]]]);
	assert.deepEqual([other.label, other.labelled], ["account other-ha", false]);
	assert.deepEqual(
		d.timeline.filter((b) => b.value).map((b) => [b.label, b.value]),
		[
			["09", 3],
			["10", 1],
			["11", 1],
		],
	);
});
