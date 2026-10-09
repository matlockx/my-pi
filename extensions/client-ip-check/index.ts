/**
 * Client IP Check Extension
 *
 * Work repositories listed in <client-ip home>/config.json (default ~/.omp/client-ip)
 * are compared against restricted client code and the own platform with jscpd and
 * JPlag (ipcheck.mjs) at the end of every agent loop that changed them. Findings go
 * back to the agent with the rewrite protocol of skills/client-ip-check, every scan is
 * recorded in the audit directory, and tool calls reaching into a restricted reference
 * or the client-ip home are blocked.
 *
 * Commands: /ip-check run | on | off | status
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { commandDirs, promptBody } from "../quick-review/gate.mjs";
import {
	type AgentView,
	agentView,
	type Config,
	clientIpHome,
	findRepo,
	fingerprint,
	guardHit,
	loadConfig,
	type Repo,
	run,
	scan,
	writeAudit,
} from "./ipcheck.ts";

/** Rewrite rounds the gate hands to the agent per user request before it only reports. */
const MAX_ROUNDS = 3;
const STATUS_KEY = "client-ip";
/** Upper bound on remembered directories, so a long session cannot grow the sweep without limit. */
const MAX_TRACKED_DIRS = 16;
const SKILL_PATH = fileURLToPath(
	new URL("../../skills/client-ip-check/SKILL.md", import.meta.url),
);

type RepoView = { repo: string } & AgentView;

export default function (pi: ExtensionAPI) {
	let paused = false;
	let scanning = false;
	let rounds = 0;
	/** True while the next agent loop is the one the gate started, so the round budget carries over. */
	let ownTurn = false;
	let baseline = "";
	let lastResult = "not run";
	/** Fingerprints that scanned clean; a dirty tree is rescanned until it is clean. */
	const clean = new Set<string>();
	/** Directories seen in bash commands, candidates for a work repository outside ctx.cwd. */
	const touchedDirs = new Set<string>();
	const rootCache = new Map<string, string>();

	async function repoRoot(dir: string): Promise<string> {
		const cached = rootCache.get(dir);
		if (cached !== undefined) return cached;
		const out = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
		const root = out.code === 0 ? out.stdout.trim() : "";
		rootCache.set(dir, root);
		return root;
	}

	/** Listed work repositories this session reached; none when the config is absent or unreadable. */
	async function activeRepos(
		ctx: ExtensionContext,
	): Promise<{ config?: Config; repos: Repo[] }> {
		let config: Config | undefined;
		try {
			config = await loadConfig();
		} catch (error) {
			notify(ctx, `config.json unreadable: ${(error as Error).message}`, "error");
			return { repos: [] };
		}
		if (!config?.repos.length) return { config, repos: [] };
		const roots = new Set<string>();
		for (const dir of [ctx.cwd, ...touchedDirs]) {
			const root = await repoRoot(dir);
			if (root) roots.add(root);
		}
		const repos = [...roots]
			.sort()
			.map((root) => findRepo(config, root))
			.filter((repo): repo is Repo => repo !== undefined);
		return { config, repos };
	}

	function notify(
		ctx: ExtensionContext,
		text: string,
		level: "info" | "warning" | "error",
	) {
		if (ctx.hasUI) ctx.ui.notify(`client-ip: ${text}`, level);
	}

	function status(ctx: ExtensionContext, active: boolean) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			!active
				? undefined
				: paused
					? "ip: paused"
					: scanning
						? "ip: scanning"
						: `ip: ${lastResult}`,
		);
	}

	/** Runs work without awaiting it; a rejection is reported as an error notification. */
	function detach(ctx: ExtensionContext, work: Promise<unknown>) {
		work.catch((error: unknown) =>
			notify(ctx, error instanceof Error ? error.message : String(error), "error"),
		);
	}

	/** Scans every repository, writes one audit record each, returns the agent views. */
	async function scanAll(
		ctx: ExtensionContext,
		config: Config,
		repos: Repo[],
		trigger: string,
	): Promise<RepoView[]> {
		scanning = true;
		status(ctx, true);
		try {
			const session = ctx.sessionManager?.getSessionFile?.();
			const views: RepoView[] = [];
			for (const repo of repos) {
				const result = await scan(config, repo);
				await writeAudit(config.home, repo, result, {
					session: session ? basename(session) : null,
					trigger,
				});
				views.push({ repo: repo.root, ...agentView(result) });
			}
			const findings = views.reduce((n, v) => n + v.findings.length, 0);
			lastResult = views.some((v) => v.status === "INCOMPLETE")
				? "incomplete"
				: findings
					? `${findings} finding${findings === 1 ? "" : "s"}`
					: "clean";
			return views;
		} finally {
			scanning = false;
			status(ctx, true);
		}
	}

	/** Scans, records, and hands findings to the agent while the round budget lasts. */
	async function gate(
		ctx: ExtensionContext,
		config: Config,
		repos: Repo[],
		fp: string,
		trigger: string,
	) {
		const views = await scanAll(ctx, config, repos, trigger);
		const findings = views.reduce((n, v) => n + v.findings.length, 0);
		const failed = views.filter((v) => v.status === "INCOMPLETE");
		if (failed.length)
			notify(ctx, "a scanner failed; the result is incomplete, see the audit record", "error");
		if (!findings) {
			if (!failed.length) {
				clean.add(fp);
				notify(ctx, "clean", "info");
			}
			return;
		}
		if (rounds >= MAX_ROUNDS) {
			notify(
				ctx,
				`${findings} findings remain after ${MAX_ROUNDS} rewrite rounds; listed in review.jsonl under ${config.home}/audit`,
				"warning",
			);
			return;
		}
		rounds += 1;
		ownTurn = true;
		notify(ctx, `${findings} findings, rewrite round ${rounds}/${MAX_ROUNDS}`, "warning");
		const prompt =
			`Client IP check, round ${rounds}/${MAX_ROUNDS}: the scan matched content of the work ` +
			"repository against restricted client code. Handle every finding below with the " +
			"rewrite protocol of the client-ip-check skill in your system prompt: secure the " +
			"behaviour with tests first, then write the unit again from that behaviour; never " +
			"edit, rename, split or reorder the matched text to change the score. Run the " +
			"tests, call client_ip_check, and close with one line per finding id: what was " +
			"rewritten and which tests cover it.\n\n" +
			`\`\`\`json\n${JSON.stringify(views, null, 2)}\n\`\`\``;
		// DEV-NOTE: the scan ran detached, so the loop may be idle (message starts a turn)
		// or busy with the next user request (message queues as its follow-up).
		pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	}

	// DEV-NOTE: the wall that keeps another client's code out of this session's context.
	// The scanners read the references in a child process; the agent never needs to.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			for (const dir of commandDirs(String(event.input.command ?? ""))) {
				if (touchedDirs.size >= MAX_TRACKED_DIRS) break;
				touchedDirs.add(resolve(ctx.cwd, dir.replace(/^~(?=\/|$)/, homedir())));
			}
		}
		const { config, repos } = await activeRepos(ctx);
		if (!config || !repos.length) return undefined;
		const hit = guardHit(event.input, ctx.cwd, [
			config.home,
			...repos.flatMap((r) => r.restricted),
		]);
		if (!hit) return undefined;
		return {
			block: true,
			reason:
				`Blocked: ${hit} reaches a restricted client corpus or the client IP check data. ` +
				"Code of another client must not enter this session. Work from the behaviour, " +
				"the tests and the own platform; name the target repository directly instead " +
				"of a parent directory.",
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (paused) return undefined;
		const { repos } = await activeRepos(ctx);
		if (!repos.length) return undefined;
		// DEV-NOTE: the protocol rides in the system prompt so the agent follows it from the
		// first line it writes, and the gate's fix prompt can refer to it instead of
		// repeating it in the transcript.
		let skill: string;
		try {
			skill = promptBody(await readFile(SKILL_PATH, "utf8"));
		} catch {
			return undefined;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${skill}` };
	});

	// DEV-NOTE: the budget bounds one scan/rewrite ping-pong. A loop the gate did not start
	// came from the user and earns a fresh budget.
	pi.on("agent_start", async (_event, ctx) => {
		if (!ownTurn) rounds = 0;
		ownTurn = false;
		const { repos } = await activeRepos(ctx);
		baseline = await fingerprint(repos.map((r) => r.root));
		status(ctx, repos.length > 0);
	});

	// DEV-NOTE: omp times an agent_end handler out after 30 s; a scan of two platforms takes
	// longer, so it is detached and its findings start (or queue) their own turn.
	pi.on("agent_end", async (_event, ctx) => {
		if (paused || scanning) return;
		const { config, repos } = await activeRepos(ctx);
		if (!config || !repos.length) return;
		const fp = await fingerprint(repos.map((r) => r.root));
		if (fp === baseline || clean.has(fp)) return;
		detach(ctx, gate(ctx, config, repos, fp, "agent_end"));
	});

	pi.on("session_start", async (_event, ctx) => {
		const { repos } = await activeRepos(ctx);
		status(ctx, repos.length > 0);
	});

	pi.registerTool({
		name: "client_ip_check",
		label: "Client IP Check",
		description:
			"Scan the listed work repositories of this session against restricted client code " +
			"(jscpd + JPlag). Returns findings as work-repository locations only.",
		promptSnippet:
			"client_ip_check: scan the work repository against restricted client code",
		promptGuidelines: [
			"Use client_ip_check after rewriting client IP findings, before reporting the work done.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
			const { config, repos } = await activeRepos(ctx);
			if (!config || !repos.length)
				return text(`No work repository of this session is listed in ${clientIpHome()}/config.json.`);
			if (scanning) return text("A client IP scan is already running; its result follows as a message.");
			const views = await scanAll(ctx, config, repos, "tool");
			if (views.every((v) => v.status === "CLEAN"))
				clean.add(await fingerprint(repos.map((r) => r.root)));
			return text(JSON.stringify(views, null, 2));
		},
	});

	pi.registerCommand("ip-check", {
		description: "Client IP check: run | on | off | status",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const { config, repos } = await activeRepos(ctx);
			if (arg === "off") paused = true;
			else if (arg === "on") {
				paused = false;
				rounds = 0;
			} else if (arg === "run") {
				if (!config || !repos.length) {
					notify(ctx, `no listed work repository; see ${clientIpHome()}/config.json`, "warning");
					return;
				}
				if (scanning) {
					notify(ctx, "a scan is already running", "info");
					return;
				}
				rounds = 0;
				detach(ctx, gate(ctx, config, repos, await fingerprint(repos.map((r) => r.root)), "command"));
				return;
			}
			status(ctx, repos.length > 0);
			notify(
				ctx,
				`${paused ? "paused" : "on"} · repos: ${repos.map((r) => basename(r.root)).join(", ") || "none listed"} · ` +
					`round ${rounds}/${MAX_ROUNDS} · last: ${lastResult}`,
				"info",
			);
		},
	});
}
