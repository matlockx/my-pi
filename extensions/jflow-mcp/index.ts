/**
 * jflow MCP bridge
 *
 * pi has no MCP client. At session start this extension connects to jflow's
 * MCP server, discovers its tools via tools/list and registers each one as a
 * pi tool named `jflow_<name>` (jflow_new_task, jflow_commit, jflow_pr, ...).
 * Schemas come from the server, so new jflow tools show up without changes
 * here.
 *
 * Two modes:
 *   - JFLOW_MCP_URL unset: spawns `jflow mcp` (stdio) as a child of pi, so it
 *     runs with pi's (sandboxed) permissions. No-op when `jflow` is not on PATH.
 *   - JFLOW_MCP_URL set (e.g. http://127.0.0.1:8765/): connects to a server
 *     started outside the sandbox with `jflow mcp --http 127.0.0.1:8765`, so
 *     git/gh/acli get ~/.ssh and credentials. The sandbox must allow that
 *     localhost port.
 *
 * Every tool except the read-only ones in READ_ONLY needs confirmation: they
 * create Jira tasks, commit, push and open PRs. Without a UI they are blocked.
 * A prompt you type that says "jflow" (e.g. "create pr with jflow") is the
 * confirmation: jflow tools run without a dialog until your next prompt.
 * Auto-approve is on by default for repos whose `origin` is under
 * github.com/BauerMediaGroup-Stardust/ (checked per call against the tool's
 * `path`, else the session cwd) and off elsewhere. `/jflow-auto on|off`
 * overrides that for the rest of the session (never persisted).
 *
 * Footer status: `jflow: stdio ✓`, `jflow: http auto ✓`, `jflow: http down`.
 * In HTTP mode this is UX, not a security boundary: the server has no auth,
 * so anything in the sandbox that can reach the port (the agent's bash too)
 * can call it directly.
 *
 * PR watcher: after a successful `pr` or `review_resolve` call, a detached
 * loop polls jflow's review_status tool every 30 s (watch.mjs). Open review
 * threads come back to the agent as a follow-up prompt (at most MAX_ROUNDS
 * per PR and session); any other outcome is a notification. In merge mode
 * the watcher goes on once Copilot is done: jflow asks the default Teams
 * coworker for a review, reminds hourly and merges on a coworker's approval.
 * In merge mode `pr` calls get `no_notify` (unless the agent names a
 * coworker), so the coworker is only asked once Copilot has finished. Merge
 * mode follows auto-approve's default: on for Stardust repos, off elsewhere.
 * `/jflow-merge on|off` overrides it for the session (never persisted);
 * turning it off stops merging at the next check.
 *
 * Watcher state: a line below the editor shows `jflow #<pr>: <state> → <next step>`
 * while a watcher runs and `watcher stopped (<state>)` after it ended. `/jflow-watch`
 * and the read-only tool `jflow_watch_status` print the full state per repo:
 * running or stopped, merge mode, current state, next step, last check, fix
 * rounds and time left.
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { abortable, McpHttpClient, McpStdioClient, resultText } from "./client.mjs";
import { agentMergeBlocked, inputApprovesJflow, isAutoRemote, statusText } from "./intent.mjs";
import { COPILOT_TIMEOUT_MS, describeWatch, MERGE_TIMEOUT_MS, nextStep, parseStatus, watchFooter, watchPR } from "./watch.mjs";

const COMMAND = "jflow";
const URL_ENV = "JFLOW_MCP_URL";
const PREFIX = "jflow_";
const START_TIMEOUT_MS = 10_000;
// Unknown (new) tools fail closed and need confirmation.
// peer_review only reads the PR; peer_review_submit posts to GitHub and stays gated.
const READ_ONLY = new Set(["list_epics", "peer_review"]);

/** Last known state of a PR watcher, see describeWatch in watch.mjs. Times are epoch ms. */
type WatchState = {
	repo: string;
	pr?: number;
	merge: boolean;
	running: boolean;
	status?: string;
	detail?: string;
	error?: string;
	handedToAgent?: boolean;
	rounds: number;
	startedAt: number;
	lastCheckAt?: number;
	deadline: number;
};

// Tools after which Copilot reviews again, so the watcher (re)starts.
const WATCH_AFTER: Record<string, true> = { pr: true, review_resolve: true };

const execFileP = promisify(execFile);

/** Auto-approve default: true when the repo at dir has a Stardust `origin`. Any git failure is false. */
async function isAutoRepo(dir: string): Promise<boolean> {
	try {
		const { stdout } = await execFileP("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 5_000 });
		return isAutoRemote(stdout);
	} catch {
		return false;
	}
}

type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref()),
	]);
}

export default function (pi: ExtensionAPI) {
	type Client = McpStdioClient | McpHttpClient;
	let client: Client | undefined;
	let connecting: Promise<Client> | undefined;
	const url = process.env[URL_ENV]?.trim();
	const mode = url ? "http" : "stdio";
	// up: undefined = not installed/unknown, false = unreachable, true = answered.
	let up: boolean | undefined;
	// auto: explicit /jflow-auto override; undefined = per-repo default (isAutoRepo).
	let auto: boolean | undefined;
	let cwdAuto = false;

	type UiCtx = { hasUI: boolean; ui: { setStatus: (id: string, text: string | undefined) => void } };
	function showStatus(ctx: UiCtx, nowUp: boolean | undefined = up) {
		up = nowUp;
		if (ctx.hasUI) ctx.ui.setStatus("jflow-mcp", statusText({ mode, up, auto: auto ?? cwdAuto }));
	}

	// Memoised so parallel tool calls after a crash/restart share one new connection.
	function connect(cwd: string): Promise<Client> {
		if (client && !client.closed) return Promise.resolve(client);
		connecting ??= (async () => {
			const c = url ? new McpHttpClient(url) : new McpStdioClient(COMMAND, ["mcp"], { cwd });
			try {
				await withTimeout(c.initialize(), START_TIMEOUT_MS);
			} catch (err) {
				c.close();
				throw err;
			}
			client = c;
			return c;
		})().finally(() => {
			connecting = undefined;
		});
		return connecting;
	}

	// One watcher per repository: a later pr/review_resolve there replaces it.
	const watchers = new Map<string, AbortController>();
	// Fix rounds handed to the agent, per `<repo>#<pr>`.
	const rounds = new Map<string, number>();
	// End of the merge-mode budget per repo, kept across review_resolve restarts so fix rounds share one budget.
	const mergeDeadlines = new Map<string, number>();
	// Last known state of the watcher per repo, kept after it stops so /jflow-watch and jflow_watch_status can report it.
	const watchStates = new Map<string, WatchState>();
	// mergeOverride: explicit /jflow-merge choice; undefined = per-repo default (Stardust origin, as auto-approve).
	let mergeOverride: boolean | undefined;
	const mergeOn = async (repo: string) => mergeOverride ?? (await isAutoRepo(repo));

	function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") {
		if (!ctx.hasUI) return;
		// DEV-NOTE: pi renders info notices dim grey; watcher outcomes (merged, clean, state) need to stand out, so
		// they get the theme's yellow without becoming a "Warning:".
		const shown = level === "info" ? text.split("\n").map((line) => ctx.ui.theme.fg("warning", line)).join("\n") : text;
		ctx.ui.notify(shown, level);
	}

	function renderWatches(): string {
		if (watchStates.size === 0) return "No jflow PR watcher has run in this session.";
		return [...watchStates.values()].map((w) => describeWatch(w)).join("\n\n");
	}

	// fresh starts a new merge budget: a new PR or an explicit /jflow-merge on; review_resolve keeps the running one.
	function startWatch(ctx: ExtensionContext, repo: string, prArg: unknown, merging: boolean, fresh: boolean) {
		if (fresh || !mergeDeadlines.has(repo)) mergeDeadlines.set(repo, Date.now() + MERGE_TIMEOUT_MS);
		watchers.get(repo)?.abort(new Error("replaced by a newer watcher"));
		const ac = new AbortController();
		watchers.set(repo, ac);
		let pr = typeof prArg === "number" && prArg > 0 ? prArg : undefined;
		const timeoutMs = merging ? Math.max(0, (mergeDeadlines.get(repo) ?? 0) - Date.now()) : COPILOT_TIMEOUT_MS;
		const state: WatchState = {
			repo, pr, merge: merging, running: true, rounds: rounds.get(`${repo}#${pr}`) ?? 0,
			startedAt: Date.now(), deadline: Date.now() + timeoutMs,
		};
		watchStates.set(repo, state);
		const showWatch = () => {
			// DEV-NOTE: a widget, not setStatus: omp drops the whole extension-status segment of its status line when
			// the terminal is too narrow for it, which hid the watcher. A replaced watcher must not overwrite its successor.
			if (ctx.hasUI && watchers.get(repo) === ac) {
				ctx.ui.setWidget("jflow-watch", [ctx.ui.theme.fg("accent", watchFooter(state))], { placement: "belowEditor" });
			}
		};
		showWatch();
		const check = async () => {
			const c = await connect(ctx.cwd);
			// Merge mode is read per check, so /jflow-merge off stops merging right away.
			state.merge = await mergeOn(repo);
			const result = await c.callTool("review_status", { path: repo, ...(pr ? { pr } : {}), merge: state.merge });
			const text = resultText(result);
			if (result?.isError) throw new Error(text.split("\n").at(-1)?.replace(/^Error: /, "") || "review_status failed");
			const status = parseStatus(text);
			// DEV-NOTE: pinned after the first check, so a branch switch by the agent does not move the watch to another PR.
			pr ??= status.pr;
			return status;
		};

		watchPR({
			check,
			timeoutMs,
			signal: ac.signal,
			onStatus: (s) => {
				Object.assign(state, {
					pr: s.pr, status: s.status, detail: s.detail, error: undefined, lastCheckAt: Date.now(),
					rounds: rounds.get(`${repo}#${s.pr}`) ?? 0,
				});
				showWatch();
			},
			onError: (err: Error, failures: number) => {
				Object.assign(state, { error: `${err.message} (${failures} failed check(s) in a row)`, lastCheckAt: Date.now() });
				showWatch();
			},
		})
			.then((status) => {
				// A watcher replaced while its last check was in flight must not prompt or notify.
				if (ac.signal.aborted) return;
				const key = `${repo}#${status.pr}`;
				const done = rounds.get(key) ?? 0;
				const step = nextStep(status, { repo, rounds: done });
				Object.assign(state, { running: false, status: status.status, detail: status.detail, handedToAgent: !!step.prompt });
				if (status.status === "merged" || status.status === "closed") {
					rounds.delete(key);
					mergeDeadlines.delete(repo);
				}
				if (!step.prompt) return notify(ctx, step.notify, step.level);
				rounds.set(key, done + 1);
				state.rounds = done + 1;
				// DEV-NOTE: the watch ran detached, so the loop may be idle (message starts a turn)
				// or busy with the next user request (message queues as its follow-up).
				pi.sendUserMessage(step.prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			})
			.catch((err: Error) => {
				if (ac.signal.aborted) return;
				Object.assign(state, { running: false, error: err.message });
				notify(ctx, `jflow watcher stopped: ${err.message}`, "warning");
			})
			.finally(() => {
				showWatch();
				if (watchers.get(repo) === ac) watchers.delete(repo);
			});
	}

	pi.on("session_start", async (_event, ctx) => {
		cwdAuto = await isAutoRepo(ctx.cwd);
		let tools: McpTool[];
		try {
			tools = await withTimeout((await connect(ctx.cwd)).listTools(), START_TIMEOUT_MS);
		} catch (err) {
			// Stdio without jflow installed is a silent no-op; a configured URL that fails is worth a warning.
			const missing = !url && (err as NodeJS.ErrnoException).code === "ENOENT";
			showStatus(ctx, missing ? undefined : false);
			if (!missing && ctx.hasUI) {
				const where = url ? ` at ${url} (started with 'jflow mcp --http'?)` : "";
				ctx.ui.notify(`jflow MCP unavailable${where}: ${(err as Error).message}`, "warning");
			}
			return;
		}
		showStatus(ctx, true);

		for (const tool of tools) {
			pi.registerTool({
				name: PREFIX + tool.name,
				label: `jflow ${tool.name}`,
				description: tool.description ?? tool.name,
				parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: "object" }),
				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					const args = { ...params };
					// Models sometimes pass relative or @-prefixed paths; jflow wants absolute.
					if (typeof args.path === "string") args.path = resolve(ctx.cwd, args.path.replace(/^@/, ""));
					const repo = typeof args.path === "string" ? args.path : ctx.cwd;
					const merging = await mergeOn(repo);
					// In merge mode the watcher asks the coworker once Copilot is done; a link now would be a second ping.
					if (tool.name === "pr" && merging && !args.notify) args.no_notify = true;
					if (agentMergeBlocked(tool.name, args, merging)) {
						throw new Error("jflow review_status with merge is off for this repo — turn it on with /jflow-merge on");
					}

					if (!READ_ONLY.has(tool.name) && !approvedByPrompt && !(auto ?? (await isAutoRepo(repo)))) {
						if (!ctx.hasUI) throw new Error(`jflow ${tool.name} blocked — no UI available for confirmation`);
						const ok = await ctx.ui.confirm(
							`🔒 jflow ${tool.name}`,
							`${JSON.stringify(args, null, 2)}\n\nAllow this jflow operation?`,
						);
						if (!ok) throw new Error(`jflow ${tool.name} blocked by user`);
					}

					// Abort stops waiting but sends no MCP cancellation: a half-cancelled push/PR is worse
					// than letting jflow finish. Without this, a stuck git hook hangs the session unabortably.
					let c: Client;
					try {
						c = await connect(ctx.cwd);
					} catch (err) {
						showStatus(ctx, false);
						throw err;
					}
					showStatus(ctx, true);
					const result = await abortable(c.callTool(tool.name, args), signal);
					const text = resultText(result);
					if (result?.isError) throw new Error(text || `jflow ${tool.name} failed`);
					if (WATCH_AFTER[tool.name]) startWatch(ctx, repo, args.pr, merging, tool.name === "pr");
					return { content: [{ type: "text", text }], details: {} };
				},
			});
		}
	});

	pi.registerTool({
		name: `${PREFIX}watch_status`,
		label: "jflow watch status",
		description:
			"Show the PR watchers of this session: whether each is running, merge on approval, the current PR state, " +
			"the next step, fix rounds used and the time left. Read-only; use it to check that a watcher is following a PR.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: renderWatches() }], details: {} };
		},
	});

	pi.registerCommand("jflow-watch", {
		description: "Show the PR watchers: running or stopped, current state, next step",
		handler: async (_args, ctx) => notify(ctx, renderWatches(), "info"),
	});

	// Each user prompt resets the approval, so it never outlives the request that gave it.
	let approvedByPrompt = false;
	pi.on("input", async (event) => {
		approvedByPrompt = inputApprovesJflow(event);
		return { action: "continue" };
	});

	pi.registerCommand("jflow-auto", {
		description: "Run jflow MCP tools without confirmation for this session (on|off|status)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") auto = arg === "on";
			else if (arg !== "status") auto = !(auto ?? cwdAuto);
			showStatus(ctx);
			const on = auto ?? cwdAuto;
			const why = auto === undefined ? " (default for this repo)" : "";
			if (ctx.hasUI) ctx.ui.notify(`jflow auto-approve ${on ? "on — tools push and edit Jira without asking" : "off"}${why}`, "info");
		},
	});

	pi.registerCommand("jflow-merge", {
		description: "After Copilot: ask the Teams coworker, remind hourly, merge the PR on approval (on|off|status)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") mergeOverride = arg === "on";
			else if (arg !== "status") mergeOverride = !(mergeOverride ?? cwdAuto);
			const on = mergeOverride ?? cwdAuto;
			// Turning it on (re)starts the watcher for the current branch's PR, with the longer merge budget.
			if (on && arg !== "status") startWatch(ctx, ctx.cwd, undefined, true, true);
			const why = mergeOverride === undefined ? " (default for this repo)" : "";
			notify(ctx, `jflow merge on approval ${on ? "on" : "off"}${why}${on && arg !== "status" ? " — watching the PR of the current branch" : ""}`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		for (const ac of watchers.values()) ac.abort(new Error("session ended"));
		watchers.clear();
		rounds.clear();
		watchStates.clear();
		mergeDeadlines.clear();
		mergeOverride = undefined;
		client?.close();
		client = undefined;
		auto = undefined; // an override never carries into another session
	});
}
