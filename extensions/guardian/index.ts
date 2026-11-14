/**
 * Guardian Extension (always on)
 *
 * Meters every session and subagent (API-equivalent cost, waste signals), stops tool loops, and
 * writes one `guardian-run` session entry per main-session run with cost per agent, waste, loop
 * breaks and the run's work items (Jira keys, GitHub issues and pull requests). The usage tracker
 * reads those entries; nothing is added to the system prompt.
 *
 * Ledger (always on, so the retro works with the orchestrator switch off): a `guardian` subagent's
 * result is written as a `guardian-findings` entry; the `guardian_decision` tool records a retro
 * decision as a `guardian-improvement` entry; at session start a notice says when the open findings
 * reached 10 or no retro ran for 7 days (usage repository, `~/.pi/usage/config.json`).
 *
 * Loop breaker: a tool call identical in name, arguments and result to the previous ones gets a
 * note from the third time and is blocked the fifth (meter.mjs). `wait`, `todo` and `ask` are exempt.
 *
 * Work items (workitems.mjs): `/track <id>` sets one for the session, `/track off` clears it,
 * `/track` shows the state. Learned Jira prefixes and the user's `jiraProjects` live in
 * ~/.omp/agent/guardian-state.json.
 *
 * Spec: notes/specs/2026-11-14-orchestrator-mode.md.
 */

import type { ExtensionAPI, ExtensionContext, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

import { currentPipelineVersion } from "../orchestrator/state.mjs";
import { agentOf } from "../shared/agent.mjs";
import { loadConfig } from "../usage/collect.mjs";
import { findingSummaries, guardianYield, retroDue } from "../usage/ledger.mjs";
import { readRepo } from "../usage/store.mjs";
import { newMeter, onMessage, onToolCall, onToolResult } from "./meter.mjs";
import { buildRunRecord, endAgent, joinRun, registry, RUN_ENTRY, startRun } from "./registry.mjs";
import {
	collectWorkItems,
	gitOutput,
	knownPrefixes,
	lastTracked,
	learnPrefixes,
	parseTrackId,
	prefixesToLearn,
	readState,
	repoOfRemote,
} from "./workitems.mjs";

const TRACK_ENTRY = "guardian-track";
const FINDINGS_ENTRY = "guardian-findings";
const IMPROVEMENT_ENTRY = "guardian-improvement";
const STATUS_KEY = "guardian";
const STATE_PATH = join(homedir(), ".omp", "agent", "guardian-state.json");

type WorkItem = { id: string; kind: string; source?: string; primary?: boolean };

// DEV-NOTE: pi's typings predate omp's `additionalContext` on tool_result returns.
const withContext = (text: string) => ({ additionalContext: text }) as unknown as ToolResultEventResult;

/** Why the retro is due, from the usage repository's findings and decisions; undefined without the repository. */
function retroReminder(): string | undefined {
	try {
		const { findings, improvements } = readRepo(loadConfig().repo, { kinds: ["findings", "improvements"] });
		return retroDue(findingSummaries(findings, improvements), improvements, Date.now());
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const reg = registry();
	let meter = newMeter();
	let explicit: WorkItem | undefined;
	let run: { runId: string; sessionId: string; startedAt: number; mode: string; branch?: string; workItems: WorkItem[] } | undefined;
	let lastItems: WorkItem[] = [];

	const showStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, explicit ? `track: ${explicit.id}` : undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		const agent = agentOf(ctx);
		if (agent.kind === "sub") {
			joinRun(reg, { id: agent.id, role: agent.name, meter });
			return;
		}
		explicit = lastTracked(ctx.sessionManager.getBranch(), TRACK_ENTRY);
		showStatus(ctx);
		const due = retroReminder();
		if (due && ctx.hasUI) ctx.ui.notify(`Guardian: ${due}. Run /orchestrate-retro to review them.`, "info");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (agentOf(ctx).kind !== "main") return undefined;
		// DEV-NOTE: omp also fires this with reason "revive" for parked subagents; pi has no reason.
		const reason = "reason" in event && typeof event.reason === "string" ? event.reason : undefined;
		if (reason && reason !== "prompt") return undefined;
		const [branch, remote] = await Promise.all([gitOutput(ctx.cwd, ["branch", "--show-current"]), gitOutput(ctx.cwd, ["remote", "get-url", "origin"])]);
		const known = knownPrefixes(readState(STATE_PATH));
		const workItems = collectWorkItems({ explicit, branch, prompt: event.prompt, repo: repoOfRemote(remote), known });
		const learn = prefixesToLearn(workItems);
		if (learn.length > 0) learnPrefixes(STATE_PATH, learn);
		meter = newMeter();
		run = { runId: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), startedAt: Date.now(), mode: reg.mode, branch, workItems };
		startRun(reg, run);
		return undefined;
	});

	pi.on("message_end", async (event) => {
		onMessage(meter, event.message);
	});

	pi.on("tool_call", async (event, ctx) => {
		const agent = agentOf(ctx);
		if (agent.kind === "sub" && agent.name === "guardian" && event.toolName === "yield") recordFindings(event.input);
		return onToolCall(meter, { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }, Date.now());
	});

	// DEV-NOTE: written in the guardian subagent's own session log; the usage parser reads it with that session.
	// Models pass yield `data` as an object or as a JSON string (seen in the phase 6 smoke run); both count.
	const recordFindings = (input: Record<string, unknown>) => {
		const parsed = guardianYield(input.data);
		if (parsed) pi.appendEntry(FINDINGS_ENTRY, { ...parsed, at: Date.now() });
	};

	pi.registerTool({
		name: "guardian_decision",
		label: "Record improvement decision",
		description:
			"Records the user's decision on one improvement proposed in /orchestrate-retro: the Guardian findings it answers, " +
			"what changes (files, settings, one-line summary), and applied, rejected or deferred with the reason. The usage " +
			"reports measure its effect on later runs. Call it only after the user decided.",
		parameters: Type.Object({
			findingIds: Type.Array(Type.String()),
			decision: Type.Union([Type.Literal("applied"), Type.Literal("rejected"), Type.Literal("deferred")]),
			summary: Type.String({ description: "One line: what changes" }),
			files: Type.Optional(Type.Array(Type.String())),
			settings: Type.Optional(Type.Array(Type.String())),
			scope: Type.Union([Type.Literal("pipeline"), Type.Literal("task")]),
			project: Type.Optional(Type.String({ description: "Project folder of a task-scope change" })),
			reason: Type.String(),
		}),
		async execute(_id, params) {
			pi.appendEntry(IMPROVEMENT_ENTRY, {
				id: randomUUID(),
				date: Date.now(),
				findingIds: params.findingIds,
				change: { files: params.files ?? [], settings: params.settings ?? [], summary: params.summary },
				scope: params.scope,
				...(params.project ? { project: params.project } : {}),
				pipelineVersionBefore: currentPipelineVersion(),
				decision: params.decision,
				reason: params.reason,
			});
			return { content: [{ type: "text" as const, text: `Recorded: ${params.decision} for ${params.findingIds.length} finding(s).` }], details: {} };
		},
	});

	pi.on("tool_result", async (event) => {
		const note = onToolResult(
			meter,
			{ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, content: event.content, isError: event.isError },
			Date.now(),
		);
		return note ? withContext(note) : undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		const agent = agentOf(ctx);
		if (agent.kind === "sub") {
			endAgent(reg, agent.id);
			return;
		}
		if (!run) return;
		const record = buildRunRecord({
			run,
			mode: run.mode,
			mainMeter: meter,
			agents: [...reg.agents.values()],
			branch: run.branch,
			workItems: run.workItems,
			endedAt: Date.now(),
		});
		// DEV-NOTE: set by the orchestrator extension while its switch is on (summary of the orchestrator run this prompt belongs to).
		if (run.mode === "orchestrated" && reg.orchestration) record.orchestration = reg.orchestration();
		pi.appendEntry(RUN_ENTRY, record);
		reg.lastRecord = record;
		lastItems = run.workItems;
		run = undefined;
	});

	pi.registerCommand("track", {
		description: "Work item for this session's tracking: /track <JIRA-1|owner/repo#12|issue URL> | off | status",
		getArgumentCompletions: (prefix: string) =>
			["off", "status"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "" || arg === "status") {
				const last = lastItems.map((i) => `${i.id} (${i.source}${i.primary ? ", primary" : ""})`).join(", ") || "none";
				ctx.ui.notify(`Tracking: ${explicit ? explicit.id : "automatic"}. Last run's work items: ${last}`, "info");
				return;
			}
			if (arg === "off") {
				explicit = undefined;
			} else {
				const item = parseTrackId(arg, repoOfRemote(await gitOutput(ctx.cwd, ["remote", "get-url", "origin"])));
				if (!item) {
					ctx.ui.notify(`Not a Jira key or GitHub issue/PR reference: ${arg}`, "error");
					return;
				}
				explicit = item;
				if (item.kind === "jira") learnPrefixes(STATE_PATH, prefixesToLearn([{ ...item, source: "explicit" }]));
			}
			pi.appendEntry(TRACK_ENTRY, { item: explicit ?? null });
			showStatus(ctx);
			ctx.ui.notify(explicit ? `Tracking ${explicit.id} for this session` : "Tracking back to automatic (branch, PR, prompt)", "info");
		},
	});
}
