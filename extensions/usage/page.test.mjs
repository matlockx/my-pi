import assert from "node:assert/strict";
import test from "node:test";

import { digest, periodOf } from "./digest.mjs";
import { niceMax, plain, renderIndex, renderReport } from "./page.mjs";
import { HOUR_MS } from "./parse.mjs";

const TZ = "Europe/Berlin";
const period = periodOf("weekly", Date.parse("2026-11-05T12:00:00Z"), TZ);
const row = (title, project) => ({
	hour: period.start + 30 * HOUR_MS,
	sessionId: "s1",
	project,
	title,
	agent: "main",
	feature: "user",
	provider: "anthropic",
	model: "m",
	account: "acc",
	device: "mac",
	requests: 2,
	input: 1,
	output: 1,
	cacheRead: 1,
	cacheWrite: 1,
	cost: 4,
	premium: 0,
});
const render = (rows, labels = {}) => renderReport(digest({ period, rows, limits: [], labels, tz: TZ, now: period.end + HOUR_MS, generator: "mac<1>" }));

test("text from the repository is escaped wherever the page shows it", () => {
	const html = render([row(`<img src=x onerror=alert(1)>`, `"><script>x</script>`)], { acc: "<b>me</b>" });
	assert.doesNotMatch(html, /<img src=x|<script>x|<b>me<\/b>|mac<1>/);
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
	assert.match(html, /&quot;&gt;&lt;script&gt;x&lt;\/script&gt;/);
	assert.doesNotMatch(html, /<script/, "the page has no script at all");
});

test("a period without requests or limits renders the empty state, not empty charts", () => {
	const html = render([]);
	assert.match(html, /No tracked usage/);
	assert.doesNotMatch(html, /class="chart"/);
});

test("the index links every report kind and says when one has none yet", () => {
	const html = renderIndex({ daily: ["2026-11-12"], weekly: [], monthly: ["2026-10"] });
	assert.match(html, /href="daily\/2026-11-12\.html"/);
	assert.match(html, /href="monthly\/2026-10\.html"/);
	assert.match(html, /None yet\./);
});

test("a running report says how far its data goes, compares by the same point, and the index marks it", () => {
	const html = renderReport(digest({ period: { ...period, cutoff: period.start + 2 * 24 * HOUR_MS }, rows: [row("t", "p")], limits: [], labels: {}, tz: TZ, now: period.end, generator: "mac" }));
	assert.match(html, /Running · data up to and including Tue 3 Nov · updated daily/);
	assert.match(html, /by this point the week before/);
	const index = renderIndex({ weekly: ["2026-W45", "2026-W44"] }, new Set(["weekly/2026-W45.html"]));
	assert.match(index, /2026-W45<em class="badge">running<\/em>/);
	assert.doesNotMatch(index, /2026-W44<em/);
});

test("accounts without limit snapshots share one line that says why, and an unnamed one says how to name it", () => {
	const hash = "4ba3e6bc9315b1b2b3ea166a5b43e172864b00c2e6befe6e27046b64082b4085";
	const later = { device: "mac", account: "x", limitId: "5h", recordedAt: period.end + 9 * 24 * HOUR_MS, usedFraction: 0.1 };
	const html = renderReport(digest({ period, rows: [{ ...row("t", "p"), account: hash }, { ...row("t", "p"), account: "unpinned:anthropic" }], limits: [later], labels: {}, tz: TZ, now: period.end, generator: "mac" }));
	assert.match(html, /No limit snapshots exist yet for this period: the oldest in the repository is from 18 Nov 2026/);
	assert.match(html, /anthropic, login not recorded/);
	assert.match(html, new RegExp(`account 4ba3e6bc has no name\\.</b> No device is logged in to this account in omp any more.*${hash}`));
	assert.doesNotMatch(html, /No limit use recorded/);
});

test("the previous link needs older data, the next link needs the next period's report", () => {
	assert.doesNotMatch(render([row("t", "p")]), /← 2026-W44/, "oldest report");
	assert.match(render([row("t", "p"), { ...row("t", "p"), hour: period.start - 30 * 24 * HOUR_MS }]), /href="\.\.\/weekly\/2026-W44\.html">← 2026-W44/);
	assert.doesNotMatch(render([row("t", "p")]), /2026-W46 →/);
	const linked = renderReport(digest({ period, rows: [row("t", "p")], limits: [], labels: {}, tz: TZ, now: period.end, generator: "mac", hasNext: true }));
	assert.match(linked, /href="\.\.\/weekly\/2026-W46\.html">2026-W46 →/);
});

test("the all-time report has no comparison or neighbour links, and charts months and every day", () => {
	const start = period.start;
	const allTime = { kind: "alltime", key: "all", start, end: start + 40 * 24 * HOUR_MS, cutoff: start + 40 * 24 * HOUR_MS };
	const html = renderReport(digest({ period: allTime, rows: [row("t", "p"), { ...row("t", "p"), hour: start + 35 * 24 * HOUR_MS }], limits: [], labels: {}, tz: TZ, now: allTime.end, generator: "mac" }));
	assert.match(html, /All time · since 2 November 2026/);
	assert.match(html, /since 2 Nov 2026<\/span>/);
	assert.doesNotMatch(html, /class="delta|← |→<\/a>/);
	assert.match(html, /Cost per month/);
	assert.match(html, /Active on 2 of 39 days since the first active one · busiest 2026-11-03 with \$4\.00/);
	assert.match(renderIndex({ alltime: ["all"] }), /href="alltime\/all\.html"/);
});

test("plain drops icon glyphs, niceMax rounds axis tops up", () => {
	assert.equal(plain("\u{F099D} SCOPE: review"), "SCOPE: review", "supplementary private-use plane");
	assert.equal(plain("\uE75C JIRA: find"), "JIRA: find");
	assert.equal(plain("🧾 TAX"), "🧾 TAX", "emoji stay");
	assert.deepEqual([niceMax(0), niceMax(87), niceMax(441), niceMax(2.1)], [1, 100, 500, 2.5]);
});
