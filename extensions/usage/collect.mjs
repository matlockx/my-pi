#!/usr/bin/env node
/**
 * Host-side usage collector: parses this device's omp session logs, fetches limit snapshots and
 * account identities from `omp usage`, writes them into the device's directory of the usage
 * repository (store.mjs), then commits, pulls with rebase and pushes. `--loop` repeats hourly (the
 * `usagesync` fish function runs it that way); `--no-git` stops after writing.
 *
 * Config `~/.pi/usage/config.json`: `{ "repo": "~/github/agent-usage", "device": "<optional name>" }`.
 * Runs on the host, not in the omp sandbox, where git over SSH cannot read known_hosts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { accountHash, scanSessions } from "./parse.mjs";
import { deviceName, writeAccounts, writeLimits, writeRows } from "./store.mjs";

const RESCAN_MS = 2 * 24 * 3_600_000;

export const configPath = () => join(homedir(), ".pi", "usage", "config.json");

const expand = (p) => p.replace(/^~(?=\/|$)/, homedir());

/** Reads the collector config; throws with the file path when it is missing or has no repo. */
export function loadConfig(path = configPath()) {
	const config = JSON.parse(readFileSync(path, "utf8"));
	if (typeof config.repo !== "string" || !config.repo) throw new Error(`${path}: "repo" is missing`);
	return { ...config, repo: expand(config.repo) };
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

function omp(args) {
	return JSON.parse(execFileSync("omp", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

/** Live reports and recent history from the omp CLI. */
export function ompUsage(days) {
	return {
		reports: omp(["usage", "--json"]).reports ?? [],
		history: omp(["usage", "--history", "--json", "--days", String(days)]).entries ?? [],
	};
}

/**
 * Writes this device's rows, snapshots and labels into the repository.
 *
 * @param {{repo: string, device: string, sessionsDir: string, now: number, usage: (days: number) => {reports: any[], history: any[]}}} opts
 */
export async function collect({ repo, device, sessionsDir, now, usage }) {
	const deviceDir = join(repo, "devices", device);
	const firstRun = !existsSync(join(deviceDir, "hourly"));
	const scan = await scanSessions(sessionsDir, firstRun ? 0 : now - RESCAN_MS);
	const { reports, history } = usage(firstRun ? 30 : 3);
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

/**
 * Commits the device directory, rebases onto the remote and pushes. A failed rebase is aborted and
 * reported, never forced; the next run retries.
 *
 * @returns {string} One line describing the outcome.
 */
export function sync(repo, device) {
	const dir = join("devices", device);
	git(repo, ["add", "--", dir]);
	let committed = false;
	try {
		git(repo, ["diff", "--cached", "--quiet", "--", dir]);
	} catch {
		// Pathspec: changes someone staged elsewhere in the checkout stay out of this commit.
		git(repo, ["commit", "--quiet", "-m", `usage: ${device}`, "--", dir]);
		committed = true;
	}
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

async function main() {
	const config = loadConfig();
	const device = localDevice(config);
	const result = await collect({
		repo: config.repo,
		device,
		sessionsDir: join(homedir(), ".omp", "agent", "sessions"),
		now: Date.now(),
		usage: ompUsage,
	});
	const outcome = process.argv.includes("--no-git") ? "git skipped" : sync(config.repo, device);
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
