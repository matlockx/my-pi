/**
 * Hourly usage rows from omp session logs (format: omp://session.md). Free of omp APIs, so the host
 * collector (node) and the extension (Bun) share it.
 */

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import readline from "node:readline";

export const HOUR_MS = 3_600_000;

/** User-message prefixes of prompts sent by extensions, and the feature each names. */
export const PROMPT_FEATURES = [
	["Quick review of the uncommitted changes.", "quick-review"],
	["Address the quick-review findings above.", "quick-review-fix"],
	["jflow watcher, round ", "jflow-watch"],
];

// Lines without one of these are never parsed: most log bytes are tool results.
const MARKERS = [
	'"usage"',
	'"credential_pin"',
	'"role":"user"',
	'"role":"developer"',
	'"role":"custom"',
	'"custom_message"',
	'"title_change"',
	'"model_change"',
	'"type":"session"',
	'"type":"title"',
];
export const COUNTERS = ["requests", "input", "output", "cacheRead", "cacheWrite", "cost", "premium"];
const ROOT = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/;

/**
 * Account hash of an OAuth identity, the value omp writes into `credential_pin` entries:
 * sha256 over provider, accountId, email, orgId and projectId joined by NUL. Undefined when the
 * identity has neither accountId nor email, as omp then writes no pin.
 *
 * @param {string} provider
 * @param {{accountId?: string, email?: string, orgId?: string, projectId?: string}} identity
 */
export function accountHash(provider, identity) {
	if (!identity.accountId && !identity.email) return undefined;
	const parts = [provider, identity.accountId, identity.email, identity.orgId, identity.projectId];
	return createHash("sha256")
		.update(parts.map((p) => p ?? "").join("\0"))
		.digest("hex");
}

/** Feature named by a user message: an extension prompt, a slash command, or `user`. */
export function promptFeature(text) {
	for (const [prefix, feature] of PROMPT_FEATURES) if (text.startsWith(prefix)) return feature;
	const command = /^\/([\w:-]+)/.exec(text);
	return command ? `command:/${command[1]}` : "user";
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b?.type === "text" ? b.text : "")).join("");
}

function splitModel(ref) {
	const i = ref?.indexOf("/") ?? -1;
	return i < 0 ? { provider: undefined, model: ref } : { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

/**
 * Parses the entries of one session log.
 *
 * Feature rule: while the agent is idle (no reply yet, or the last assistant reply did not stop for
 * a tool call), a user message names the next run (`promptFeature`); without one, the last
 * `custom_message` type, custom-role message type, or `harness` for a `developer`-role message
 * (reminders omp injects) does. Side requests
 * (`model_usage` and other non-message entries carrying usage) are `side:<purpose or type>`.
 *
 * Entries older than the session header are copies from another session (seance, fork) and are
 * skipped. Requests before the first `credential_pin` of their provider take that pin, because omp
 * writes the pin after the first reply.
 *
 * @param {Iterable<any>} entries Parsed log lines in file order.
 * @returns {{header: any, title: string, runs: Array<[number, string]>, events: any[]}} `runs` lists
 *   each run's start time and feature; `events` one per request with `ts`, `feature`, `provider`,
 *   `model`, `account` and the counters.
 */
export function parseEntries(entries) {
	let header = {};
	let title = "";
	let start = 0;
	let current = {};
	let idle = true;
	let pending = { user: undefined, other: undefined };
	let feature = "user";
	const runs = [];
	const pins = new Map();
	const events = [];

	const add = (entry, source, featureName, ts) => {
		const usage = source.usage;
		const fallback = splitModel(current.ref);
		const provider = source.provider ?? fallback.provider ?? "unknown";
		events.push({
			ts,
			feature: featureName,
			provider,
			model: source.model ?? fallback.model ?? "unknown",
			account: pins.get(provider),
			requests: 1,
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			cost: usage.cost?.total ?? 0,
			premium: usage.premiumRequests ?? 0,
		});
	};

	for (const entry of entries) {
		const ts = Date.parse(entry.timestamp ?? entry.updatedAt ?? "") || 0;
		switch (entry.type) {
			case "title":
			case "title_change":
				if (entry.title) title = entry.title;
				continue;
			case "session":
				header = entry;
				start = ts;
				if (entry.title) title = entry.title;
				continue;
			case "model_change":
				current = { ref: entry.model };
				continue;
			case "credential_pin":
				if (!pins.has(entry.provider))
					for (const e of events) if (e.provider === entry.provider && !e.account) e.account = entry.hash;
				pins.set(entry.provider, entry.hash);
				continue;
			case "custom_message":
				if (idle) pending.other = entry.customType;
				continue;
		}
		if (ts < start) continue;
		if (entry.type !== "message") {
			if (entry.usage) add(entry, entry, `side:${entry.purpose ?? entry.type}`, ts);
			continue;
		}
		const message = entry.message ?? {};
		if (message.role === "user") {
			if (idle) pending.user = promptFeature(textOf(message.content));
		} else if (message.role === "developer" || message.role === "custom") {
			if (idle) pending.other = message.role === "developer" ? "harness" : (message.customType ?? "custom");
		} else if (message.usage) {
			if (message.role === "assistant") {
				const next = pending.user ?? pending.other;
				if (next) {
					feature = next;
					runs.push([ts, feature]);
				}
				pending = { user: undefined, other: undefined };
				idle = message.stopReason !== "toolUse";
			}
			add(entry, message, feature, ts);
		}
	}
	return { header, title, runs, events };
}

/** Parses one log file, skipping lines that carry nothing `parseEntries` reads. */
export async function parseFile(path) {
	const entries = [];
	const lines = readline.createInterface({ input: createReadStream(path), crlfDelay: Infinity });
	for await (const line of lines) {
		if (!MARKERS.some((m) => line.includes(m))) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A line being written while the file is read; the next scan reads it whole.
		}
	}
	return parseEntries(entries);
}

/**
 * Root session id and agent name of a log path below the sessions directory:
 * `<folder>/<ts>_<id>.jsonl` is the main agent, `<folder>/<ts>_<id>/<Name>.jsonl` a subagent.
 */
export function logIdentity(sessionsDir, path) {
	const parts = relative(sessionsDir, path).split(sep);
	const root = ROOT.exec(parts[1] ?? "");
	if (!root) return undefined;
	const agent = parts.length > 2 ? parts.slice(2).join("/").replace(/\.jsonl$/, "") : "main";
	return { folder: parts[0], sessionId: root[1], agent };
}

function featureAt(runs, ts) {
	let feature;
	for (const [start, f] of runs) if (start <= ts) feature = f;
	return feature ?? "user";
}

/**
 * Hourly rows from parsed logs.
 *
 * Subagent requests count toward their root session: they take its title and project, and the
 * feature of the root run that was active when the subagent started (side requests keep their own).
 *
 * @param {Array<{path: string, folder: string, sessionId: string, agent: string, parsed: any}>} logs
 * @returns {any[]} Rows keyed by hour, sessionId, agent, feature, provider, model and account.
 */
export function hourlyRows(logs) {
	const roots = new Map(logs.filter((l) => l.agent === "main").map((l) => [l.sessionId, l]));
	const rows = new Map();
	for (const log of logs) {
		const root = roots.get(log.sessionId);
		const cwd = root?.parsed.header.cwd ?? log.parsed.header.cwd;
		const project = cwd ? basename(cwd) : log.folder;
		const title = root?.parsed.title || log.parsed.title;
		const subagentStart = Date.parse(log.parsed.header.timestamp ?? "") || 0;
		for (const e of log.parsed.events) {
			const feature =
				log.agent === "main" || e.feature.startsWith("side:")
					? e.feature
					: featureAt(root?.parsed.runs ?? [], subagentStart);
			const row = {
				hour: Math.floor(e.ts / HOUR_MS) * HOUR_MS,
				sessionId: log.sessionId,
				project,
				title,
				agent: log.agent,
				feature,
				provider: e.provider,
				model: e.model,
				account: e.account ?? `unpinned:${e.provider}`,
			};
			const key = rowKey(row);
			const into = rows.get(key) ?? rows.set(key, { ...row, ...zero() }).get(key);
			for (const c of COUNTERS) into[c] += e[c];
		}
	}
	return [...rows.values()].map(roundRow);
}

/** Identity of a row: everything except title, project and the counters. */
export function rowKey(r) {
	return [r.hour, r.sessionId, r.agent, r.feature, r.provider, r.model, r.account].join("\u001f");
}

function zero() {
	return Object.fromEntries(COUNTERS.map((c) => [c, 0]));
}

function roundRow(r) {
	return { ...r, cost: Math.round(r.cost * 1e6) / 1e6, premium: Math.round(r.premium * 1e3) / 1e3 };
}

/**
 * Parses every log below sessionsDir modified at or after sinceMs and returns their hourly rows.
 * Files are read in path order; one that vanishes or cannot be read while the scan runs is
 * skipped and counted.
 *
 * @returns {Promise<{rows: any[], files: number, skipped: number}>}
 */
export async function scanSessions(sessionsDir, sinceMs = 0) {
	const logs = [];
	let skipped = 0;
	let paths = [];
	try {
		paths = readdirSync(sessionsDir, { recursive: true })
			.map(String)
			.filter((rel) => rel.endsWith(".jsonl"))
			.map((rel) => join(sessionsDir, rel))
			.sort();
	} catch {
		return { rows: [], files: 0, skipped: 0 };
	}
	for (const path of paths) {
		const id = logIdentity(sessionsDir, path);
		if (!id) continue;
		try {
			if (statSync(path).mtimeMs < sinceMs) continue;
			logs.push({ path, ...id, parsed: await parseFile(path) });
		} catch {
			skipped++;
		}
	}
	return { rows: hourlyRows(logs), files: logs.length, skipped };
}
