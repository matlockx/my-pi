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

test("the previous-period link appears only when older data gives that period a report", () => {
	assert.doesNotMatch(render([row("t", "p")]), /← 2026-W44/, "oldest report");
	assert.match(render([row("t", "p"), { ...row("t", "p"), hour: period.start - 30 * 24 * HOUR_MS }]), /href="\.\.\/weekly\/2026-W44\.html">← 2026-W44/);
});

test("plain drops icon glyphs, niceMax rounds axis tops up", () => {
	assert.equal(plain("\u{F099D} SCOPE: review"), "SCOPE: review", "supplementary private-use plane");
	assert.equal(plain("\uE75C JIRA: find"), "JIRA: find");
	assert.equal(plain("🧾 TAX"), "🧾 TAX", "emoji stay");
	assert.deepEqual([niceMax(0), niceMax(87), niceMax(441), niceMax(2.1)], [1, 100, 500, 2.5]);
});
