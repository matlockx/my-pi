/**
 * usage — token and limit usage per account, provider, model, session and feature.
 *
 * Registers the `usage_report` tool. It reads this device's omp session logs live, the other
 * devices' rows from the usage repository, and limit snapshots from `omp usage` and the repository,
 * then reports per account how much of each limit (Claude 5 Hour / 7 Day, Copilot premium) a window
 * used and which sessions, features or models used it (report.mjs).
 *
 * Cross-device data: a private git repository (decision 2026-11-13: personal GitHub account,
 * default `agent-usage`), configured in `~/.pi/usage/config.json`:
 *   { "repo": "~/github/agent-usage", "device": "<optional, default hostname-installid>",
 *     "timezone": "<optional IANA zone of the report periods, default Europe/Berlin>" }
 * The host loop `usagesync` (my-pi/fish/functions/usagesync.fish, started by my-pi-start) runs
 * collect.mjs hourly: it writes `devices/<device>/` (store.mjs layout) and commits, pulls with
 * rebase and pushes. Each device writes only its own directory, so pulls never conflict. A root
 * `accounts.json` ({ "<account hash>": "<label>" }) overrides the labels devices write.
 * After the pull it writes `reports/{daily,weekly,monthly,yearly}/<period>.html`,
 * `reports/alltime/all.html` and `reports/index.html` for every period since the oldest data whose
 * report is missing or was built from other data (a new device, a backfill); the running week,
 * month, year and the all-time report update once a day. The first device to push a report wins.
 *
 * Privacy: rows carry session titles and project folder names, passed through the secret
 * redactor, and account labels name the account e-mail. Work session titles therefore leave
 * work-controlled storage (accepted risk, notes/specs/2026-11-13-usage-tracker.md); the reports
 * show the same titles, labels and project names.
 *
 * Without the config file the tool reports this device only.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { accountsAndLimits, loadConfig, localDevice, resolveUnpinned } from "./collect.mjs";
import { rowKey, scanSessions } from "./parse.mjs";
import { GROUP_KEYS, buildReport } from "./report.mjs";
import { limitKey, mergeByKey, readRepo } from "./store.mjs";

const DAY_MS = 24 * 3_600_000;
// Medians of closed limit windows look back 30 days; one more covers the 7-day window start.
const LOOKBACK_MS = 31 * DAY_MS;

type Exec = ExtensionAPI["exec"];

async function ompJson(exec: Exec, args: string[]): Promise<Record<string, unknown>> {
	const out = await exec("omp", args, {});
	if (out.code !== 0) throw new Error(`omp ${args.join(" ")} exited ${out.code}: ${out.stderr.trim()}`);
	return JSON.parse(out.stdout) as Record<string, unknown>;
}

function repoConfig(): { repo: string; device: string } | undefined {
	try {
		const config = loadConfig();
		return { repo: config.repo, device: localDevice(config) };
	} catch {
		return undefined;
	}
}

/** Rows, snapshots and labels from this device's logs and omp, merged with the repository. */
async function gather(exec: Exec, now: number) {
	const since = now - LOOKBACK_MS;
	const [usage, history, scan] = await Promise.all([
		ompJson(exec, ["usage", "--json"]),
		ompJson(exec, ["usage", "--history", "--json", "--days", "31"]),
		scanSessions(join(homedir(), ".omp", "agent", "sessions"), since),
	]);
	const live = accountsAndLimits(
		(usage["reports"] as unknown[] | undefined) ?? [],
		(history["entries"] as unknown[] | undefined) ?? [],
	);
	const liveRows = resolveUnpinned(scan.rows, live.byProvider);
	const config = repoConfig();
	if (!config) return { rows: liveRows, snapshots: live.snapshots, labels: live.labels, devices: "this device only (no ~/.pi/usage/config.json)" };
	const stored = readRepo(config.repo, { since });
	const own = stored.rows.filter((r) => r.device === config.device);
	const others = stored.rows.filter((r) => r.device !== config.device);
	// DEV-NOTE: this device's stored rows keep hours whose logs were pruned; live rows replace the rest.
	const rows = [...others, ...mergeByKey(own, liveRows.map((r: object) => ({ ...r, device: config.device })), rowKey)];
	const devices = [...new Set(rows.map((r) => r.device))].join(", ");
	return {
		rows,
		snapshots: mergeByKey(stored.limits, live.snapshots, limitKey),
		labels: { ...live.labels, ...stored.labels },
		devices,
	};
}

export default function usage(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "usage_report",
		label: "Usage Report",
		description:
			"Token and subscription-limit usage per account (Anthropic 5-hour/weekly, Copilot premium), grouped by session, feature, model, provider, project, agent, device or hour, across all synced devices.",
		promptSnippet: "usage_report: Explain token and limit usage per account, provider, model, session and feature.",
		promptGuidelines: [
			"Use usage_report when the user asks how much of a usage limit was spent, why usage was high, or which session, feature, model or provider used it. Default window 5h is each account's current 5-hour limit window; group by session and feature first, then drill down.",
		],
		parameters: Type.Object({
			window: Type.Optional(
				Type.String({
					description: "5h or 7d (current limit window per account), last:<N>h, last:<N>d, or <ISO>..<ISO>. Default 5h.",
				}),
			),
			groupBy: Type.Optional(
				Type.Array(Type.String(), { description: `Group keys, any of: ${GROUP_KEYS.join(", ")}. Default [session].` }),
			),
			provider: Type.Optional(Type.String({ description: "Only accounts of this provider, e.g. anthropic, github-copilot." })),
			account: Type.Optional(Type.String({ description: "Only accounts whose label contains this text or whose hash starts with it." })),
			top: Type.Optional(Type.Number({ description: "Groups shown per account before the rest is summed (default 10)." })),
		}),
		async execute(_toolCallId, params) {
			const now = Date.now();
			const data = await gather(pi.exec.bind(pi), now);
			const text = buildReport({
				rows: data.rows,
				snapshots: data.snapshots,
				labels: data.labels,
				now,
				window: params.window ?? "5h",
				groupBy: params.groupBy ?? ["session"],
				...(params.provider ? { provider: params.provider } : {}),
				...(params.account ? { account: params.account } : {}),
				...(params.top ? { top: params.top } : {}),
			});
			return {
				content: [{ type: "text" as const, text: `Devices: ${data.devices}\n\n${text}` }],
				details: undefined,
			};
		},
	});
}
