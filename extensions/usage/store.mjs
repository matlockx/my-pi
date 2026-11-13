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

/**
 * Reads every device of the repository.
 *
 * @param {string} repo
 * @param {{since?: number, until?: number, excludeDevice?: string}} [range] Rows whose hour and
 *   snapshots whose recordedAt fall in [since, until) are returned.
 * @returns {{rows: any[], limits: any[], labels: Record<string, string>}} Rows and snapshots carry
 *   their `device`. Labels: the root accounts.json wins, then device files in name order.
 */
export function readRepo(repo, { since = 0, until = Number.MAX_SAFE_INTEGER, excludeDevice } = {}) {
	const rows = [];
	const limits = [];
	let labels = {};
	const devices = listDir(join(repo, "devices"));
	const firstDay = dayOf(Math.max(0, since));
	const lastDay = until >= 8.64e15 ? "9999-12-31" : dayOf(until);
	// Spread, not Object.assign: a "__proto__" key in a repo file must stay a plain key.
	for (const device of [...devices].reverse()) labels = { ...labels, ...readJson(join(repo, "devices", device, "accounts.json")) };
	labels = { ...labels, ...readJson(join(repo, "accounts.json")) };
	for (const device of devices) {
		if (device === excludeDevice) continue;
		for (const [sub, out, timeOf] of [
			["hourly", rows, (r) => r.hour],
			["limits", limits, (s) => s.recordedAt],
		]) {
			const dir = join(repo, "devices", device, sub);
			for (const name of listDir(dir)) {
				const day = DAY_FILE.exec(name)?.[1];
				if (!day || day < firstDay || day > lastDay) continue;
				for (const item of readJsonl(join(dir, name))) {
					const t = timeOf(item);
					if (t >= since && t < until) out.push({ ...item, device });
				}
			}
		}
	}
	return { rows, limits, labels };
}

