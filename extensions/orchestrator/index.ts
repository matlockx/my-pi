/**
 * Orchestrator Extension (switchable, off by default)
 *
 * `/orchestrate on` makes the main session the Lead (lead.md, appended to the system prompt per
 * prompt). The Lead never edits files: it calls `route` first (lanes answer, quick, build, plan,
 * unsure) and hands planning, building and review to the `planner`, `implementer` and `qa` agents
 * in my-pi/agents. Gates enforced in code:
 *
 * - spawn gate: free agents per run (one planner in lane plan, one implementer, one qa per Builder
 *   round when the QA policy requires it, one guardian in lanes build and plan); more only through
 *   `request_agents`;
 * - plan approval (`approve_plan`, with a cost warning above $50 unless budget is off);
 * - edit guard: the Lead may not edit, the planner writes only `local://`, qa never edits;
 * - isolation: implementer and qa run in omp's isolated workspaces (patch mode, never applied by
 *   omp); this extension writes one round patch per Builder yield and `apply_change` applies the
 *   newest one after QA and the user's approval, without committing;
 * - Builder budget pause at 1.5x its budget, and the break dialog (Builder rounds, no progress,
 *   needs_replan, pause) whenever the Lead messages a Builder past a limit.
 *
 * After `apply_change` in lanes build and plan the Lead starts the `guardian` auditor with a run
 * digest; the run summary (lane, estimate, rounds, QA verdicts, outcome, pipeline version) reaches
 * the guardian's run record through `reg.orchestration`. `/orchestrate off` releases every setting
 * override, removes the tools and hides the three agents again (`task.disabledAgents`), so a
 * session with the switch off behaves as without this extension. The always-on part (meter, run
 * records, loop breaker, ledger) is the guardian extension.
 *
 * Commands: `/orchestrate on|off|status`, `/orchestrate budget on|off` (cost warning and Builder
 * pause; loop breakers stay on), `/orchestrate rate <1-5> [note]` (rates the last run record). The
 * switch state is saved with the session and shown in the footer; `on` and `off` also set the global
 * default (~/.omp/agent/orchestrator.json) that new sessions start with, resumed sessions keep their own.
 *
 * Spec: notes/specs/2026-11-14-orchestrator-mode.md.
 */

import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

import { registry, RUN_ENTRY } from "../guardian/registry.mjs";
import { promptBody } from "../quick-review/gate.mjs";
import { agentOf, yieldObject } from "../shared/agent.mjs";
import { appendSystemPrompt } from "../shared/system-prompt.mjs";
import { loadConfig } from "../usage/collect.mjs";
import { estimateAccuracy } from "../usage/ledger.mjs";
import { readRepo } from "../usage/store.mjs";
import { applyDialog, applyPatch } from "./apply.mjs";
import type { Run } from "./gate.mjs";
import {
	applyBreakChoice,
	approveExtra,
	BREAK_OPTIONS,
	builderBudget,
	continueBudget,
	decideSpawn,
	followUpBreak,
	guardToolCall,
	LANES,
	messagedBuilder,
	newRun,
	pauseDecision,
	planDialog,
	recordMessage,
	recordSpawn,
	replan,
	reviseTaskInput,
	runFooter,
	runSummary,
} from "./gate.mjs";
import type { QaReport, Round } from "./rounds.mjs";
import {
	baselinePath,
	diffSince,
	orchestratorRegistry,
	orphanWorkspaces,
	processAlive,
	progressBreak,
	qaTriggers,
	readBaseline,
	repoTop,
	ROUND_PATCH_DEADLINE_MS,
	snapshotTree,
	withDeadline,
	writeRoundPatch,
} from "./rounds.mjs";
import {
	accuracyNote,
	currentPipelineVersion,
	FOOTER_EVENT,
	handlesOf,
	hasSavedState,
	LIVE_PREVIEW,
	loadState,
	modeConflict,
	ORCHESTRATOR_AGENTS,
	onNotice,
	parseCommand,
	PR_ROUND_CAP,
	prRoundKey,
	readGlobalDefault,
	sessionModeState,
	SETTING_IDS,
	settingsPlan,
	STATE_ENTRY,
	statusText,
	writeGlobalDefault,
} from "./state.mjs";

const LEAD = readFileSync(fileURLToPath(new URL("./lead.md", import.meta.url)), "utf8").trim();
// Review checklist the implementer and qa personas refer to ("appended below").
const CHECKLIST = promptBody(readFileSync(fileURLToPath(new URL("../../prompts/quick-review.md", import.meta.url)), "utf8"));
const STATUS_KEY = "orchestrator";
/** Tools of orchestrator mode; active only while the switch is on. */
const TOOLS = ["route", "approve_plan", "request_agents", "apply_change"];
const WORKSPACES = join(homedir(), ".omp", "wt");
const REVIEW_LANES = new Set(["build", "plan"]);
const ACCURACY_WINDOW_MS = 90 * 24 * 3_600_000;

/** Accuracy of past plan estimates from the usage repository's run records; undefined without the repository or data. */
function plannerNote(): string | undefined {
	try {
		const { runs } = readRepo(loadConfig().repo, { since: Date.now() - ACCURACY_WINDOW_MS, kinds: ["runs"] });
		return accuracyNote(estimateAccuracy(runs));
	} catch {
		return undefined;
	}
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

type Handle = { get(scope: unknown): unknown; override(scope: unknown, value: unknown): void; clearOverride(scope: unknown): void };

/** omp setting handles of `ids`; undefined under pi, which has no settings registry. */
async function loadHandles(ids: readonly string[]): Promise<Map<string, Handle> | undefined> {
	try {
		// Dynamic import: the omp settings registry module does not exist under pi.
		return handlesOf(await import("@oh-my-pi/pi-coding-agent/config/registry"), ids);
	} catch {
		return undefined;
	}
}

const isMain = (ctx: ExtensionContext) => agentOf(ctx).kind === "main";

export default function (pi: ExtensionAPI) {
	const reg = registry();
	const orch = orchestratorRegistry();
	const scope: unknown = "pi" in pi && pi.pi && typeof pi.pi === "object" && "settings" in pi.pi ? pi.pi.settings : undefined;
	let handles: Map<string, Handle> | undefined;
	let preview: Handle | undefined;
	let previewHinted = false;
	let state = loadState([]);
	// The user's own values of the settings orchestrator mode overrides, read once before overriding.
	let base: Record<string, unknown> | undefined;
	const ours = new Set<string>();
	let run: Run | undefined;
	// Review rounds per pull request in this session, and the PR whose cap the current prompt passed.
	const prRounds = new Map<string, number>();
	let prCapped: string | undefined;
	// Set in an implementer session: where its round patches go and the workspace's top level.
	let sub: { dir: string; top: string } | undefined;

	// Orchestrator tools stay out of the tool list while off, so the switch-off session matches the baseline.
	const applyTools = () => {
		const active = pi.getActiveTools().filter((name) => !TOOLS.includes(name));
		pi.setActiveTools(state.enabled ? [...active, ...TOOLS] : active);
	};

	const requireOn = () => {
		if (!state.enabled) throw new Error("Orchestrator mode is off (/orchestrate on).");
	};

	// Overrides only what orchestrator mode needs and releases only overrides it set itself.
	const applySettings = () => {
		reg.mode = state.enabled ? "orchestrated" : "off";
		orch.budget = state.budget;
		if (!handles || scope === undefined) return;
		base ??= Object.fromEntries([...handles].map(([id, handle]) => [id, handle.get(scope)]));
		const wanted: Record<string, unknown> = settingsPlan(state.enabled, base);
		for (const [id, handle] of handles) {
			if (id in wanted) {
				handle.override(scope, wanted[id]);
				ours.add(id);
			} else if (ours.delete(id)) {
				handle.clearOverride(scope);
			}
		}
	};

	// DEV-NOTE: omp drops the status segment on narrow terminals; lean-footer's widget below the
	// editor is always drawn, so under omp it shows the switch (FOOTER_EVENT) and the status stays empty.
	const show = (ctx: ExtensionContext) => {
		const builder = run?.implementers.at(-1);
		const footer = state.enabled && run ? runFooter(run, { costUsd: builder ? reg.agents.get(builder)?.meter.costUsd : undefined, limitUsd: builder ? orch.budgets.get(builder) : undefined }) : undefined;
		const text = footer ? `${statusText(state)} · ${footer}` : statusText(state);
		pi.events.emit(FOOTER_EVENT, { text });
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "Bun" in globalThis ? undefined : text);
	};

	const save = () => pi.appendEntry(STATE_ENTRY, { ...state });

	pi.on("session_start", async (_event, ctx) => {
		if (!isMain(ctx)) return;
		// DEV-NOTE: the registry is process-wide and this module runs again in every subagent session,
		// so only the main session may set the hook: a subagent's closure has no run (phase 7 RPC run).
		reg.orchestration = () =>
			run && runSummary(run, { pipelineVersion: currentPipelineVersion(), qaVerdicts: qaReports().map((r) => String(r.verdict ?? "")) });
		handles ??= await loadHandles(SETTING_IDS);
		preview ??= (await loadHandles([LIVE_PREVIEW]))?.get(LIVE_PREVIEW);
		const branch = ctx.sessionManager.getBranch();
		state = loadState(branch, readGlobalDefault());
		const conflict = state.enabled ? modeConflict(sessionModeState(ctx)) : undefined;
		if (conflict) {
			state = { ...state, enabled: false };
			ctx.ui.notify(`Orchestrator mode stays off: ${conflict}`, "warning");
		}
		// DEV-NOTE: a new session persists the inherited global default (after the mode conflict),
		// so a resume keeps this session's own setting instead of re-reading a changed global file.
		if (!hasSavedState(branch)) save();
		applySettings();
		applyTools();
		show(ctx);
		if (state.enabled) await offerOrphanCleanup(ctx);
	});

	// Latest round of the run's newest Builder, read from the process-wide registry.
	const latestRound = (): Round | undefined => {
		const builder = run?.implementers.at(-1);
		return builder ? orch.rounds.get(builder)?.at(-1) : undefined;
	};
	const qaReports = (): QaReport[] => (run?.qas ?? []).map((id) => orch.qa.get(id)).filter((r): r is QaReport => !!r);
	const qaDue = (): boolean => {
		const round = latestRound();
		if (!run || !round) return false;
		return REVIEW_LANES.has(run.lane) || qaTriggers(readFileSync(round.path, "utf8"), round.result).length > 0;
	};

	// DEV-NOTE: workspaces outlive the omp process unless their agent is released (spec, phase 0b).
	const offerOrphanCleanup = async (ctx: ExtensionContext) => {
		const orphans = orphanWorkspaces(WORKSPACES, processAlive);
		if (orphans.length === 0 || !ctx.hasUI) return;
		const ok = await ctx.ui.confirm(
			`Delete ${orphans.length} orphaned isolation workspace(s)?`,
			`Their omp process is gone:\n${orphans.map((o) => o.dir).join("\n")}`,
		);
		if (ok) for (const o of orphans) rmSync(o.dir, { recursive: true, force: true });
	};

	pi.on("before_agent_start", async (event, ctx) => {
		const agent = agentOf(ctx);
		if (agent.kind === "main" && state.enabled) show(ctx);
		if (agent.kind === "sub" && (agent.name === "qa" || agent.name === "implementer")) {
			const systemPrompt: unknown = event.systemPrompt;
			return { systemPrompt: appendSystemPrompt(systemPrompt, `# Review checklist\n\n${CHECKLIST}`) } as unknown as BeforeAgentStartEventResult;
		}
		if (agent.kind === "sub" && agent.name === "planner") {
			const note = plannerNote();
			const systemPrompt: unknown = event.systemPrompt;
			return note ? ({ systemPrompt: appendSystemPrompt(systemPrompt, note) } as unknown as BeforeAgentStartEventResult) : undefined;
		}
		if (!state.enabled || agent.kind !== "main") return undefined;
		const key = prRoundKey(event.prompt);
		if (key) prRounds.set(key, (prRounds.get(key) ?? 0) + 1);
		prCapped = key && (prRounds.get(key) ?? 0) > PR_ROUND_CAP ? key : undefined;
		const systemPrompt: unknown = event.systemPrompt;
		// DEV-NOTE: pi's typings say string; omp passes an array of blocks (appendSystemPrompt).
		return { systemPrompt: appendSystemPrompt(systemPrompt, LEAD) } as unknown as BeforeAgentStartEventResult;
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		if (!isMain(ctx)) return undefined;
		const agent = String(event.agent ?? "task");
		if (state.enabled && prCapped && agent === "implementer") {
			return { block: true, reason: `${prCapped} had ${PR_ROUND_CAP} review rounds in this session; ask the user whether to go on.` };
		}
		const decision = decideSpawn({ enabled: state.enabled, run, agent, orchestratorAgents: ORCHESTRATOR_AGENTS, qaDue: qaDue() });
		if (!decision.allow) return { block: true, reason: decision.reason };
		if (state.enabled && run) {
			const id = String(event.spawnKey ?? agent);
			run = recordSpawn(run, agent, id);
			if (agent === "implementer") orch.budgets.set(id, builderBudget(run));
		}
		return undefined;
	});

	// Builder and QA sessions: baseline at start, round patch and result at every yield.
	pi.on("session_start", async (_event, ctx) => {
		const agent = agentOf(ctx);
		if (agent.kind !== "sub" || agent.name !== "implementer") return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		const dir = dirname(file);
		try {
			sub = { dir, top: await repoTop(ctx.cwd) };
			if (!readBaseline(dir, agent.id)) writeFileSync(baselinePath(dir, agent.id), `${await snapshotTree(sub.top)}\n`);
		} catch (err) {
			sub = undefined;
			ctx.ui.notify(`Orchestrator: no round patches for ${agent.id}: ${err instanceof Error ? err.message : err}`, "warning");
		}
	});

	const recordYield = async (agent: { name: string; id: string }, data: Record<string, unknown> | undefined) => {
		if (agent.name === "qa") {
			orch.qa.set(agent.id, data ?? {});
			return;
		}
		if (agent.name === "guardian") return;
		if (agent.name !== "implementer" || !sub) return;
		const baseline = readBaseline(sub.dir, agent.id);
		const rounds = orch.rounds.get(agent.id) ?? [];
		try {
			if (!baseline) throw new Error("baseline missing");
			// DEV-NOTE: omp blocks a tool_call whose handler runs past 30 s, which would refuse the yield;
			// three git calls can take longer, so the whole patch write has one deadline below that.
			const patch = await withDeadline(diffSince(sub.top, baseline), ROUND_PATCH_DEADLINE_MS, `round patch took over ${ROUND_PATCH_DEADLINE_MS / 1000} s`);
			const written = writeRoundPatch(sub.dir, agent.id, patch);
			orch.rounds.set(agent.id, [...rounds, { ...written, result: data }]);
			// DEV-NOTE: the Builder yielded, so the round owed since the Lead's message is now recorded.
			orch.owed.delete(agent.id);
		} catch (err) {
			// DEV-NOTE: never block the yield; a missing round shows up as "no patch" at apply_change.
			orch.rounds.set(agent.id, [...rounds, { round: rounds.length + 1, path: "", hash: "", result: data, error: String(err) }]);
			orch.owed.delete(agent.id);
		}
	};

	pi.on("tool_call", async (event, ctx) => {
		const agent = agentOf(ctx);
		const blocked = guardToolCall({ enabled: state.enabled, agent, toolName: event.toolName, input: event.input });
		if (blocked) return blocked;
		if (agent.kind === "sub") {
			// DEV-NOTE: models pass yield data as an object or as a JSON string; both carry the verdict and status.
			if (event.toolName === "yield") await recordYield(agent, yieldObject(event.input.data));
			if (agent.name !== "implementer") return undefined;
			const costUsd = reg.agents.get(agent.id)?.meter.costUsd ?? 0;
			return pauseDecision({ costUsd, limitUsd: orch.budgets.get(agent.id), budget: orch.budget, toolName: event.toolName });
		}
		if (!state.enabled || !run) return undefined;
		if (event.toolName === "task") {
			const owed = (run.implementers ?? []).filter((id) => orch.owed.has(id)).map((id) => ({ id, round: orch.rounds.get(id)?.length ?? 0 }));
			const revised = reviseTaskInput(event.input, latestRound()?.path || undefined, owed);
			if ("block" in revised) return { block: true, reason: revised.reason };
			if (revised.input !== event.input) return { input: revised.input } as unknown as ToolCallEventResult;
			return undefined;
		}
		if (event.toolName !== "write") return undefined;
		const builder = messagedBuilder(run, String(event.input.path ?? ""));
		if (!builder) return undefined;
		const rounds = orch.rounds.get(builder) ?? [];
		const status = rounds.at(-1)?.result?.status;
		const brk = followUpBreak(run, { status: typeof status === "string" ? status : undefined, noProgress: progressBreak(rounds, qaReports()) });
		if (brk) {
			const spent = reg.agents.get(builder)?.meter.costUsd ?? 0;
			const limit = orch.budgets.get(builder) ?? builderBudget(run);
			const remaining = Number(rounds.at(-1)?.result?.remainingUsd);
			const next = continueBudget(spent, remaining, limit);
			const cost = brk.level === "budget" ? ` Spent $${spent.toFixed(2)} of $${limit.toFixed(2)}; "${BREAK_OPTIONS[0]}" sets a budget of $${next.toFixed(2)}.` : "";
			const choice = ctx.hasUI ? await ctx.ui.select(`Builder ${builder}: ${brk.reason}.${cost} How to go on?`, BREAK_OPTIONS) : undefined;
			const outcome = applyBreakChoice(run, brk, choice);
			run = outcome.run;
			if (outcome.block) return outcome.block;
			if (brk.level === "budget") orch.budgets.set(builder, next);
		}
		run = recordMessage(run, String(event.input.path ?? ""));
		// DEV-NOTE: marked only after followUpBreak let the message through; a blocked message owes nothing.
		orch.owed.add(builder);
		return undefined;
	});

	pi.registerTool({
		name: "route",
		label: "Route request",
		description:
			"Orchestrator mode: first call for every new user request. Chooses the lane: answer (you answer, no subagent), " +
			"quick (one implementer, about 3 files at most, no design choice), build (implementer, qa, guardian), plan (planner, " +
			"plan approval, then as build), unsure (asks the user). Set replan: true to change the lane of the current run " +
			"(scope grew); a replan keeps the run's agents and frees one more planner.",
		parameters: Type.Object({
			lane: Type.Union([...LANES, "unsure"].map((l) => Type.Literal(l))),
			reason: Type.String({ description: "One line: why this lane" }),
			replan: Type.Optional(Type.Boolean({ description: "Change the lane of the current run instead of starting a new run" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireOn();
			let lane = params.lane;
			if (lane === "unsure") {
				if (!ctx.hasUI) throw new Error("No UI to ask: pick a lane yourself or ask the user in your reply.");
				const choice = await ctx.ui.select(`Plan first? ${params.reason}`, ["Plan first (recommended)", "Quick change", "Build directly"]);
				if (!choice) return text("The user closed the dialog without choosing; ask them in your reply.");
				lane = choice.startsWith("Plan") ? "plan" : choice.startsWith("Quick") ? "quick" : "build";
			}
			if (params.replan && run) {
				const next = replan(run, lane, params.reason);
				if ("error" in next) throw new Error(next.error);
				run = next.run;
				return text(`Replanned: lane ${lane} (replan ${run.replans.length}).`);
			}
			run = newRun(randomUUID(), lane, params.reason);
			show(ctx);
			return text(`Lane ${lane}.`);
		},
	});

	pi.registerTool({
		name: "approve_plan",
		label: "Approve plan",
		description:
			"Orchestrator mode: asks the user to approve the planner's plan before any implementer starts. Pass the plan " +
			"summary and the planner's estimateUsd; above $50 the dialog says so (unless budget is off). Returns approve, " +
			"refine with the user's feedback (send it to the planner), or stop.",
		parameters: Type.Object({
			summary: Type.String({ description: "Two or three sentences: what the plan changes" }),
			estimateUsd: Type.Optional(Type.Number({ description: "The planner's run estimate in USD" })),
			planPath: Type.Optional(Type.String({ description: "Where the plan is, e.g. local://plan.md" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireOn();
			if (!run || run.lane !== "plan") throw new Error("No plan run: call route with lane plan first.");
			if (!ctx.hasUI) throw new Error("No UI to ask: present the plan to the user in your reply.");
			const dialog = planDialog({ summary: params.summary, estimateUsd: params.estimateUsd, budget: state.budget });
			const choice = await ctx.ui.select(dialog.title, dialog.options);
			if (choice === dialog.options[0]) {
				run = { ...run, planApproved: true, estimateUsd: params.estimateUsd };
				return text("Approved: start the implementer with the plan.");
			}
			if (choice === dialog.options[1]) {
				const feedback = await ctx.ui.input("What should the planner change?");
				return text(`Refine. User feedback for the planner: ${feedback ?? "(none given)"}`);
			}
			run = { ...run, outcome: "stopped" };
			return text("Stopped by the user: start no implementer.");
		},
	});

	pi.registerTool({
		name: "request_agents",
		label: "Request agents",
		description:
			"Orchestrator mode: asks the user to approve subagents beyond the run's free ones (a second implementer, a scout, " +
			"a reviewer). Each extra agent re-reads the repository context and adds cost.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name, e.g. implementer or scout" }),
			count: Type.Integer({ minimum: 1, maximum: 8 }),
			purpose: Type.String({ description: "What each agent does and why the run needs it" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireOn();
			if (!run) throw new Error("Call route first.");
			if (!ctx.hasUI) throw new Error("No UI to ask: ask the user in your reply.");
			const ok = await ctx.ui.confirm(
				`Start ${params.count} more ${params.agent}?`,
				`${params.purpose}\n\nEach agent re-reads the repository context and adds cost.`,
			);
			if (!ok) return text(`The user declined ${params.count} ${params.agent}.`);
			run = approveExtra(run, params.agent, params.count);
			return text(`Approved ${params.count} more ${params.agent}.`);
		},
	});

	pi.registerTool({
		name: "apply_change",
		label: "Apply change",
		description:
			"Orchestrator mode: shows the user the newest round patch of the run's Builder (or of agentId) with the QA verdict and, " +
			"after their approval, applies it to the checkout with git apply. Nothing is committed. A patch that does not apply " +
			"is kept and reported. After applying, run the quality gates and release the run's agents.",
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Builder agent id; defaults to the run's newest Builder" })),
			overrideQa: Type.Optional(Type.Boolean({ description: "Skip the required QA; the apply dialog then warns the user, who decides" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireOn();
			if (!run) throw new Error("No run: call route first.");
			const builder = params.agentId ?? run.implementers.at(-1);
			const round = builder ? orch.rounds.get(builder)?.at(-1) : undefined;
			if (!builder || !round) throw new Error("No Builder result in this run yet.");
			if (!round.path) throw new Error(`No patch for ${builder} round ${round.round}: ${round.error ?? "unknown error"}`);
			if (!ctx.hasUI) throw new Error("No UI to ask: tell the user where the patch is instead.");
			const patch = readFileSync(round.path, "utf8");
			const reports = qaReports();
			const triggers = REVIEW_LANES.has(run.lane) ? [`lane ${run.lane}`] : qaTriggers(patch, round.result);
			const qaRequired = triggers.length > 0;
			if (qaRequired && !reports.length && !params.overrideQa) {
				throw new Error(`QA is required before applying (${triggers.join("; ")}): start qa first, or ask the user and pass overrideQa: true.`);
			}
			const dialog = applyDialog({ builder, round: round.round, patch, qa: reports.at(-1), qaRequired });
			if ((await ctx.ui.select(dialog.title, dialog.options)) !== dialog.options[0]) {
				return text(`Not applied; the patch stays at ${round.path}.`);
			}
			const outcome = await applyPatch(await repoTop(ctx.cwd), round.path, patch);
			if (!outcome.ok) throw new Error(outcome.error);
			run = { ...run, outcome: "applied" };
			const release = [...run.implementers, ...run.qas].map((id) => `write proc://${id}/kill`).join(", ");
			const audit = REVIEW_LANES.has(run.lane) ? ` Then start the guardian with this task: "Audit run ${run.id}. Digest: ${writeDigest(run, ctx)}. Copy the run id into runIds."` : "";
			return text(`Applied ${builder} round ${round.round} to the checkout (not committed). Next: run the quality gates, then release: ${release}.${audit}`);
		},
	});

	// Run digest for the guardian, in the session's artifacts directory: summary, cost and waste per agent.
	const writeDigest = (r: Run, ctx: ExtensionContext): string => {
		const agents = [...reg.agents.values()].filter((a) => [...r.implementers, ...r.qas].includes(a.id) || a.runId === reg.run?.runId);
		const lines = [
			`# Run ${r.id}`,
			`Lane ${r.lane}: ${r.reason}`,
			`Estimate: ${r.estimateUsd ? `$${r.estimateUsd.toFixed(2)}` : "none"}; Builder rounds ${r.builderRounds}; replans ${r.replans.length}`,
			`QA verdicts: ${qaReports().map((q) => q.verdict).join(", ") || "none"}`,
			`Loop breaks: ${r.loopBreaks.map((b) => `${b.level} (${b.reason}) → ${b.decision}`).join("; ") || "none"}`,
			"",
			"| agent | role | cost | requests | repeated reads | repeated commands | failed tools | edit retries |",
			"|---|---|---|---|---|---|---|---|",
			...agents.map((a) => `| ${a.id} | ${a.role} | $${a.meter.costUsd.toFixed(2)} | ${a.meter.requests} | ${a.meter.waste.repeatedReads} | ${a.meter.waste.repeatedCommands} | ${a.meter.waste.failedTools} | ${a.meter.waste.editRetries} |`),
			"",
			`Transcripts: ${agents.map((a) => `history://${a.id}`).join(", ") || "none"}`,
		];
		const file = ctx.sessionManager.getSessionFile();
		const path = join(file ? file.replace(/\.jsonl$/, "") : WORKSPACES, `guardian-run-${r.id.slice(0, 8)}.md`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${lines.join("\n")}\n`);
		return path;
	};

	pi.registerCommand("orchestrate", {
		description: "Orchestrator mode: the Lead routes, planner/implementer/qa do the work in isolation. on | off | status | budget on|off | rate <1-5> [note]",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "status", "budget on", "budget off", "rate "].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
		handler: async (args, ctx) => {
			const cmd = parseCommand(args);
			if ("error" in cmd) {
				ctx.ui.notify(cmd.error, "error");
				return;
			}
			if (cmd.action === "status") {
				const last = reg.lastRecord;
				const run = last ? ` Last run: $${last.costUsd.toFixed(2)}, ${last.perAgent.length} agent(s), mode ${last.mode}.` : "";
				ctx.ui.notify(`Orchestrator mode ${state.enabled ? "on" : "off"}, budget ${state.budget}.${run}`, "info");
				return;
			}
			if (cmd.action === "rate") {
				if (!reg.lastRecord) {
					ctx.ui.notify("No finished run in this session to rate yet.", "warning");
					return;
				}
				reg.lastRecord = cmd.note ? { ...reg.lastRecord, rating: cmd.rating, ratingNote: cmd.note } : { ...reg.lastRecord, rating: cmd.rating };
				pi.appendEntry(RUN_ENTRY, reg.lastRecord);
				ctx.ui.notify(`Rated the last run ${cmd.rating}/5.`, "info");
				return;
			}
			if (cmd.action === "budget") {
				state = { ...state, budget: cmd.value };
				orch.budget = cmd.value;
				save();
				show(ctx);
				ctx.ui.notify(cmd.value === "off" ? "Budget off: no cost dialog, no cost pause. Loop breakers stay active." : "Budget on.", "info");
				return;
			}
			const conflict = cmd.action === "on" ? modeConflict(sessionModeState(ctx)) : undefined;
			if (conflict) {
				ctx.ui.notify(`Orchestrator mode not switched on: ${conflict}`, "warning");
				return;
			}
			state = { ...state, enabled: cmd.action === "on" };
			save();
			try {
				writeGlobalDefault(state.enabled);
			} catch (err) {
				ctx.ui.notify(`Could not save the global default for new sessions: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
			applySettings();
			applyTools();
			if (!state.enabled && run) {
				const live = [...run.implementers, ...run.qas];
				if (live.length) ctx.ui.notify(`Release the run's isolated agents to free their workspaces: ${live.map((id) => `proc://${id}/kill`).join(", ")}`, "warning");
				run = undefined;
			}
			if (state.enabled) await offerOrphanCleanup(ctx);
			show(ctx);
			if (!state.enabled) {
				ctx.ui.notify("Orchestrator mode off: this session works as without it.", "info");
				return;
			}
			const previewOn = preview && scope !== undefined ? preview.get(scope) === true : undefined;
			ctx.ui.notify(onNotice({ previewOn, hinted: previewHinted }), "info");
			previewHinted = true;
		},
	});
}
