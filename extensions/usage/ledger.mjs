/**
 * Guardian ledger: run records, Guardian findings and improvement decisions read from omp session
 * logs (custom entries written by the guardian and orchestrator extensions), and the figures the
 * report, the pages and the retro need. Free of omp APIs, like parse.mjs.
 *
 * Entries (spec notes/specs/2026-11-14-orchestrator-mode.md, "Ledger and optimisation"):
 * - `guardian-run`: one per main-session prompt, rewritten when rated; the latest per `runId` wins.
 *   `orchestration` is present while orchestrator mode was on and names the orchestrator run.
 * - `guardian-findings`: written by a `guardian` subagent: `{ runIds, findings[], at }`.
 * - `guardian-improvement`: written by the `guardian_decision` tool: one retro decision.
 */

import { createHash } from "node:crypto";

import { yieldObject } from "../shared/agent.mjs";

export const LEDGER_TYPES = { "guardian-run": "runs", "guardian-findings": "findings", "guardian-improvement": "improvements" };
export const LEDGER_VIEWS = ["runs", "findings", "improvements"];
export const RUN_GROUP_KEYS = ["workItem", "lane", "mode", "pipelineVersion", "role", "project", "outcome"];
/** Fewer runs than this on either side of an improvement: its effect is "not enough data". */
export const MIN_EFFECT_RUNS = 5;
export const REMIND_OPEN_FINDINGS = 10;
export const REMIND_AFTER_MS = 7 * 24 * 3_600_000;

const normalise = (text) => String(text ?? "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const fileOf = (evidence) => /^([\w./-]+\.\w+)(?::\d+)?/.exec(String(evidence ?? ""))?.[1] ?? "";

/** Stable id of a finding: its scope, category, file and normalised suggestion. */
export function findingId(f) {
	const text = [f.scope, f.category, fileOf(f.evidence), normalise(f.suggestion)].join("\u001f");
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Longest evidence or suggestion text kept; a reference plus one sentence fits easily. */
export const MAX_FINDING_TEXT = 300;

/**
 * Evidence and suggestions leave the machine (agent-usage repository), so they are cut to one line
 * without code blocks: the first line of the text, backticks removed, at most MAX_FINDING_TEXT.
 */
export function findingText(text) {
	const firstLine = String(text ?? "").replace(/```[\s\S]*?(```|$)/g, " ").split("\n").find((l) => l.trim()) ?? "";
	const line = firstLine.replace(/`/g, "").replace(/\s+/g, " ").trim();
	return line.length > MAX_FINDING_TEXT ? `${line.slice(0, MAX_FINDING_TEXT - 1)}…` : line;
}

/**
 * Run ids and findings of a `guardian` subagent's `yield` data: an object, or the same object as
 * a JSON string. Undefined when the data is neither or holds no findings array.
 */
export function guardianYield(data) {
	const value = yieldObject(data);
	if (!value || !Array.isArray(value.findings)) return undefined;
	return { runIds: Array.isArray(value.runIds) ? value.runIds.map(String) : [], findings: value.findings };
}

const SEVERITIES = ["HIGH", "MED", "LOW"];

// One finding of a guardian result, normalised for the ledger.
function findingRow(f, runIds, foundAt) {
	return {
		id: findingId(f),
		runIds,
		scope: f.scope === "task" ? "task" : "pipeline",
		category: String(f.category ?? "other"),
		severity: SEVERITIES.includes(f.severity) ? f.severity : "LOW",
		evidence: findingText(f.evidence),
		suggestion: findingText(f.suggestion),
		estSavingUsd: Number.isFinite(f.estSavingUsd) ? f.estSavingUsd : undefined,
		foundAt,
	};
}

const ITEM_OF = {
	runs: (data) => (data.runId ? { kind: "runs", item: data } : undefined),
	improvements: (data, at) => (data.id ? { kind: "improvements", item: { ...data, date: data.date ?? at } } : undefined),
	findings: (data, at) => {
		const parsed = guardianYield(data) ?? { runIds: [], findings: [] };
		const rows = parsed.findings.filter((f) => f && typeof f === "object");
		return { kind: "findings", items: rows.map((f) => findingRow(f, parsed.runIds, data.at ?? at)) };
	},
};

/** Ledger items of one session log's custom entries, by kind. `at` is the entry time in ms. */
export function ledgerItem(customType, data, at) {
	const make = ITEM_OF[LEDGER_TYPES[customType]];
	return make && data && typeof data === "object" ? make(data, at) : undefined;
}

/** Adds the ledger item of one custom entry, if it is one, to `ledger` (parse.mjs `parseEntries`). */
export function addLedgerEntry(ledger, customType, data, at) {
	const found = ledgerItem(customType, data, at);
	if (!found) return;
	if (found.items) ledger.findings.push(...found.items);
	else ledger[found.kind].push(found.item);
}

/** A ledger without items. */
export const NO_LEDGER = { runs: [], findings: [], improvements: [] };

/**
 * Input-hash lines of the ledger data a period report shows: run records whose start passes
 * `inside`, findings before `end`, every decision. None without a ledger.
 */
export function ledgerHashLines(ledger, inside, end) {
	if (!ledger) return [];
	return [
		...ledger.runs.filter((r) => inside(r.startedAt)).map((r) => JSON.stringify(["run", r.device, r.runId, r.costUsd, r.rating ?? null, r.orchestration?.outcome ?? null])),
		...ledger.findings.filter((f) => f.foundAt < end).map((f) => JSON.stringify(["finding", f.device, f.id, f.foundAt])),
		...ledger.improvements.map((i) => JSON.stringify(["improvement", i.device, i.id, i.decision])),
	];
}

/**
 * Ledger of parsed logs (parse.mjs `parseEntries` output plus the log identity). Runs take their
 * root session's project and title; findings their session and project.
 */
export function mergeLedger(logs, projectOf) {
	const runs = new Map();
	const findings = [];
	const improvements = new Map();
	for (const log of logs) {
		const project = projectOf(log);
		const ledger = log.parsed.ledger ?? NO_LEDGER;
		for (const run of ledger.runs) runs.set(run.runId, { ...run, project });
		for (const f of ledger.findings) findings.push({ ...f, sessionId: log.sessionId, project });
		for (const imp of ledger.improvements) improvements.set(imp.id, imp);
	}
	return { runs: [...runs.values()], findings, improvements: [...improvements.values()] };
}

/** Key of a stored finding row: one row per finding per sighting. */
export const findingKey = (f) => `${f.id}\u001f${f.foundAt}`;

/** Findings grouped by id: latest wording, recurrence (distinct runs), status from the decisions. */
export function findingSummaries(findings, improvements) {
	const decided = new Map();
	for (const imp of [...improvements].sort((a, b) => a.date - b.date)) for (const id of imp.findingIds ?? []) decided.set(id, imp.decision);
	const byId = new Map();
	for (const f of [...findings].sort((a, b) => a.foundAt - b.foundAt)) {
		const s = byId.get(f.id) ?? { ...f, runs: new Set(), firstAt: f.foundAt };
		for (const r of f.runIds) s.runs.add(r);
		byId.set(f.id, { ...s, ...f, runs: s.runs, firstAt: s.firstAt });
	}
	const statusOf = { applied: "applied", rejected: "rejected", deferred: "open" };
	return [...byId.values()].map((s) => ({
		...s,
		recurrence: Math.max(1, s.runs.size),
		status: statusOf[decided.get(s.id)] ?? "open",
		runs: undefined,
	}));
}

/** Open findings ranked by cost x recurrence (estimated saving, else severity weight). */
export function rankOpen(summaries) {
	const weight = { HIGH: 3, MED: 2, LOW: 1 };
	const score = (s) => (s.estSavingUsd ?? weight[s.severity] ?? 1) * s.recurrence;
	return summaries.filter((s) => s.status === "open").sort((a, b) => score(b) - score(a));
}

/** Whether the session-start reminder fires: 10 open findings, or open ones and no decision for 7 days. */
export function retroDue(summaries, improvements, now) {
	const open = summaries.filter((s) => s.status === "open").length;
	if (open >= REMIND_OPEN_FINDINGS) return `${open} Guardian findings wait for review`;
	if (open === 0) return undefined;
	const last = Math.max(0, ...improvements.map((i) => i.date ?? 0));
	return now - last >= REMIND_AFTER_MS ? `${open} Guardian finding(s) open and no retro for over 7 days` : undefined;
}

// Figures of one orchestration summary; the latest prompt's summary of a run wins.
function summaryFigures(o) {
	return {
		lane: o.lane,
		estimateUsd: o.estimateUsd,
		verdicts: o.qaVerdicts ?? [],
		rounds: o.builderRounds ?? 0,
		replans: (o.replans ?? []).length,
		loopBreaks: (o.loopBreaks ?? []).length,
		outcome: o.outcome,
		pipelineVersion: o.pipelineVersion,
	};
}

/**
 * Orchestrated runs: run records of one orchestrator run (several prompts) summed. Returns
 * `{ id, lane, estimateUsd, costUsd, qaFirstPass, rounds, outcome, pipelineVersion, ... }`.
 */
export function orchestratedRuns(runs) {
	const byId = new Map();
	for (const r of runs) {
		const o = r.orchestration;
		if (!o?.runId) continue;
		const into = byId.get(o.runId) ?? { id: o.runId, costUsd: 0, startedAt: r.startedAt, workItem: primaryItem(r), project: r.project, prompts: 0 };
		const cost = into.costUsd + (r.costUsd ?? 0);
		byId.set(o.runId, { ...into, ...summaryFigures(o), costUsd: cost, prompts: into.prompts + 1, startedAt: Math.min(into.startedAt, r.startedAt), rating: r.rating ?? into.rating });
	}
	return [...byId.values()].map((r) => ({ ...r, qaFirstPass: r.verdicts.length ? r.verdicts[0] === "PASS" : undefined }));
}

function primaryItem(run) {
	return run.workItems?.find((w) => w.primary)?.id ?? "no work item";
}

function median(values) {
	const v = [...values].sort((a, b) => a - b);
	if (!v.length) return undefined;
	const m = Math.floor(v.length / 2);
	return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Accuracy of the planner's estimates over the latest `limit` finished plan runs: median actual /
 * estimate, or undefined without data.
 */
export function estimateAccuracy(runs, limit = 20) {
	const done = orchestratedRuns(runs)
		.filter((r) => r.lane === "plan" && r.estimateUsd > 0 && r.outcome && r.outcome !== "open")
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, limit);
	const ratio = median(done.map((r) => r.costUsd / r.estimateUsd));
	return ratio === undefined ? undefined : { ratio, runs: done.length };
}

/**
 * Measured effect of an improvement: median cost per orchestrated run and QA first-pass rate before
 * and after its date (task scope: runs of its project only). "not enough data" below
 * MIN_EFFECT_RUNS runs on either side.
 */
export function improvementEffect(improvement, runs) {
	const scoped = orchestratedRuns(runs).filter((r) => improvement.scope !== "task" || !improvement.project || r.project === improvement.project);
	const before = scoped.filter((r) => r.startedAt < improvement.date);
	const after = scoped.filter((r) => r.startedAt >= improvement.date);
	if (before.length < MIN_EFFECT_RUNS || after.length < MIN_EFFECT_RUNS) return { enough: false, before: before.length, after: after.length };
	const side = (list) => {
		const judged = list.filter((r) => r.qaFirstPass !== undefined);
		return { cost: median(list.map((r) => r.costUsd)), firstPass: judged.length ? judged.filter((r) => r.qaFirstPass).length / judged.length : undefined, n: list.length };
	};
	return { enough: true, before: side(before), after: side(after) };
}

const GROUP_VALUE = {
	workItem: (run) => primaryItem(run),
	lane: (run) => run.orchestration?.lane ?? "(off)",
	mode: (run) => run.mode ?? "off",
	pipelineVersion: (run) => run.orchestration?.pipelineVersion ?? "(off)",
	outcome: (run) => run.orchestration?.outcome ?? "(off)",
	project: (run) => run.project ?? "(none)",
};

// Group names of one run record; with key role, one entry per agent of the run.
function groupedCosts(run, groupBy) {
	const names = (keys) => keys.filter((k) => GROUP_VALUE[k]).map((k) => GROUP_VALUE[k](run));
	if (!groupBy.includes("role")) return [{ name: names(groupBy).join(" · ") || "all", cost: run.costUsd ?? 0, requests: run.requests ?? 0 }];
	const other = names(groupBy);
	return (run.perAgent ?? []).map((a) => ({ name: [...other, a.role].join(" · "), cost: a.costUsd ?? 0, requests: a.requests ?? 0 }));
}

const usd = (v) => `$${(v ?? 0).toFixed(2)}`;

function runsTable(runs, groupBy, top) {
	const rows = new Map();
	for (const run of runs) {
		for (const { name, cost, requests } of groupedCosts(run, groupBy)) {
			const g = rows.get(name) ?? { name, cost: 0, requests: 0, runs: new Set() };
			rows.set(name, { ...g, cost: g.cost + cost, requests: g.requests + requests, runs: g.runs.add(run.runId) });
		}
	}
	const sorted = [...rows.values()].sort((a, b) => b.cost - a.cost);
	const lines = ["| group | prompts | requests | $ (API eq.) |", "|---|---|---|---|"];
	for (const g of sorted.slice(0, top)) lines.push(`| ${g.name} | ${g.runs.size} | ${g.requests} | ${g.cost.toFixed(2)} |`);
	if (sorted.length > top) lines.push(`| (${sorted.length - top} more) | | | ${sorted.slice(top).reduce((s, g) => s + g.cost, 0).toFixed(2)} |`);
	return lines.join("\n");
}

const yesNo = (v) => (v === undefined ? "" : v ? "yes" : "no");

// One row of the orchestrated runs table.
function orchestratedRow(r) {
	const ratio = r.estimateUsd > 0 ? `${(r.costUsd / r.estimateUsd).toFixed(2)}x` : "";
	const estimate = r.estimateUsd > 0 ? usd(r.estimateUsd) : "";
	return `| ${r.id.slice(0, 8)} | ${r.workItem} | ${r.lane} | ${estimate} | ${usd(r.costUsd)} | ${ratio} | ${yesNo(r.qaFirstPass)} | ${r.rounds} | ${r.replans} | ${r.loopBreaks} | ${r.outcome ?? ""} | ${r.rating ?? ""} |`;
}

function orchestratedTable(runs, top) {
	const list = orchestratedRuns(runs).sort((a, b) => b.startedAt - a.startedAt).slice(0, top);
	if (!list.length) return "No orchestrated runs in the window.";
	const head = ["| run | work item | lane | estimate | actual | ratio | QA first pass | rounds | replans | loop breaks | outcome | rating |", "|---|---|---|---|---|---|---|---|---|---|---|---|"];
	return [...head, ...list.map(orchestratedRow)].join("\n");
}

function runsView({ runs, groupBy, inside, top }) {
	const bad = groupBy.filter((k) => !RUN_GROUP_KEYS.includes(k));
	if (bad.length) throw new Error(`groupBy for view runs: unknown ${bad.join(", ")}; use ${RUN_GROUP_KEYS.join(", ")}`);
	const list = runs.filter((r) => inside(r.startedAt));
	if (!list.length) return "No run records in the window.";
	return [`## Prompts by ${groupBy.join(", ") || "all"}`, runsTable(list, groupBy, top), "", "## Orchestrated runs", orchestratedTable(list, top)].join("\n");
}

function findingsView({ findings, improvements, inside, top }) {
	const ranked = rankOpen(findingSummaries(findings.filter((f) => inside(f.foundAt)), improvements));
	if (!ranked.length) return "No open Guardian findings in the window.";
	const head = ["| id | scope | category | severity | seen in runs | est. saving | suggestion | evidence |", "|---|---|---|---|---|---|---|---|"];
	const row = (f) => `| ${f.id} | ${f.scope} | ${f.category} | ${f.severity} | ${f.recurrence} | ${f.estSavingUsd === undefined ? "" : usd(f.estSavingUsd)} | ${f.suggestion} | ${f.evidence} |`;
	return [...head, ...ranked.slice(0, top).map(row)].join("\n");
}

const pctOr = (v) => (v === undefined ? "n/a" : `${Math.round(v * 100)}%`);

/** Text of an improvement's measured effect (an `improvementEffect` result). */
export function effectText(e) {
	if (!e.enough) return `not enough data (${e.before} runs before, ${e.after} after)`;
	return `cost per run ${usd(e.before.cost)} → ${usd(e.after.cost)}; QA first pass ${pctOr(e.before.firstPass)} → ${pctOr(e.after.firstPass)}`;
}

function improvementLine(i, runs) {
	const where = i.project ? `${i.scope}, ${i.project}` : i.scope;
	const ids = (i.findingIds ?? []).join(", ") || "none";
	return `- ${new Date(i.date).toISOString().slice(0, 10)} ${i.decision} (${where}): ${i.change?.summary ?? ""} — findings ${ids}; effect: ${effectText(improvementEffect(i, runs))}`;
}

function improvementsView({ runs, improvements, inside }) {
	const list = improvements.filter((i) => inside(i.date)).sort((a, b) => b.date - a.date);
	if (!list.length) return "No improvement decisions in the window.";
	return list.map((i) => improvementLine(i, runs)).join("\n");
}

const VIEWS = { runs: runsView, findings: findingsView, improvements: improvementsView };

/**
 * Text report of the ledger for `usage_report` with `view` runs, findings or improvements.
 *
 * @param {{runs: any[], findings: any[], improvements: any[], view: string, groupBy: string[],
 *   since: number, until: number, top?: number}} input
 */
export function ledgerReport(input) {
	const view = Object.hasOwn(VIEWS, input.view) ? VIEWS[input.view] : undefined;
	if (!view) throw new Error(`view: unknown ${input.view}; use hourly, ${LEDGER_VIEWS.join(", ")}`);
	const { since, until } = input;
	return view({ ...input, inside: (t) => t >= since && t < until, top: input.top ?? 15 });
}

function laneFigures(orchestrated) {
	const byLane = new Map();
	for (const r of orchestrated) {
		const g = byLane.get(r.lane) ?? { lane: r.lane, runs: 0, cost: 0, judged: 0, passed: 0 };
		const judged = r.qaFirstPass === undefined ? 0 : 1;
		byLane.set(r.lane, { ...g, runs: g.runs + 1, cost: g.cost + r.costUsd, judged: g.judged + judged, passed: g.passed + (r.qaFirstPass ? 1 : 0) });
	}
	return [...byLane.values()].sort((a, b) => b.cost - a.cost);
}

function workItemFigures(prompts) {
	const work = new Map();
	for (const r of prompts) {
		const id = primaryItem(r);
		const g = work.get(id) ?? { id, cost: 0, prompts: 0, lanes: new Set() };
		if (r.orchestration?.lane) g.lanes.add(r.orchestration.lane);
		work.set(id, { ...g, cost: g.cost + (r.costUsd ?? 0), prompts: g.prompts + 1 });
	}
	return [...work.values()].map((w) => ({ ...w, lanes: [...w.lanes] })).sort((a, b) => b.cost - a.cost);
}

function roleCosts(prompts) {
	const out = new Map();
	for (const r of prompts) for (const a of r.perAgent ?? []) out.set(a.role, (out.get(a.role) ?? 0) + (a.costUsd ?? 0));
	return [...out].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

const WASTE_KEYS = ["repeatedReads", "repeatedCommands", "failedTools", "editRetries"];

/**
 * Figures of the Pipeline section and the Work items table of one period [start, end). `runs` are
 * run records, `findings` finding rows, `improvements` decisions (all devices).
 */
export function pipelineFigures({ runs, findings, improvements, start, end }) {
	const inside = (t) => t >= start && t < end;
	const prompts = runs.filter((r) => inside(r.startedAt));
	const orchestrated = orchestratedRuns(prompts);
	const total = (list) => list.reduce((s, r) => s + (r.costUsd ?? 0), 0);
	return {
		prompts: prompts.length,
		orchestratedCost: total(orchestrated),
		offCost: total(prompts.filter((r) => r.mode !== "orchestrated")),
		lanes: laneFigures(orchestrated),
		roles: roleCosts(prompts),
		estimateRatio: median(orchestrated.filter((r) => r.estimateUsd > 0).map((r) => r.costUsd / r.estimateUsd)),
		loopBreaks: prompts.reduce((n, r) => n + (r.loopBreaks ?? []).length, 0),
		waste: Object.fromEntries(WASTE_KEYS.map((k) => [k, prompts.reduce((n, r) => n + (r.waste?.[k] ?? 0), 0)])),
		openFindings: rankOpen(findingSummaries(findings.filter((f) => f.foundAt < end), improvements)).slice(0, 5),
		improvements: improvements.filter((i) => inside(i.date)).sort((a, b) => a.date - b.date),
		workItems: workItemFigures(prompts),
	};
}
