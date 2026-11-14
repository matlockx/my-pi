/**
 * Usage repository files. Each device writes only `devices/<device>/`, so concurrent devices never
 * touch the same file and `git pull --rebase` cannot conflict on data:
 *
 *   accounts.json                      manual labels { "<account>": "<label>" }, win over devices
 *   devices/<device>/hourly/<day>.jsonl  hourly rows (parse.mjs), UTC day of the row's hour
 *   devices/<device>/limits/<day>.jsonl  limit snapshots, UTC day of recordedAt
 *   devices/<device>/accounts.json       labels the device resolved
 *
 * Writes merge by key: a row with a known key replaces the stored one, every other stored row
 * stays, so re-runs never double rows and rows outlive the logs they came from.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redactString } from "../secret-redactor/redact.ts";
import { rowKey } from "./parse.mjs";
import { findingKey } from "./ledger.mjs";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Device directory name: hostname plus the first 8 characters of the omp install id. */
export function deviceName(hostname, installId) {
	const host = hostname.replace(/\.local$/, "").replace(/[^A-Za-z0-9-]/g, "-");
	return `${host}-${installId.trim().slice(0, 8)}`;
}

/** Key of a limit snapshot. */
export function limitKey(s) {
	return [s.account, s.limitId, s.recordedAt].join("\u001f");
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function readJsonl(path) {
	if (!existsSync(path)) return [];
	const out = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// A malformed line (hand edit, bad merge) is dropped on the next rewrite.
		}
	}
	return out;
}

// Write to a temporary file and rename, so a reader never sees half a file.
function writeAtomic(path, text) {
	writeFileSync(`${path}.tmp`, text);
	renameSync(`${path}.tmp`, path);
}

/**
 * Union of stored and fresh items by key; a fresh item replaces a stored one with the same key.
 * Returns the items sorted by key.
 */
export function mergeByKey(stored, fresh, keyOf) {
	const merged = new Map(stored.map((i) => [keyOf(i), i]));
	for (const item of fresh) merged.set(keyOf(item), item);
	return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, i]) => i);
}

/**
 * Stored ledger items merged with the ones read live from this device's logs: a live item replaces
 * the stored copy of the same id. Stored items cover other devices and pruned logs.
 */
export function mergeLedgers(stored, live) {
	return {
		runs: mergeByKey(stored.runs, live.runs, (r) => r.runId),
		findings: mergeByKey(stored.findings, live.findings, findingKey),
		improvements: mergeByKey(stored.improvements, live.improvements, (i) => i.id),
	};
}

/**
 * Merges items into per-day JSONL files of dir. Returns the number of files whose content changed.
 *
 * @param {string} dir
 * @param {any[]} items
 * @param {(item: any) => number} timeOf Time that picks the day file.
 * @param {(item: any) => string} keyOf
 * @param {(stored: any) => boolean} [replaced] Stored items of a touched day file to drop before the merge.
 */
function mergeDays(dir, items, timeOf, keyOf, replaced = () => false) {
	const byDay = new Map();
	for (const item of items) {
		const day = dayOf(timeOf(item));
		(byDay.get(day) ?? byDay.set(day, []).get(day)).push(item);
	}
	let changed = 0;
	for (const [day, fresh] of byDay) {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${day}.jsonl`);
		const before = existsSync(path) ? readFileSync(path, "utf8") : "";
		const text = mergeByKey(
			readJsonl(path).filter((i) => !replaced(i)),
			fresh,
			keyOf,
		)
			.map((i) => `${JSON.stringify(i)}\n`)
			.join("");
		if (text === before) continue;
		writeAtomic(path, text);
		changed++;
	}
	return changed;
}

/**
 * Stores hourly rows for a device. Title and project pass through the secret redactor first,
 * because both leave the machine. The rows of each session in `rows` replace all its stored rows,
 * so callers must pass every row of each session they pass (parse.mjs `scanSessions` reads a
 * session whole); a session absent from `rows` keeps its stored rows.
 */
export function writeRows(deviceDir, rows) {
	const clean = rows.map((r) => ({
		...r,
		title: redactString(r.title ?? "").text,
		project: redactString(r.project ?? "").text,
	}));
	// DEV-NOTE: replacing by session, not by row key, drops rows whose key changed since they were stored (a re-classified feature).
	const sessions = new Set(clean.map((r) => r.sessionId));
	return mergeDays(join(deviceDir, "hourly"), clean, (r) => r.hour, rowKey, (stored) => sessions.has(stored.sessionId));
}

/** Stores limit snapshots for a device. */
export function writeLimits(deviceDir, snapshots) {
	return mergeDays(join(deviceDir, "limits"), snapshots, (s) => s.recordedAt, limitKey);
}

// DEV-NOTE: replan reasons come from the Lead and progress breaks can quote QA findings, so every reason is free text.
const withReasons = (list) => (Array.isArray(list) ? list.map((x) => ({ ...x, reason: redact(x.reason) })) : list);
const cleanOrchestration = (o) => ({ ...o, reason: redact(o.reason), replans: withReasons(o.replans), loopBreaks: withReasons(o.loopBreaks) });

const redact = (text) => (text === undefined || text === null ? text : redactString(String(text)).text);

/** Stores run records for a device, one per runId; free text passes the secret redactor. */
export function writeRuns(deviceDir, runs) {
	const clean = runs.map((r) => ({
		...r,
		title: redact(r.title),
		project: redact(r.project),
		branch: redact(r.branch),
		ratingNote: redact(r.ratingNote),
		...(r.orchestration ? { orchestration: cleanOrchestration(r.orchestration) } : {}),
	}));
	return mergeDays(join(deviceDir, "runs"), clean, (r) => r.startedAt, (r) => r.runId);
}

/** Stores Guardian findings for a device, one row per sighting; evidence and suggestion are redacted. */
export function writeFindings(deviceDir, findings) {
	const clean = findings.map((f) => ({ ...f, project: redact(f.project), evidence: redact(f.evidence), suggestion: redact(f.suggestion) }));
	return mergeDays(join(deviceDir, "findings"), clean, (f) => f.foundAt, findingKey);
}

/** Stores improvement decisions for a device, one per id; summary and reason are redacted. */
export function writeImprovements(deviceDir, improvements) {
	const clean = improvements.map((i) => ({ ...i, reason: redact(i.reason), change: { ...i.change, summary: redact(i.change?.summary) } }));
	return mergeDays(join(deviceDir, "improvements"), clean, (i) => i.date, (i) => i.id);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

/** Adds account labels to the device's accounts.json; returns whether the file changed. */
export function writeAccounts(deviceDir, labels) {
	const path = join(deviceDir, "accounts.json");
	const merged = { ...readJson(path), ...labels };
	const text = `${JSON.stringify(Object.fromEntries(Object.entries(merged).sort()), null, "\t")}\n`;
	if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
	mkdirSync(deviceDir, { recursive: true });
	writeAtomic(path, text);
	return true;
}

function listDir(dir) {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

// Kinds of stored items: directory under the device, key in readRepo's result, item time.
const KINDS = [
	["hourly", "rows", (r) => r.hour],
	["limits", "limits", (s) => s.recordedAt],
	["runs", "runs", (r) => r.startedAt],
	["findings", "findings", (f) => f.foundAt],
	["improvements", "improvements", (i) => i.date],
];

// Items of one device directory of one kind whose time falls in [since, until).
function readKind(dir, timeOf, since, until) {
	const firstDay = dayOf(Math.max(0, since));
	const lastDay = until >= 8.64e15 ? "9999-12-31" : dayOf(until);
	const days = listDir(dir).filter((name) => {
		const day = DAY_FILE.exec(name)?.[1];
		return day && day >= firstDay && day <= lastDay;
	});
	return days.flatMap((name) => readJsonl(join(dir, name))).filter((item) => timeOf(item) >= since && timeOf(item) < until);
}

// Account labels: the root accounts.json wins, then device files in name order.
// Spread, not Object.assign: a "__proto__" key in a repo file must stay a plain key.
function readLabels(repo, devices) {
	let labels = {};
	for (const device of [...devices].reverse()) labels = { ...labels, ...readJson(join(repo, "devices", device, "accounts.json")) };
	return { ...labels, ...readJson(join(repo, "accounts.json")) };
}

/**
 * Reads every device of the repository.
 *
 * @param {string} repo
 * @param {{since?: number, until?: number, excludeDevice?: string, kinds?: string[]}} [range] Items
 *   whose time falls in [since, until) are returned; `kinds` limits the reading to those keys.
 * @returns {{rows: any[], limits: any[], labels: Record<string, string>, runs: any[], findings: any[],
 *   improvements: any[]}} Items carry their `device`. Labels: the root accounts.json wins, then device
 *   files in name order.
 */
export function readRepo(repo, { since = 0, until = Number.MAX_SAFE_INTEGER, excludeDevice, kinds } = {}) {
	const out = { rows: [], limits: [], runs: [], findings: [], improvements: [] };
	const devices = listDir(join(repo, "devices"));
	const wanted = KINDS.filter(([, key]) => !kinds || kinds.includes(key));
	for (const device of devices.filter((d) => d !== excludeDevice)) {
		for (const [sub, key, timeOf] of wanted) {
			for (const item of readKind(join(repo, "devices", device, sub), timeOf, since, until)) out[key].push({ ...item, device });
		}
	}
	return { ...out, labels: readLabels(repo, devices) };
}

