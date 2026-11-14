import test from "node:test";
import assert from "node:assert/strict";

import {
	addLedgerEntry,
	effectText,
	estimateAccuracy,
	findingId,
	findingSummaries,
	findingText,
	guardianYield,
	improvementEffect,
	ledgerHashLines,
	ledgerItem,
	ledgerReport,
	mergeLedger,
	MAX_FINDING_TEXT,
	orchestratedRuns,
	pipelineFigures,
	rankOpen,
	retroDue,
} from "./ledger.mjs";

const DAY = 24 * 3_600_000;

// A prompt's run record; `orch` adds the orchestration summary of orchestrator run `orch.runId`.
const run = (runId, startedAt, costUsd, orch, extra = {}) => ({
	runId,
	startedAt,
	costUsd,
	requests: 1,
	mode: orch ? "orchestrated" : "off",
	workItems: [{ id: "ABC-1", kind: "jira", primary: true }],
	perAgent: [{ id: "Main", role: "main", costUsd }],
	...(orch ? { orchestration: { runId: orch.runId, lane: "plan", estimateUsd: 10, qaVerdicts: ["PASS"], builderRounds: 1, outcome: "applied", pipelineVersion: "v1", ...orch } } : {}),
	...extra,
});

test("findingText keeps one line without code, capped", () => {
	assert.equal(findingText("Builder:12 reread a.go\n```go\nsecret := 1\n```"), "Builder:12 reread a.go");
	assert.equal(findingText("```\nconst x = 1\n```\nreal reason"), "real reason");
	assert.equal(findingText("use `go test ./pkg`"), "use go test ./pkg");
	assert.equal(findingText("x".repeat(400)).length, MAX_FINDING_TEXT);
});

test("ledgerItem: findings get stable ids and clean text; runs and improvements need their id", () => {
	const f = { scope: "task", category: "navigation", severity: "MED", evidence: "Builder:3 read a.go 4 times", suggestion: "Add a DEV-NOTE pointer to a.go" };
	const out = ledgerItem("guardian-findings", { runIds: ["r1"], findings: [f], at: 5 }, 9);
	assert.equal(out.kind, "findings");
	assert.deepEqual(out.items.map((i) => [i.runIds, i.severity, i.foundAt]), [[["r1"], "MED", 5]]);
	assert.equal(out.items[0].id, findingId(f));
	assert.equal(findingId({ ...f, suggestion: "add a dev-note pointer to a.go", evidence: "Builder:7 read a.go 9 times" }), out.items[0].id, "wording case and line numbers do not split a finding");
	assert.equal(ledgerItem("guardian-run", { costUsd: 1 }, 0), undefined);
	assert.equal(ledgerItem("guardian-run", { runId: "r" }, 0).kind, "runs");
	assert.equal(ledgerItem("guardian-improvement", { id: "i" }, 7).item.date, 7);
	assert.equal(ledgerItem("other", { id: "i" }, 0), undefined);
});

test("findingSummaries: recurrence over distinct runs, status from the latest decision", () => {
	const f = (id, runIds, foundAt) => ({ id, runIds, foundAt, scope: "task", category: "c", severity: "LOW", evidence: "e", suggestion: "s" });
	const findings = [f("a", ["r1"], 1), f("a", ["r2"], 2), f("a", ["r2"], 3), f("b", ["r3"], 4)];
	const summaries = findingSummaries(findings, [
		{ id: "i1", date: 10, findingIds: ["b"], decision: "deferred" },
		{ id: "i2", date: 20, findingIds: ["b"], decision: "applied" },
	]);
	assert.deepEqual(summaries.map((s) => [s.id, s.recurrence, s.status]), [["a", 2, "open"], ["b", 1, "applied"]]);
});

test("rankOpen orders by saving (or severity weight) times recurrence", () => {
	const s = (id, severity, recurrence, estSavingUsd) => ({ id, severity, recurrence, estSavingUsd, status: "open" });
	assert.deepEqual(rankOpen([s("low-often", "LOW", 5), s("high-once", "HIGH", 1), s("saving", "LOW", 1, 4), { ...s("done", "HIGH", 9), status: "applied" }]).map((x) => x.id), ["low-often", "saving", "high-once"]);
});

test("retroDue fires at 10 open findings, or after 7 days without a decision", () => {
	const open = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), status: "open" }));
	const now = 100 * DAY;
	assert.match(retroDue(open(10), [{ date: now }], now), /10 Guardian findings/);
	assert.equal(retroDue(open(3), [{ date: now - DAY }], now), undefined);
	assert.match(retroDue(open(3), [{ date: now - 8 * DAY }], now), /over 7 days/);
	assert.equal(retroDue([], [], now), undefined);
});

test("orchestratedRuns sums the prompts of one orchestrator run; estimateAccuracy takes the median ratio", () => {
	const runs = [run("p1", 1, 4, { runId: "o1" }), run("p2", 2, 8, { runId: "o1" }), run("p3", 3, 30, { runId: "o2", estimateUsd: 20 }), run("p4", 4, 5, undefined)];
	const o = orchestratedRuns(runs);
	assert.deepEqual(o.map((r) => [r.id, r.costUsd, r.prompts, r.qaFirstPass]), [["o1", 12, 2, true], ["o2", 30, 1, true]]);
	assert.deepEqual(estimateAccuracy(runs), { ratio: 1.35, runs: 2 });
	assert.equal(estimateAccuracy([run("p", 1, 5, { runId: "o", outcome: "open" })]), undefined);
});

test("improvementEffect compares runs before and after, and says when there is not enough data", () => {
	const date = 100;
	const many = (from, cost, pass) => Array.from({ length: 5 }, (_, i) => run(`p${from + i}`, from + i, cost, { runId: `o${from + i}`, qaVerdicts: [pass ? "PASS" : "FAIL"] }));
	const runs = [...many(0, 10, false), ...many(200, 6, true)];
	const e = improvementEffect({ date, scope: "pipeline" }, runs);
	assert.deepEqual([e.enough, e.before.cost, e.after.cost, e.before.firstPass, e.after.firstPass], [true, 10, 6, 0, 1]);
	assert.deepEqual(improvementEffect({ date, scope: "pipeline" }, runs.slice(0, 7)), { enough: false, before: 5, after: 2 });
	assert.equal(improvementEffect({ date, scope: "task", project: "other" }, runs).enough, false, "task scope counts the project's runs only");
});

test("ledgerReport views: runs by work item and role, open findings, improvements with effect", () => {
	const runs = [run("p1", 10, 4, { runId: "o1" }, { project: "api", perAgent: [{ role: "main", costUsd: 1 }, { role: "implementer", costUsd: 3 }] })];
	const runsText = ledgerReport({ runs, findings: [], improvements: [], view: "runs", groupBy: ["workItem", "role"], since: 0, until: 100 });
	assert.match(runsText, /\| ABC-1 · implementer \| 1 \| 0 \| 3\.00 \|/);
	assert.match(runsText, /\| o1 \| ABC-1 \| plan \| \$10\.00 \| \$4\.00 \| 0\.40x \| yes \|/);
	assert.throws(() => ledgerReport({ runs, findings: [], improvements: [], view: "runs", groupBy: ["session"], since: 0, until: 100 }), /unknown session/);
	const findings = [{ id: "f1", runIds: ["p1"], foundAt: 20, scope: "task", category: "navigation", severity: "HIGH", evidence: "B:2", suggestion: "pointer" }];
	assert.match(ledgerReport({ runs, findings, improvements: [], view: "findings", groupBy: [], since: 0, until: 100 }), /\| f1 \| task \| navigation \| HIGH \| 1 \|/);
	assert.match(ledgerReport({ runs, findings, improvements: [{ id: "i", date: 30, decision: "applied", scope: "pipeline", change: { summary: "smaller QA model" }, findingIds: ["f1"] }], view: "improvements", groupBy: [], since: 0, until: 100 }), /applied \(pipeline\): smaller QA model — findings f1; effect: not enough data/);
	assert.throws(() => ledgerReport({ runs, findings, improvements: [], view: "nope", groupBy: [], since: 0, until: 1 }), /view: unknown nope/);
	assert.throws(() => ledgerReport({ runs, findings, improvements: [], view: "constructor", groupBy: [], since: 0, until: 1 }), /view: unknown constructor/);
});

test("pipelineFigures: lanes, roles, estimate ratio, waste and work items of the period only", () => {
	const runs = [
		run("p1", 10, 4, { runId: "o1", lane: "quick", estimateUsd: undefined, qaVerdicts: [] }, { perAgent: [{ role: "implementer", costUsd: 4 }], waste: { repeatedReads: 2 } }),
		run("p2", 20, 12, { runId: "o2" }, { perAgent: [{ role: "planner", costUsd: 2 }, { role: "implementer", costUsd: 10 }] }),
		run("p3", 30, 3, undefined, { workItems: [] }),
		run("late", 999, 50, { runId: "o3" }),
	];
	const p = pipelineFigures({ runs, findings: [], improvements: [], start: 0, end: 100 });
	assert.equal(p.prompts, 3);
	assert.deepEqual(p.lanes.map((l) => [l.lane, l.runs, l.cost, l.judged]), [["plan", 1, 12, 1], ["quick", 1, 4, 0]]);
	assert.deepEqual(p.roles, [{ name: "implementer", value: 14 }, { name: "planner", value: 2 }, { name: "main", value: 3 }].sort((a, b) => b.value - a.value));
	assert.equal(p.estimateRatio, 1.2);
	assert.equal(p.offCost, 3);
	assert.equal(p.waste.repeatedReads, 2);
	assert.deepEqual(p.workItems.map((w) => [w.id, w.cost, w.lanes]), [["ABC-1", 16, ["quick", "plan"]], ["no work item", 3, []]]);
});

test("guardianYield reads the yield data as an object or as a JSON string, and rejects anything without findings", () => {
	const data = { runIds: ["r1", 2], findings: [{ category: "x" }], runSummary: "s" };
	const expected = { runIds: ["r1", "2"], findings: [{ category: "x" }] };
	assert.deepEqual(guardianYield(data), expected);
	assert.deepEqual(guardianYield(JSON.stringify(data)), expected, "models often pass yield data as a string");
	assert.deepEqual(guardianYield({ findings: [] }), { runIds: [], findings: [] });
	for (const bad of [undefined, "not json", "[1]", { runIds: ["r1"] }]) assert.equal(guardianYield(bad), undefined);
});

test("a guardian finding is normalised: unknown severity reads LOW, unknown scope pipeline, a non-number saving is dropped", () => {
	const ledger = { runs: [], findings: [], improvements: [] };
	addLedgerEntry(ledger, "guardian-findings", { runIds: ["r1"], findings: [{ severity: "CRITICAL", scope: "x", estSavingUsd: "lots" }, "junk"], at: 7 }, 99);
	addLedgerEntry(ledger, "guardian-run", { runId: "r1" }, 8);
	addLedgerEntry(ledger, "guardian-improvement", { id: "i1", date: 3 }, 9);
	addLedgerEntry(ledger, "guardian-track", { item: null }, 9);
	assert.deepEqual(ledger.findings.map((f) => [f.severity, f.scope, f.category, f.estSavingUsd, f.foundAt, f.runIds]), [["LOW", "pipeline", "other", undefined, 7, ["r1"]]]);
	assert.deepEqual([ledger.runs.length, ledger.improvements[0].date], [1, 3]);
	assert.deepEqual(ledgerItem("guardian-findings", { findings: "no" }, 1), { kind: "findings", items: [] });
});

test("mergeLedger keeps the latest run per id, tags findings with session and project, skips logs without a ledger", () => {
	const log = (sessionId, ledger) => ({ sessionId, parsed: { ledger } });
	const merged = mergeLedger(
		[log("s1", { runs: [{ runId: "r", costUsd: 1 }], findings: [{ id: "f" }], improvements: [{ id: "i", v: 1 }] }), log("s2", undefined), log("s3", { runs: [{ runId: "r", costUsd: 2 }], findings: [], improvements: [{ id: "i", v: 2 }] })],
		(l) => `p-${l.sessionId}`,
	);
	assert.deepEqual(merged.runs, [{ runId: "r", costUsd: 2, project: "p-s3" }]);
	assert.deepEqual(merged.findings, [{ id: "f", sessionId: "s1", project: "p-s1" }]);
	assert.deepEqual(merged.improvements, [{ id: "i", v: 2 }]);
});

test("the runs view: group all, roles of a record without agents, an orchestrated run without estimate or QA", () => {
	const runs = [run("p1", 10, 4, { runId: "o1", estimateUsd: undefined, qaVerdicts: ["FAIL"], outcome: undefined }, { perAgent: undefined })];
	const text = (groupBy) => ledgerReport({ runs, findings: [], improvements: [], view: "runs", groupBy, since: 0, until: 100 });
	assert.match(text([]), /## Prompts by all\n[^]*\| all \| 1 \| 1 \| 4\.00 \|/);
	assert.match(text(["role"]), /\| o1 \| ABC-1 \| plan \| {2}\| \$4\.00 \| {2}\| no \| 1 \| 0 \| 0 \| {2}\| {2}\|/);
	assert.doesNotMatch(text(["role"]), /\| main/);
	assert.equal(ledgerReport({ runs, findings: [], improvements: [], view: "runs", groupBy: [], since: 50, until: 100 }), "No run records in the window.");
	assert.match(ledgerReport({ runs: [run("a", 1, 1), run("b", 2, 2, undefined, { workItems: [] })], findings: [], improvements: [], view: "runs", groupBy: ["workItem"], since: 0, until: 9, top: 1 }), /\| \(1 more\) \| \| \| 1\.00 \|/);
});

test("the improvements view names the project, no findings as none, and a measured effect", () => {
	const many = (from, cost) => Array.from({ length: 5 }, (_, i) => run(`p${from + i}`, from + i, cost, { runId: `o${from + i}` }, { project: "api" }));
	const runs = [...many(0, 10), ...many(200, 6)];
	const text = ledgerReport({ runs, findings: [], improvements: [{ id: "i", date: 100, decision: "applied", scope: "task", project: "api" }], view: "improvements", groupBy: [], since: 0, until: 300 });
	assert.match(text, /applied \(task, api\):  — findings none; effect: cost per run \$10\.00 → \$6\.00; QA first pass 100% → 100%/);
	assert.equal(ledgerReport({ runs, findings: [], improvements: [], view: "improvements", groupBy: [], since: 0, until: 300 }), "No improvement decisions in the window.");
	assert.equal(effectText({ enough: true, before: { cost: 1 }, after: { cost: 2 } }), "cost per run $1.00 → $2.00; QA first pass n/a → n/a");
	assert.equal(ledgerReport({ runs, findings: [], improvements: [], view: "findings", groupBy: [], since: 0, until: 1 }), "No open Guardian findings in the window.");
});

test("ledgerHashLines: runs of the window, findings before its end, every decision; none without a ledger", () => {
	const ledger = { runs: [run("in", 5, 1), run("out", 50, 1)], findings: [{ id: "f", foundAt: 5 }, { id: "late", foundAt: 99 }], improvements: [{ id: "i", decision: "applied" }] };
	const lines = ledgerHashLines(ledger, (t) => t < 10, 10);
	assert.deepEqual(lines.map((l) => JSON.parse(l)[0] + ":" + JSON.parse(l)[2]), ["run:in", "finding:f", "improvement:i"]);
	assert.deepEqual(ledgerHashLines(undefined, () => true, 1), []);
});
