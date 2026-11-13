import assert from "node:assert/strict";
import test from "node:test";

import { digest, inputHash, isReady, lastSeen, MAX_WAIT_MS, pace, periodOf, reportPeriods, timeAbove } from "./digest.mjs";
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

test("report periods run from the oldest data; the running week and month stop at their last ready day", () => {
	const now = Date.parse("2026-11-13T12:00:00Z");
	const plan = (ready) => reportPeriods(Date.parse("2026-10-30T12:00:00Z"), now, TZ, ready);
	const keys = (periods, kind) => periods.filter((p) => p.kind === kind).map((p) => (p.cutoff ? `${p.key}<${iso(p.cutoff)}` : p.key));
	const all = plan(() => true);
	const days = keys(all, "daily");
	assert.deepEqual([days.length, days[0], days.at(-1)], [14, "2026-10-30", "2026-11-12"], "today is not reported until it ends");
	assert.deepEqual(keys(all, "weekly"), ["2026-W44", "2026-W45", "2026-W46<2026-11-12T23:00:00.000Z"], "W46 runs up to the end of 12 November");
	assert.deepEqual(keys(all, "monthly"), ["2026-10", "2026-11<2026-11-12T23:00:00.000Z"]);
	assert.deepEqual(keys(all, "yearly"), ["2026<2026-11-12T23:00:00.000Z"]);
	const [allTime] = all.filter((p) => p.kind === "alltime");
	assert.deepEqual([allTime.key, iso(allTime.start), iso(allTime.end), allTime.cutoff], ["all", "2026-10-29T23:00:00.000Z", "2026-11-12T23:00:00.000Z", allTime.end], "from the oldest day to the last ready one");

	const thursdayPending = plan((p) => p.key !== "2026-11-12");
	assert.deepEqual(keys(thursdayPending, "weekly").at(-1), "2026-W46<2026-11-11T23:00:00.000Z", "a day not ready yet holds the cutoff back");
	const mondayPending = plan((p) => p.key !== "2026-11-09");
	assert.deepEqual(keys(mondayPending, "weekly").at(-1), "2026-W45", "no ready day yet: no running report");
	const weekPending = plan((p) => p.key !== "2026-W45");
	assert.deepEqual(keys(weekPending, "weekly").slice(1, 2), ["2026-W45<2026-11-08T23:00:00.000Z"], "an ended week waiting for a device stays running");
});

test("the input hash ignores order and data outside the period and the one before", () => {
	const period = periodOf("daily", Date.parse("2026-11-12T12:00:00Z"), TZ);
	const row = (h, cost) => ({ hour: period.start + h * HOUR_MS, sessionId: "s", agent: "main", feature: "user", provider: "anthropic", model: "m", account: "acc", device: "a", project: "p", title: "t", requests: 1, cost });
	const snap = { device: "a", account: "acc", limitId: "5h", recordedAt: period.start + HOUR_MS, usedFraction: 0.2 };
	const base = inputHash(period, [row(2, 1), row(-3, 2)], [snap], { acc: "me" }, TZ);
	assert.equal(inputHash(period, [row(-3, 2), row(2, 1), row(-48, 9)], [snap], { acc: "me", other: "x" }, TZ), base, "reordered, older row, unused label");
	assert.notEqual(inputHash(period, [row(2, 1), row(-3, 5)], [snap], { acc: "me" }, TZ), base, "the previous day feeds the KPI comparison");
	assert.notEqual(inputHash(period, [row(2, 1), row(-3, 2)], [{ ...snap, usedFraction: 0.3 }], { acc: "me" }, TZ), base);
	assert.notEqual(inputHash(period, [row(2, 1), row(-3, 2)], [snap], { acc: "renamed" }, TZ), base);
	assert.notEqual(inputHash(period, [row(2, 1), row(-3, 2), { ...row(2, 1), device: "b" }], [snap], { acc: "me" }, TZ), base, "a new device's rows");
	assert.notEqual(inputHash({ ...period, cutoff: period.start + 3 * HOUR_MS }, [row(2, 1), row(-3, 2)], [snap], { acc: "me" }, TZ), base, "a running version differs from the final one");
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
	assert.deepEqual(
		digest({ period, rows: [row(9, "user", 2), { ...row(10, "user", 1), provider: "github-copilot" }], limits: [], labels: {}, tz: TZ, now: period.end, generator: "a" }).models,
		[
			{ name: "anthropic/m", value: 2 },
			{ name: "github-copilot/m", value: 1 },
		],
		"one model name at two providers stays two rows",
	);
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

test("a running month covers the data up to its cutoff and compares with the same span of the month before", () => {
	const month = periodOf("monthly", Date.parse("2026-11-13T12:00:00Z"), TZ);
	const running = { ...month, cutoff: month.start + 3 * 24 * HOUR_MS };
	const row = (start, days, cost, account = "acc") => ({ hour: start + days * 24 * HOUR_MS, sessionId: "s", project: "p", title: "t", agent: "main", feature: "user", provider: "anthropic", model: "m", account, device: "a", requests: 1, cost });
	const october = periodOf("monthly", month.start - 1, TZ).start;
	const rows = [row(month.start, 1, 4), row(month.start, 5, 50), row(october, 2, 6), row(october, 20, 90), row(month.start, 2, 1, "unpinned:anthropic")];
	const d = digest({ period: running, rows, limits: [], labels: {}, tz: TZ, now: month.start + 4 * 24 * HOUR_MS, generator: "a" });
	assert.equal(d.totals.cost, 5, "5 November is after the cutoff");
	assert.equal(d.previousTotals.cost, 6, "only 1 to 3 October");
	assert.equal(d.dataEnd, running.cutoff);
	assert.deepEqual(
		d.accounts.map((a) => a.label),
		["account acc", "anthropic, login not recorded"],
	);
	assert.equal(d.firstSnapshot, Number.POSITIVE_INFINITY);
});
