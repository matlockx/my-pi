/**
 * Usage report for the `usage_report` tool: per account, the limits and how much of each the
 * window used, and a table of the groups (session, feature, model, …) that used it.
 *
 * A group's share of a limit is an estimate: the limit's increase over the window, split by the
 * group's share of the account's weight. Weight is API-equivalent cost, except premium requests
 * for GitHub Copilot. Providers do not publish how their limits count usage.
 */

import { ledgerReport } from "./ledger.mjs";
import { COUNTERS, HOUR_MS } from "./parse.mjs";

export const GROUP_KEYS = ["account", "provider", "model", "session", "project", "agent", "feature", "device", "hour"];
const DURATIONS = { "5 Hour": 5 * HOUR_MS, "7 Day": 7 * 24 * HOUR_MS };
const LIMIT_WINDOWS = { "5h": "5 Hour", "7d": "7 Day" };
const MEDIAN_DAYS = 30;
export const UNTRACKED_FACTOR = 2;

/**
 * Resolves the window argument.
 *
 * @param {string} window `5h` or `7d` (each account's current limit window), `last:<N>h|d`, or
 *   `<ISO since>..<ISO until>` (until may be empty for now).
 * @returns {{limit?: string, since?: number, until: number}} `limit` names the window label whose
 *   start each account takes from its own limit; otherwise `since` is fixed.
 */
export function parseWindow(window, now) {
	if (LIMIT_WINDOWS[window]) return { limit: LIMIT_WINDOWS[window], until: now };
	const last = /^last:(\d+)([hd])$/.exec(window);
	if (last) return { since: now - Number(last[1]) * (last[2] === "h" ? HOUR_MS : 24 * HOUR_MS), until: now };
	const range = /^(.+)\.\.(.*)$/.exec(window);
	const since = range && Date.parse(range[1]);
	const until = range && (range[2] ? Date.parse(range[2]) : now);
	if (!range || Number.isNaN(since) || Number.isNaN(until) || since >= until)
		throw new Error(`window "${window}": use 5h, 7d, last:<N>h, last:<N>d or <ISO>..<ISO>`);
	return { since, until };
}

const weightOf = (r) => (r.provider === "github-copilot" ? r.premium : r.cost);

/**
 * Increase of a used fraction between start and end, from snapshots of one account and limit.
 * The last value before start is the baseline, else the first value in the window; a drop is a
 * reset, after which the new value counts from zero.
 *
 * @param {Array<{recordedAt: number, usedFraction: number}>} points Sorted by recordedAt.
 */
export function limitDelta(points, start, end) {
	let prev;
	let delta = 0;
	for (const p of points) {
		if (p.recordedAt > end || typeof p.usedFraction !== "number") continue;
		if (p.recordedAt >= start && prev !== undefined)
			delta += p.usedFraction >= prev ? p.usedFraction - prev : p.usedFraction;
		prev = p.usedFraction;
	}
	return delta;
}

function seriesByLimit(snapshots, account) {
	const series = new Map();
	for (const s of snapshots) {
		if (s.account !== account) continue;
		(series.get(s.limitId) ?? series.set(s.limitId, []).get(s.limitId)).push(s);
	}
	for (const points of series.values()) points.sort((a, b) => a.recordedAt - b.recordedAt);
	return series;
}

/** Length of a snapshot's limit window in ms, from the snapshot or its window label; undefined when unknown. */
export const durationOf = (s) => s.durationMs ?? DURATIONS[s.window];

/** Start of the account's current limit window with the given label, or undefined. */
function limitStart(series, label) {
	for (const points of series.values()) {
		const latest = points.at(-1);
		if (latest.window === label && latest.resetsAt && durationOf(latest)) return latest.resetsAt - durationOf(latest);
	}
	return undefined;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) return undefined;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const weightIn = (rows, start, end) =>
	rows.filter((r) => r.hour + HOUR_MS > start && r.hour < end).reduce((sum, r) => sum + weightOf(r), 0);

/**
 * Used fraction per unit of weight over the closed windows of a limit in the last 30 days: the
 * peak value per distinct reset time divided by the account's tracked weight in that window.
 */
export function closedWindowRatios(points, rows, now) {
	const peaks = new Map();
	for (const p of points) {
		const duration = durationOf(p);
		if (!p.resetsAt || !duration || p.resetsAt > now || p.resetsAt < now - MEDIAN_DAYS * 24 * HOUR_MS) continue;
		const key = Math.round(p.resetsAt / 60_000);
		const peak = peaks.get(key);
		if (!peak || p.usedFraction > peak.used) peaks.set(key, { used: p.usedFraction, end: p.resetsAt, duration });
	}
	const ratios = [];
	for (const { used, end, duration } of peaks.values()) {
		const weight = weightIn(rows, end - duration, end);
		if (weight > 0 && used > 0) ratios.push(used / weight);
	}
	return ratios;
}

/**
 * How many times a limit's increase per tracked weight over [start, end] exceeds its median over
 * closed windows; 0 when there is no increase or no history, Infinity when nothing tracked explains it.
 */
export function untrackedRatio(points, rows, delta, start, end, now) {
	const weight = weightIn(rows, start, end);
	const typical = median(closedWindowRatios(points, rows, now));
	if (!typical || delta <= 0) return 0;
	return weight > 0 ? delta / weight / typical : Number.POSITIVE_INFINITY;
}

function groupValue(row, key, labels) {
	switch (key) {
		case "account":
			return labels[row.account] ?? row.account.slice(0, 12);
		case "session":
			return `${row.title || "(untitled)"} [${row.sessionId.slice(-8)}]`;
		case "hour":
			return new Date(row.hour).toISOString().slice(0, 13).replace("T", " ") + "Z";
		default:
			return String(row[key] ?? "");
	}
}

function aggregate(rows, groupBy, labels) {
	const groups = new Map();
	for (const r of rows) {
		const name = groupBy.map((k) => groupValue(r, k, labels)).join(" · ");
		const g = groups.get(name) ?? groups.set(name, { name, weight: 0, ...Object.fromEntries(COUNTERS.map((c) => [c, 0])) }).get(name);
		for (const c of COUNTERS) g[c] += r[c];
		g.weight += weightOf(r);
	}
	return [...groups.values()].sort((a, b) => b.weight - a.weight || b.cost - a.cost);
}

const tokens = (n) => (n < 1e3 ? `${n}` : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);
const pct = (f) => `${(f * 100).toFixed(1)}%`;
const time = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";

function table(groups, deltas, top) {
	const shown = groups.slice(0, top);
	const rest = groups.slice(top);
	if (rest.length) {
		const other = { name: `(${rest.length} more)`, weight: 0, ...Object.fromEntries(COUNTERS.map((c) => [c, 0])) };
		for (const g of rest) for (const c of [...COUNTERS, "weight"]) other[c] += g[c];
		shown.push(other);
	}
	const total = groups.reduce((s, g) => s + g.weight, 0);
	const head = ["group", "req", "in", "out", "cache r", "cache w", "$ (API eq.)", "premium", "share", ...deltas.map(([l]) => `~${l}`)];
	const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
	for (const g of shown) {
		const share = total > 0 ? g.weight / total : 0;
		const cells = [g.name, g.requests, tokens(g.input), tokens(g.output), tokens(g.cacheRead), tokens(g.cacheWrite), g.cost.toFixed(2), g.premium, pct(share)];
		lines.push(`| ${[...cells, ...deltas.map(([, d]) => pct(share * d))].join(" | ")} |`);
	}
	return lines.join("\n");
}

/**
 * One limit's line and its increase over [start, until]. In the limit's own current window the
 * increase is its current value, since the window started at zero.
 */
function limitLine(limitId, points, rows, start, ctx) {
	const { now, window } = ctx;
	const latest = points.at(-1);
	const own = window.limit === latest.window && latest.resetsAt - durationOf(latest) === start;
	const delta = own ? (latest.usedFraction ?? 0) : limitDelta(points, start, window.until);
	const label = latest.label ?? limitId;
	let line = `- ${label}: now ${pct(latest.usedFraction ?? 0)}${latest.resetsAt ? `, resets ${time(latest.resetsAt)}` : ""}; used in window +${pct(delta)}`;
	const ratio = untrackedRatio(points, rows, delta, start, window.until, now);
	if (ratio >= UNTRACKED_FACTOR)
		line += ` — ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : "far above"} the usual % per tracked cost; possible causes: usage outside tracked omp sessions (claude.ai, other tools, a device not synced) or a changed limit rate`;
	return { label, delta, line };
}

function accountSection(account, rows, series, ctx) {
	const { labels, now, window, groupBy, top } = ctx;
	const start = window.limit ? (limitStart(series, window.limit) ?? now - DURATIONS[window.limit]) : window.since;
	const inWindow = rows.filter((r) => r.hour + HOUR_MS > start && r.hour < window.until);
	const lines = [`## ${labels[account] ?? account}`, `Window ${time(start)} – ${time(window.until)}`];
	const deltas = [];
	for (const [limitId, points] of series) {
		const { label, delta, line } = limitLine(limitId, points, rows, start, ctx);
		deltas.push([label, delta]);
		lines.push(line);
	}
	if (inWindow.length === 0) {
		const used = deltas.some(([, d]) => d > 0) ? " The limit use above comes from outside tracked omp sessions." : "";
		return [...lines, "", `No tracked requests in the window.${used}`].join("\n");
	}
	return [...lines, "", table(aggregate(inWindow, groupBy, labels), deltas, top)].join("\n");
}

/**
 * Builds the report text.
 *
 * @param {{rows: any[], snapshots: any[], labels: Record<string, string>, now: number, window: string,
 *   groupBy: string[], provider?: string, account?: string, top?: number}} input `account` matches a
 *   label substring or a hash prefix.
 */
export function buildReport({ rows, snapshots, labels, now, window, groupBy, provider, account, top = 10 }) {
	const bad = groupBy.filter((k) => !GROUP_KEYS.includes(k));
	if (bad.length) throw new Error(`groupBy: unknown ${bad.join(", ")}; use ${GROUP_KEYS.join(", ")}`);
	const ctx = { labels, now, window: parseWindow(window, now), groupBy, top };
	const matches = (a) => !account || a.startsWith(account) || (labels[a] ?? "").includes(account);
	const accounts = new Set([...rows.map((r) => r.account), ...snapshots.map((s) => s.account)]);
	const sections = [];
	for (const a of [...accounts].sort()) {
		const accountRows = rows.filter((r) => r.account === a);
		const accountProvider = accountRows[0]?.provider ?? snapshots.find((s) => s.account === a)?.provider;
		if ((provider && accountProvider !== provider) || !matches(a)) continue;
		sections.push(accountSection(a, accountRows, seriesByLimit(snapshots, a), ctx));
	}
	const note =
		"Rows are hourly: requests in the hour that contains the window start count in. `~<limit>` columns " +
		"estimate each group's part of the limit's increase by its share of API-equivalent cost (Copilot: premium requests).";
	return [note, ...sections].join("\n\n") || "No usage recorded.";
}

const LEDGER_WINDOWS = { "5h": "last:5h", "7d": "last:7d" };

/**
 * `usage_report` text of a ledger view (ledger.mjs `ledgerReport`). The ledger has no per-account
 * limit window, so 5h and 7d mean the last 5 hours or 7 days; the default window is 7d and the
 * default grouping the work item.
 */
export function ledgerViewReport({ ledger, view, window = "7d", groupBy = ["workItem"], top, now }) {
	const span = parseWindow(LEDGER_WINDOWS[window] ?? window, now);
	return ledgerReport({ ...ledger, view, groupBy, since: span.since ?? 0, until: span.until, ...(top ? { top } : {}) });
}
