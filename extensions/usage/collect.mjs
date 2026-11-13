#!/usr/bin/env node
/**
 * Host-side usage collector: parses this device's omp session logs, fetches limit snapshots and
 * account identities from `omp usage`, writes them into the device's directory of the usage
 * repository (store.mjs), then commits, pulls with rebase and pushes. Afterwards it writes the
 * HTML report of every completed day, ISO week and month since the oldest data that is missing or
 * was rendered from other data (digest.mjs, page.mjs) and pushes those. `--loop` repeats hourly
 * (the `usagesync` fish function runs it that way);
 * `--no-git` stops after writing; `--backfill` re-reads all session logs and all limit history
 * this device still has (merged by key, so safe to repeat).
 *
 * Config `~/.pi/usage/config.json`:
 * `{ "repo": "~/github/agent-usage", "device": "<optional name>", "timezone": "<optional, default Europe/Berlin>" }`.
 * Runs on the host, not in the omp sandbox, where git over SSH cannot read known_hosts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { digest, inputHash, isReady, KINDS, lastSeen, localParts, reportPeriods } from "./digest.mjs";
import { renderIndex, renderReport, reportPath, storedHash } from "./page.mjs";
import { accountHash, scanSessions } from "./parse.mjs";
import { deviceName, readRepo, writeAccounts, writeLimits, writeRows } from "./store.mjs";

const RESCAN_MS = 2 * 24 * 3_600_000;
// All of omp's usage_history: `omp usage --history` accepts any day count and returns what it has.
const FULL_HISTORY_DAYS = 3650;
export const DEFAULT_TIMEZONE = "Europe/Berlin";

export const configPath = () => join(homedir(), ".pi", "usage", "config.json");

const expand = (p) => p.replace(/^~(?=\/|$)/, homedir());

/** Reads the collector config; throws with the file path when it is missing or has no repo. */
export function loadConfig(path = configPath()) {
	const config = JSON.parse(readFileSync(path, "utf8"));
	if (typeof config.repo !== "string" || !config.repo) throw new Error(`${path}: "repo" is missing`);
	return { ...config, repo: expand(config.repo), timezone: config.timezone ?? DEFAULT_TIMEZONE };
}

/** Throws when tz is not an IANA time zone the runtime knows. */
export function checkTimezone(tz) {
	try {
		localParts(0, tz);
	} catch {
		throw new Error(`${configPath()}: "timezone" ${JSON.stringify(tz)} is not a known IANA time zone`);
	}
}

/** This device's directory name: config `device`, else hostname plus omp install id. */
export function localDevice(config) {
	if (config.device) return config.device;
	const installId = readFileSync(join(homedir(), ".omp", "install-id"), "utf8");
	return deviceName(hostname(), installId);
}

function identityKey(provider, accountId, email) {
	return [provider, accountId ?? "", email ?? ""].join("\0");
}

/**
 * Accounts and limit snapshots from `omp usage --json` reports and `--history` entries.
 *
 * @returns {{labels: Record<string, string>, byProvider: Map<string, string[]>, snapshots: any[], unmatched: number}}
 *   `byProvider` lists the account hashes per provider; history entries whose account matches no
 *   current report are counted in `unmatched` and dropped.
 */
export function accountsAndLimits(reports, history) {
	const labels = {};
	const byProvider = new Map();
	const byIdentity = new Map();
	const snapshots = [];
	for (const report of reports) {
		const md = report.metadata ?? {};
		const hash = accountHash(report.provider, md);
		if (!hash) continue;
		labels[hash] = `${report.provider}: ${md.email ?? md.accountId}${md.orgName ? ` (${md.orgName})` : ""}`;
		const list = byProvider.get(report.provider) ?? byProvider.set(report.provider, []).get(report.provider);
		if (!list.includes(hash)) list.push(hash);
		byIdentity.set(identityKey(report.provider, md.accountId, md.email), hash);
		for (const limit of report.limits ?? []) {
			snapshots.push({
				recordedAt: report.fetchedAt,
				provider: report.provider,
				account: hash,
				limitId: limit.id,
				label: limit.label,
				window: limit.window?.label,
				usedFraction: limit.amount?.usedFraction,
				resetsAt: limit.window?.resetsAt,
				durationMs: limit.window?.durationMs,
			});
		}
	}
	let unmatched = 0;
	for (const e of history) {
		const hash = byIdentity.get(identityKey(e.provider, e.accountId, e.email));
		if (!hash) {
			unmatched++;
			continue;
		}
		snapshots.push({
			recordedAt: e.recordedAt,
			provider: e.provider,
			account: hash,
			limitId: e.limitId,
			label: e.label,
			window: e.windowLabel,
			usedFraction: e.usedFraction,
			resetsAt: e.resetsAt,
		});
	}
	return { labels, byProvider, snapshots, unmatched };
}

/** Gives unpinned rows the provider's account when this device has exactly one for that provider. */
export function resolveUnpinned(rows, byProvider) {
	return rows.map((r) => {
		const only = byProvider.get(r.provider);
		return r.account === `unpinned:${r.provider}` && only?.length === 1 ? { ...r, account: only[0] } : r;
	});
}

// Node's default of 1 MiB fails with ENOBUFS on `omp usage --history` over all history (about 460 bytes per snapshot).
const JSON_OUTPUT_MAX_BYTES = 512 * 1024 * 1024;

/** Runs cmd and parses its stdout as JSON; output up to JSON_OUTPUT_MAX_BYTES. */
export function runJson(cmd, args) {
	return JSON.parse(execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: JSON_OUTPUT_MAX_BYTES }));
}

const omp = (args) => runJson("omp", args);

/** Live reports and recent history from the omp CLI. */
export function ompUsage(days) {
	return {
		reports: omp(["usage", "--json"]).reports ?? [],
		history: omp(["usage", "--history", "--json", "--days", String(days)]).entries ?? [],
	};
}

/**
 * Writes this device's rows, snapshots and labels into the repository. The first run of a device,
 * and every run with `backfill`, parses all session logs and all limit history omp keeps; other
 * runs parse logs modified in the last two days and three days of history.
 *
 * @param {{repo: string, device: string, sessionsDir: string, now: number, usage: (days: number) => {reports: any[], history: any[]}, backfill?: boolean}} opts
 */
export async function collect({ repo, device, sessionsDir, now, usage, backfill = false }) {
	const deviceDir = join(repo, "devices", device);
	const full = backfill || !existsSync(join(deviceDir, "hourly"));
	const scan = await scanSessions(sessionsDir, full ? 0 : now - RESCAN_MS);
	const { reports, history } = usage(full ? FULL_HISTORY_DAYS : 3);
	const { labels, byProvider, snapshots, unmatched } = accountsAndLimits(reports, history);
	const changed =
		writeRows(deviceDir, resolveUnpinned(scan.rows, byProvider)) +
		writeLimits(deviceDir, snapshots) +
		(writeAccounts(deviceDir, labels) ? 1 : 0);
	return { ...scan, rows: scan.rows.length, snapshots: snapshots.length, unmatched, changed };
}

function git(repo, args) {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Stages path and commits it alone when it changed; returns whether a commit was made. */
function commitPath(repo, path, message) {
	git(repo, ["add", "--", path]);
	try {
		git(repo, ["diff", "--cached", "--quiet", "--", path]);
		return false;
	} catch {
		// Pathspec: changes someone staged elsewhere in the checkout stay out of this commit.
		git(repo, ["commit", "--quiet", "-m", message, "--", path]);
		return true;
	}
}

/**
 * Commits the device directory, rebases onto the remote and pushes. A failed rebase is aborted and
 * reported, never forced; the next run retries.
 *
 * @returns {string} One line describing the outcome.
 */
export function sync(repo, device) {
	const committed = commitPath(repo, join("devices", device), `usage: ${device}`);
	if (!git(repo, ["remote"]).trim()) return committed ? "committed (no remote)" : "unchanged (no remote)";
	try {
		git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
	} catch {
		// First push of a new checkout: nothing to pull yet.
		git(repo, ["push", "--quiet", "-u", "origin", "HEAD"]);
		return "pushed (upstream set)";
	}
	try {
		// --autostash: a hand-edited root accounts.json must not block the pull.
		git(repo, ["pull", "--rebase", "--autostash", "--quiet"]);
	} catch (error) {
		try {
			git(repo, ["rebase", "--abort"]);
		} catch {
			// No rebase in progress: the pull failed before it started.
		}
		return `pull failed, local commit kept: ${error.stderr?.trim() || error.message}`;
	}
	git(repo, ["push", "--quiet", "origin", "HEAD"]);
	return committed ? "pushed" : "pulled";
}

/** Report keys per kind in the repository's reports directory, newest first. */
export function listReports(repo) {
	const out = {};
	for (const kind of KINDS) {
		let names = [];
		try {
			names = readdirSync(join(repo, "reports", kind));
		} catch {
			// No report of this kind yet.
		}
		out[kind] = names.filter((n) => n.endsWith(".html")).map((n) => n.slice(0, -5)).sort().reverse();
	}
	return out;
}

function readIfExists(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/**
 * Writes the report of every period digest.mjs `reportPeriods` names, from the oldest row or
 * snapshot in the repository to the running week and month, when its file is missing or was
 * rendered from other data (`inputHash`, stored in the page), then rewrites `reports/index.html`.
 * A running week or month is rebuilt once a day, when its next day becomes ready; a new device or a
 * backfill rebuilds exactly the reports whose periods it added data to. Devices holding the same
 * data compute the same hash, so the first push wins and stays.
 *
 * @returns {string[]} Paths written, relative to the repository.
 */
export function writeReports({ repo, now, tz, device }) {
	const { rows, limits, labels } = readRepo(repo);
	let first = Number.POSITIVE_INFINITY;
	for (const r of rows) first = Math.min(first, r.hour);
	for (const s of limits) first = Math.min(first, s.recordedAt);
	if (!Number.isFinite(first)) return [];
	const seen = lastSeen(rows, limits);
	const periods = reportPeriods(first, now, tz, (p) => isReady(p, rows, seen, now));
	const written = [];
	for (const period of periods) {
		const path = join("reports", reportPath(period));
		const hash = inputHash(period, rows, limits, labels, tz);
		if (storedHash(readIfExists(join(repo, path))) === hash) continue;
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), renderReport(digest({ period, rows, limits, labels, tz, now, generator: device }), hash));
		written.push(path);
	}
	const running = new Set(periods.filter((p) => p.cutoff).map(reportPath));
	if (written.length) writeFileSync(join(repo, "reports", "index.html"), renderIndex(listReports(repo), running));
	return written;
}

/**
 * Commits `reports/` and pushes. When the push is rejected (another device pushed first) the
 * commit is dropped with `reset --keep`; the next run pulls and rebuilds only reports whose data
 * still differs, so the report already upstream wins and no rebase ever conflicts on a report.
 */
export function pushReports(repo) {
	if (!commitPath(repo, "reports", "usage: reports")) return "reports unchanged";
	if (!git(repo, ["remote"]).trim()) return "reports committed (no remote)";
	try {
		git(repo, ["push", "--quiet", "origin", "HEAD"]);
		return "reports pushed";
	} catch (error) {
		git(repo, ["reset", "--quiet", "--keep", "HEAD~1"]);
		return `reports dropped, next run retries: ${error.stderr?.trim() || error.message}`;
	}
}

async function main() {
	const config = loadConfig();
	// DEV-NOTE: checked here, not in loadConfig: the usage_report tool reads the same config and needs no time zone.
	checkTimezone(config.timezone);
	const device = localDevice(config);
	const now = Date.now();
	const result = await collect({
		repo: config.repo,
		device,
		sessionsDir: join(homedir(), ".omp", "agent", "sessions"),
		now,
		usage: ompUsage,
		backfill: process.argv.includes("--backfill"),
	});
	const noGit = process.argv.includes("--no-git");
	let outcome = "git skipped";
	if (!noGit) {
		outcome = sync(config.repo, device);
		// DEV-NOTE: after sync, so the checkout holds the other devices' latest rows and reports.
		const reports = writeReports({ repo: config.repo, now, tz: config.timezone, device });
		// Runs every time: it also commits a report left uncommitted by an interrupted run.
		const pushed = pushReports(config.repo);
		if (reports.length || pushed !== "reports unchanged") outcome += `, ${reports.length} reports written, ${pushed}`;
	}
	console.log(
		`${new Date().toISOString()} ${device}: ${result.files} logs, ${result.rows} rows, ` +
			`${result.snapshots} snapshots (${result.unmatched} unmatched), ${result.changed} files changed, ${outcome}`,
	);
}

async function run() {
	try {
		await main();
	} catch (error) {
		console.error(`${new Date().toISOString()} usage collect failed: ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await run();
	// --loop: one run per hour until stopped; a failed run is logged and the next one retries.
	if (process.argv.includes("--loop")) setInterval(run, 3_600_000);
}
