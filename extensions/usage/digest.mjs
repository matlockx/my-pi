/**
 * Period reports of the usage repository: calendar periods (day, ISO week, month) in a time zone,
 * when a period is ready to report, and the figures a report page shows (page.mjs renders them).
 *
 * Costs are API-equivalent (`usage.cost.total` of the session logs), not billed amounts.
 */

import { createHash } from "node:crypto";

import { COUNTERS, HOUR_MS, rowKey } from "./parse.mjs";
import { durationOf, limitDelta, UNTRACKED_FACTOR, untrackedRatio } from "./report.mjs";

export const KINDS = ["daily", "weekly", "monthly"];
/** Part of every report's input hash: bump it to rebuild all reports after a change to the figures or the page. */
export const REPORT_VERSION = 1;
/** A period is reported this long after its end even when an active device has not synced since. */
export const MAX_WAIT_MS = 24 * HOUR_MS;
export const OTHER = "other";

const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TOP_SERIES = 6;
const TOP_SESSIONS = 12;
// A snapshot gap longer than this is not counted as time spent at a level (device asleep).
const MAX_SPAN_MS = 2 * HOUR_MS;
// Pace from less of a window than this swings too much to show.
const MIN_PACE_ELAPSED_MS = 12 * HOUR_MS;
// Anthropic list-price ratios to fresh input: cache write 1.25x, cache read 0.1x, output 5x.
export const TOKEN_PRICE = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

const formatters = new Map();

/** Wall-clock parts of ms in tz; wd is 0 for Monday. Throws a RangeError for an unknown zone. */
export function localParts(ms, tz) {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-GB", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			weekday: "short",
		});
		formatters.set(tz, f);
	}
	const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
	return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd: WEEKDAYS.indexOf(p.weekday) };
}

// Wall clock minus UTC at ms, in ms.
function offset(ms, tz) {
	const p = localParts(ms, tz);
	return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - (ms - (ms % 60_000));
}

/** UTC ms of local midnight of y-m-d in tz; month and day may overflow as in Date.UTC. */
export function localMidnight(y, m, d, tz) {
	const wall = Date.UTC(y, m - 1, d);
	return wall - offset(wall - offset(wall, tz), tz);
}

const pad = (n) => String(n).padStart(2, "0");
const dateKey = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;

// ISO week of the week starting on Monday y-m-d: the week of its Thursday.
function isoWeek(y, m, d) {
	const thursday = Date.UTC(y, m - 1, d + 3);
	const year = new Date(thursday).getUTCFullYear();
	return `${year}-W${pad(Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1)}`;
}

/**
 * The period of a kind that contains ms.
 *
 * @returns {{kind: string, key: string, start: number, end: number}} key: `2026-11-12`, `2026-W46`
 *   or `2026-11`; [start, end) in UTC ms.
 */
export function periodOf(kind, ms, tz) {
	const p = localParts(ms, tz);
	if (kind === "daily") return { kind, key: dateKey(p), start: localMidnight(p.y, p.m, p.d, tz), end: localMidnight(p.y, p.m, p.d + 1, tz) };
	if (kind === "weekly") {
		const monday = p.d - p.wd;
		return { kind, key: isoWeek(p.y, p.m, monday), start: localMidnight(p.y, p.m, monday, tz), end: localMidnight(p.y, p.m, monday + 7, tz) };
	}
	if (kind === "monthly") return { kind, key: `${p.y}-${pad(p.m)}`, start: localMidnight(p.y, p.m, 1, tz), end: localMidnight(p.y, p.m + 1, 1, tz) };
	throw new Error(`unknown period kind "${kind}"`);
}

export const previousPeriod = (period, tz) => periodOf(period.kind, period.start - 1, tz);

/** Every period per kind from the one containing `from` to the last one that ended at or before now, oldest first. */
export function completedPeriods(from, now, tz) {
	const out = [];
	for (const kind of KINDS) {
		for (let p = periodOf(kind, from, tz); p.end <= now; p = periodOf(kind, p.end, tz)) out.push(p);
	}
	return out;
}

/**
 * Fingerprint of the data a period's report is built from: the rows and limit snapshots of the
 * period and the one before (the KPI comparison), their accounts' labels, the time zone and
 * REPORT_VERSION. Independent of the order of rows and snapshots, so every device that pulled the
 * same data computes the same value.
 */
export function inputHash(period, rows, limits, labels, tz) {
	// shortcut: the untracked-use median also reads up to 30 days of older data, not hashed here; a change there alone does not rebuild the report.
	const from = previousPeriod(period, tz).start;
	const inside = (t) => t >= from && t < period.end;
	const accounts = new Set();
	const lines = [];
	for (const r of rows.filter((x) => inside(x.hour))) {
		accounts.add(r.account);
		lines.push(JSON.stringify([r.device, rowKey(r), r.project, r.title, ...COUNTERS.map((c) => r[c] ?? 0)]));
	}
	for (const s of limits.filter((x) => inside(x.recordedAt))) {
		accounts.add(s.account);
		lines.push(JSON.stringify([s.device, s.account, s.limitId, s.recordedAt, s.usedFraction ?? null, s.resetsAt ?? null, s.label ?? null, s.window ?? null, s.durationMs ?? null]));
	}
	const named = [...accounts].filter((a) => Object.hasOwn(labels, a)).sort().map((a) => [a, labels[a]]);
	return createHash("sha256")
		.update(JSON.stringify([REPORT_VERSION, tz, period.kind, period.key, named, hasPrevious(period, rows, limits, tz)]))
		.update(lines.sort().join("\n"))
		.digest("hex");
}

/** Whether any row or snapshot lies before the previous period's end, so the previous period has a report. */
export function hasPrevious(period, rows, limits, tz) {
	const end = previousPeriod(period, tz).end;
	return rows.some((r) => r.hour < end) || limits.some((s) => s.recordedAt < end);
}

/** Latest time each device shows in the data: its newest snapshot or the start of its newest row's hour. */
export function lastSeen(rows, limits) {
	const seen = new Map();
	const see = (device, t) => {
		if (!(seen.get(device) >= t)) seen.set(device, t);
	};
	for (const r of rows) see(r.device, r.hour);
	for (const s of limits) see(s.device, s.recordedAt);
	return seen;
}

/** A period is ready once every device with rows in it has synced after its end, or MAX_WAIT_MS after the end. */
export function isReady(period, rows, seen, now) {
	if (now < period.end) return false;
	if (now >= period.end + MAX_WAIT_MS) return true;
	const active = new Set(rows.filter((r) => r.hour >= period.start && r.hour < period.end).map((r) => r.device));
	return [...active].every((d) => (seen.get(d) ?? 0) >= period.end);
}

const zero = () => Object.fromEntries(COUNTERS.map((c) => [c, 0]));
function add(into, r) {
	for (const c of COUNTERS) into[c] += r[c] ?? 0;
	return into;
}

/** Counters of rows plus sessions, active hours, cache hit rate (cache reads of all prompt tokens) and cost per request. */
export function totals(rows) {
	const t = rows.reduce(add, zero());
	const prompt = t.input + t.cacheRead + t.cacheWrite;
	return {
		...t,
		sessions: new Set(rows.map((r) => r.sessionId)).size,
		activeHours: new Set(rows.filter((r) => r.requests > 0).map((r) => r.hour)).size,
		cacheHit: prompt ? t.cacheRead / prompt : 0,
		costPerRequest: t.requests ? t.cost / t.requests : 0,
	};
}

/** Cost per key, highest first. */
export function sumBy(rows, keyOf) {
	const m = new Map();
	for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + r.cost);
	return [...m].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

/** Cost per key, highest first, each split into parts (a Map of part name to cost). */
function stacked(rows, keyOf, partOf) {
	const m = new Map();
	for (const r of rows) {
		const key = keyOf(r);
		const g = m.get(key) ?? m.set(key, { name: key, value: 0, parts: new Map() }).get(key);
		g.value += r.cost;
		g.parts.set(partOf(r), (g.parts.get(partOf(r)) ?? 0) + r.cost);
	}
	return [...m.values()].sort((a, b) => b.value - a.value);
}

// Chart buckets: local hours of a day, else local days of the period.
function buckets(period, tz) {
	if (period.kind === "daily")
		return Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: pad(h), start: period.start + h * HOUR_MS }));
	const out = [];
	const first = localParts(period.start, tz);
	for (let i = 0; ; i++) {
		const start = localMidnight(first.y, first.m, first.d + i, tz);
		if (start >= period.end) return out;
		const p = localParts(start, tz);
		out.push({ key: dateKey(p), label: period.kind === "weekly" ? `${WEEKDAYS[p.wd]} ${p.d}` : String(p.d), start, weekday: p.wd });
	}
}

/** Cost per chart bucket, split into the series projects and OTHER. */
export function timeline(rows, period, tz, series) {
	const list = buckets(period, tz).map((b) => ({ ...b, value: 0, parts: new Map() }));
	const byKey = new Map(list.map((b) => [b.key, b]));
	for (const r of rows) {
		const p = localParts(r.hour, tz);
		const b = byKey.get(period.kind === "daily" ? String(p.h) : dateKey(p));
		if (!b) continue;
		const s = series.includes(r.project) ? r.project : OTHER;
		b.value += r.cost;
		b.parts.set(s, (b.parts.get(s) ?? 0) + r.cost);
	}
	return list;
}

/** Cost per local weekday (0 = Monday) and hour. */
export function heatmap(rows, tz) {
	const m = Array.from({ length: 7 }, () => new Array(24).fill(0));
	for (const r of rows) {
		const p = localParts(r.hour, tz);
		m[p.wd][p.h] += r.cost;
	}
	return m;
}

function topSessions(rows, labelOf) {
	const m = new Map();
	for (const r of rows) {
		const s =
			m.get(r.sessionId) ??
			m.set(r.sessionId, { id: r.sessionId, title: "", project: r.project, value: 0, requests: 0, hours: new Set(), accounts: new Set() }).get(r.sessionId);
		if (!s.title || r.agent === "main") s.title = r.title || s.title;
		s.value += r.cost;
		s.requests += r.requests;
		s.hours.add(r.hour);
		s.accounts.add(labelOf(r.account));
	}
	return [...m.values()]
		.sort((a, b) => b.value - a.value)
		.slice(0, TOP_SESSIONS)
		.map((s) => ({ ...s, title: s.title || "(untitled)", hours: s.hours.size, accounts: [...s.accounts] }));
}

/** Tokens per kind of the Anthropic rows and each kind's estimated share of their cost (TOKEN_PRICE ratios). */
export function tokenMix(rows) {
	const t = rows.filter((r) => r.provider === "anthropic").reduce(add, zero());
	const weights = Object.entries(TOKEN_PRICE).map(([kind, ratio]) => [kind, t[kind] * ratio]);
	const sum = weights.reduce((s, [, w]) => s + w, 0);
	return weights.map(([kind, w]) => ({ name: kind, tokens: t[kind], costShare: sum ? w / sum : 0 }));
}

/** Time in [start, end) during which the limit stood at threshold or above; gaps over MAX_SPAN_MS count up to that. */
export function timeAbove(points, threshold, start, end) {
	let ms = 0;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		if (!(a.usedFraction >= threshold)) continue;
		const to = Math.min(points[i].recordedAt, end, a.recordedAt + MAX_SPAN_MS);
		ms += Math.max(0, to - Math.max(a.recordedAt, start));
	}
	return ms;
}

/**
 * Pace of a limit window at one snapshot: the value at reset if use continues at the window's
 * average rate, and when it reaches 100% before the reset (undefined otherwise or when already
 * full). Undefined before MIN_PACE_ELAPSED_MS of the window have passed.
 */
export function pace(point) {
	const duration = durationOf(point);
	if (!point.resetsAt || !duration || !(point.usedFraction > 0)) return undefined;
	const windowStart = point.resetsAt - duration;
	const elapsed = point.recordedAt - windowStart;
	if (elapsed < MIN_PACE_ELAPSED_MS) return undefined;
	const fullAt = point.usedFraction < 1 ? windowStart + elapsed / point.usedFraction : undefined;
	return { used: point.usedFraction, resetsAt: point.resetsAt, atReset: (point.usedFraction * duration) / elapsed, fullAt: fullAt < point.resetsAt ? fullAt : undefined };
}

function limitView(points, accountRows, period, now) {
	const inside = points.filter((p) => p.recordedAt >= period.start && p.recordedAt < period.end && typeof p.usedFraction === "number");
	if (!inside.length) return undefined;
	const latest = inside.at(-1);
	const duration = durationOf(latest);
	const increase = limitDelta(points, period.start, period.end);
	// Typical ratio from windows closed by the period's end, so a report rebuilt later shows the same flag.
	const ratio = untrackedRatio(points, accountRows, increase, period.start, period.end, Math.min(now, period.end));
	return {
		id: latest.limitId,
		label: latest.label ?? latest.limitId,
		duration,
		points: inside.map((p) => [p.recordedAt, p.usedFraction]),
		peak: Math.max(...inside.map((p) => p.usedFraction)),
		// Summed across resets, so only meaningful when one window covers the period.
		increase: duration >= period.end - period.start ? increase : undefined,
		above90Ms: timeAbove(points, 0.9, period.start, period.end),
		fullMs: timeAbove(points, 1, period.start, period.end),
		pace: duration >= DAY_MS ? pace(latest) : undefined,
		untracked: ratio >= UNTRACKED_FACTOR ? ratio : 0,
	};
}

function accountViews(rows, limits, period, now, labelOf) {
	const current = rows.filter((r) => r.hour >= period.start && r.hour < period.end);
	const ids = new Set([...current.map((r) => r.account), ...limits.filter((s) => s.recordedAt >= period.start && s.recordedAt < period.end).map((s) => s.account)]);
	return [...ids]
		.map((id) => {
			const series = new Map();
			for (const s of limits.filter((x) => x.account === id)) (series.get(s.limitId) ?? series.set(s.limitId, []).get(s.limitId)).push(s);
			const accountRows = rows.filter((r) => r.account === id);
			const own = current.filter((r) => r.account === id);
			const views = [...series.values()]
				.map((points) => limitView(points.sort((a, b) => a.recordedAt - b.recordedAt), accountRows, period, now))
				// A limit that stayed at 0% in the period (an unused model family) adds only noise.
				.filter((v) => v && (v.peak > 0 || v.increase > 0))
				.sort((a, b) => (a.duration ?? Infinity) - (b.duration ?? Infinity));
			return { id, label: labelOf(id), labelled: labelOf.known(id), ...totals(own), limits: views };
		})
		.sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label));
}

const isUser = (feature) => feature === "user" || feature.startsWith("command:");

function periodLabel(period, tz) {
	const fmt = (ms, opts) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(ms);
	if (period.kind === "daily") return fmt(period.start, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
	if (period.kind === "monthly") return fmt(period.start, { month: "long", year: "numeric" });
	const week = Number(period.key.slice(-2));
	return `Week ${week} · ${fmt(period.start, { day: "numeric", month: "short" })} – ${fmt(period.end - 1, { day: "numeric", month: "short", year: "numeric" })}`;
}

/**
 * Everything a report page shows for one period.
 *
 * @param {{period: object, rows: any[], limits: any[], labels: Record<string, string>, tz: string,
 *   now: number, generator: string}} input rows and limits of every device, with `device`, covering
 *   the period, the previous period and the 30 days before now (closed-window medians).
 */
export function digest({ period, rows, limits, labels, tz, now, generator }) {
	const previous = previousPeriod(period, tz);
	const within = (p) => (r) => r.hour >= p.start && r.hour < p.end;
	const current = rows.filter(within(period));
	const labelOf = (a) =>
		Object.hasOwn(labels, a) ? labels[a] : a.startsWith("unpinned:") ? `${a.slice(9)} (no account)` : `account ${a.slice(0, 8)}`;
	labelOf.known = (a) => Object.hasOwn(labels, a) || a.startsWith("unpinned:");
	const projects = stacked(current, (r) => r.project || "(none)", (r) => labelOf(r.account));
	const series = projects.slice(0, TOP_SERIES).map((p) => p.name);
	const features = sumBy(current, (r) => r.feature);
	const seen = lastSeen(rows, limits);
	return {
		period,
		previous: hasPrevious(period, rows, limits, tz) ? previous : undefined,
		label: periodLabel(period, tz),
		tz,
		generatedAt: now,
		generator,
		totals: totals(current),
		previousTotals: totals(rows.filter(within(previous))),
		accounts: accountViews(rows, limits, period, now, labelOf),
		projects,
		accountNames: [...new Set(projects.flatMap((p) => [...p.parts.keys()]))],
		series,
		timeline: timeline(current, period, tz, series),
		heatmap: period.kind === "daily" ? undefined : heatmap(current, tz),
		weeks: period.kind === "monthly" ? sumBy(current, (r) => periodOf("weekly", r.hour, tz).key).sort((a, b) => a.name.localeCompare(b.name)) : undefined,
		sessions: topSessions(current, labelOf),
		features,
		automatic: features.filter((f) => !isUser(f.name)).reduce((s, f) => s + f.value, 0),
		models: sumBy(current, (r) => r.model),
		agents: sumBy(current, (r) => r.agent),
		tokenMix: tokenMix(current),
		devices: [...seen.keys()].sort().map((name) => ({ name, cost: current.filter((r) => r.device === name).reduce((s, r) => s + r.cost, 0), lastSeen: seen.get(name) })),
	};
}
