/**
 * Orchestrator run state, spawn gate and edit guard. Pure; index.ts wires the hooks and dialogs.
 *
 * A run starts with a `route` call and holds the agents that may start without asking. It is not
 * reset per prompt: a user answer to the Lead's question is a prompt too, and must not cost the
 * run its approvals. A `route` call with `replan: true` keeps the run and frees one more planner.
 */

import { gatesRun } from "../push-gate/gate.mjs";

export const LANES = ["answer", "quick", "build", "plan"];
/** Ask before building when a plan's estimate exceeds this (user choice), unless budget is off. */
export const COST_THRESHOLD_USD = 50;
/** Builder rounds QA may review: the first result plus at most two fix rounds. */
export const MAX_BUILDER_ROUNDS = 3;
export const MAX_REPLANS = 2;
/** Builder budget of a quick-lane run (spec: lanes), API-equivalent USD. */
export const QUICK_BUDGET_USD = 5;
/** A Builder pauses once its cost reaches this multiple of its budget (user choice), unless budget is off. */
export const PAUSE_FACTOR = 1.5;
/** Tools a paused Builder may still call: only the one that hands its result back. */
const PAUSE_ALLOWED = new Set(["yield"]);

const LEAD_BLOCKED = new Set(["edit", "ast_edit", "eval"]);
const LEAD_WRITE = /^(xd|local|out|agent):\/\//;
const PROC_KILL = /^proc:\/\/[^/]+\/kill$/;
// Devices behind `write xd://` that change files; blocked for the Lead like their direct tools.
const LEAD_XD_BLOCKED = /^xd:\/\/(ast_edit|debug)\b/;
const GIT_ALLOWED = /^git(?:\s+-C\s+\S+)?\s+(?:status|diff|log|show|fetch|commit|push)(?:\s|$)/;
const REVIEW_LANES = new Set(["build", "plan"]);

/**
 * @typedef {object} Run One orchestrated request, from `route` to apply or stop.
 * @property {string} id
 * @property {string} lane answer | quick | build | plan
 * @property {string} reason
 * @property {{from: string, to: string, trigger: string, reason: string}[]} replans
 * @property {boolean} planApproved
 * @property {Record<string, number>} started Agents started in this run, by agent name.
 * @property {number} builderRounds Builder results QA may review (first result plus fix rounds).
 * @property {string[]} implementers Agent ids of the run's Builders.
 * @property {Record<string, number>} approvedExtra Starts the user approved beyond the free ones.
 * @property {number} [estimateUsd] The planner's run estimate, set when the user approves the plan.
 */

/** A new run for a lane. `id` is the caller's run id. */
export function newRun(id, lane, reason) {
	return {
		id,
		lane,
		reason,
		replans: [],
		planApproved: false,
		started: { planner: 0, implementer: 0, qa: 0, guardian: 0 },
		builderRounds: 0,
		implementers: [],
		qas: [],
		approvedExtra: {},
		loopBreaks: [],
		extraRounds: 0,
	};
}

/** The run after a replan to `lane`; refused past MAX_REPLANS. Returns `{ run }` or `{ error }`. */
export function replan(run, lane, reason, trigger = "lead") {
	if (run.replans.length >= MAX_REPLANS) return { error: `This run was replanned ${MAX_REPLANS} times already; ask the user whether to stop or start a new request.` };
	return {
		run: { ...run, lane, reason, planApproved: false, replans: [...run.replans, { from: run.lane, to: lane, trigger, reason }] },
	};
}

// Free agents per lane; qa and guardian only in review lanes or when a QA trigger fired.
const FREE = {
	planner: (run) => (run.lane === "plan" ? 1 + run.replans.filter((r) => r.to === "plan").length : 0),
	implementer: (run) => (run.lane === "plan" ? Number(run.planApproved) : Number(run.lane === "quick" || run.lane === "build")),
	qa: (run, qaDue) => (REVIEW_LANES.has(run.lane) || qaDue ? Math.min(run.builderRounds, MAX_BUILDER_ROUNDS) : 0),
	guardian: (run) => Number(REVIEW_LANES.has(run.lane)),
};

function allowance(run, agent, qaDue) {
	// DEV-NOTE: agent names come from the model's task call; hasOwn keeps "constructor" and friends out of FREE.
	const free = Object.hasOwn(FREE, agent) ? FREE[agent](run, qaDue) : 0;
	return free + (run.approvedExtra[agent] ?? 0);
}

const RUN_AGENTS = ["planner", "implementer", "qa", "guardian"];

/** Run agents the Lead may start now without a dialog. */
export function freeAgents(run, qaDue = false) {
	return RUN_AGENTS.filter((a) => (run.started[a] ?? 0) < allowance(run, a, qaDue));
}

// Why a stage of the run is not reached yet for `agent`, or undefined.
function notYet(run, agent, qaDue) {
	if (agent === "implementer") return run.lane === "plan" && !run.planApproved ? "The plan is not approved yet: call approve_plan first." : undefined;
	if (agent !== "qa") return undefined;
	if (run.builderRounds === 0) return "No Builder result to review yet.";
	return run.lane === "quick" && !qaDue ? "QA is not required in lane quick: no trigger fired on the Builder's round. Go on with apply_change." : undefined;
}

// Why `agent` may not start in `run` once its allowance is used up.
function refusal(run, agent, qaDue) {
	const stage = notYet(run, agent, qaDue);
	if (stage) return stage;
	// DEV-NOTE: a task item without `agent` arrives as "task"; naming the free agents ends the retry loop seen in phase 7.
	const free = freeAgents(run, qaDue);
	const now = free.length ? ` Free now: ${free.join(", ")} (set agent on the task item).` : "";
	return `No free ${agent} in this run (${run.started[agent] ?? 0} started).${now} Message a running agent with write agent://<id>, or ask the user with request_agents.`;
}

/**
 * Whether the Lead may start `agent` now. Returns `{ allow: true }` or `{ allow: false, reason }`.
 * With the switch off only the orchestrator's own agents are refused. `qaDue` is true when a QA
 * trigger fired on the latest quick-lane round (rounds.mjs qaTriggers).
 */
export function decideSpawn({ enabled, run, agent, orchestratorAgents, qaDue = false }) {
	if (!enabled) {
		return orchestratorAgents.includes(agent) ? { allow: false, reason: `${agent} is available only in orchestrator mode (/orchestrate on).` } : { allow: true };
	}
	if (!run) return { allow: false, reason: "Call route first: every request starts with a lane." };
	if (run.lane === "answer") return { allow: false, reason: "Lane answer runs no subagent. Call route again with another lane if the request needs one." };
	if ((run.started[agent] ?? 0) < allowance(run, agent, qaDue)) return { allow: true };
	return { allow: false, reason: refusal(run, agent, qaDue) };
}

/** The run after `agent` started with id `id`; started agents count against free and approved ones alike. */
export function recordSpawn(run, agent, id) {
	const started = { ...run.started, [agent]: (run.started[agent] ?? 0) + 1 };
	const implementers = agent === "implementer" ? [...run.implementers, id] : run.implementers;
	const qas = agent === "qa" ? [...run.qas, id] : run.qas;
	const builderRounds = agent === "implementer" ? run.builderRounds + 1 : run.builderRounds;
	return { ...run, started, implementers, qas, builderRounds };
}

/** The run after the user approved `count` more `agent` starts (request_agents). */
export function approveExtra(run, agent, count) {
	return { ...run, approvedExtra: { ...run.approvedExtra, [agent]: (run.approvedExtra[agent] ?? 0) + count } };
}

/** Id of the run's Builder a `write` path addresses (`agent://<id>`), or undefined. */
export function messagedBuilder(run, path) {
	const id = /^agent:\/\/([^/?#]+)/.exec(path ?? "")?.[1];
	return id && run.implementers.includes(id) ? id : undefined;
}

/** The run after the Lead sent a follow-up to a Builder (a fix round). */
export function recordMessage(run, path) {
	return messagedBuilder(run, path) ? { ...run, builderRounds: run.builderRounds + 1 } : run;
}

/** Options of the dialog that opens when a follow-up to a Builder would break a limit. */
export const BREAK_OPTIONS = ["Another round", "Accept with the known findings", "Replan", "Stop (keep the patch)"];

/**
 * Why the next follow-up to a Builder needs the user's decision, or undefined. `status` is the
 * Builder's last reported status; `noProgress` the reason from rounds.mjs progressBreak.
 */
export function followUpBreak(run, { status, noProgress }) {
	if (status === "needs_replan") return { level: "scope", reason: "the Builder reported that the change is bigger than its assignment" };
	if (status === "paused") return { level: "budget", reason: "the Builder paused" };
	const rounds = MAX_BUILDER_ROUNDS + (run.extraRounds ?? 0);
	if (run.builderRounds >= rounds) return { level: "rounds", reason: `the run used its ${rounds} Builder rounds` };
	if (noProgress) return { level: "progress", reason: noProgress };
	return undefined;
}

/**
 * The run and the tool-call outcome for the user's choice in the break dialog. Only "Another round"
 * lets the follow-up through; past the round cap it grants one more round and one more QA.
 */
export function applyBreakChoice(run, brk, choice) {
	const loopBreaks = [...run.loopBreaks, { level: brk.level, reason: brk.reason, decision: choice ?? "dismissed" }];
	const next = { ...run, loopBreaks };
	if (choice === BREAK_OPTIONS[0]) {
		if (brk.level !== "rounds") return { run: next, block: undefined };
		return { run: approveExtra({ ...next, extraRounds: (next.extraRounds ?? 0) + 1 }, "qa", 1), block: undefined };
	}
	const reasons = {
		[BREAK_OPTIONS[1]]: "The user accepts the change with the known findings: call apply_change.",
		[BREAK_OPTIONS[2]]: "The user wants a replan: call route with replan: true, then give the planner the Builder's findings and patch.",
		[BREAK_OPTIONS[3]]: "The user stopped the run: release its agents with write proc://<id>/kill; the patch stays in the artifacts directory.",
	};
	return { run: next, block: { block: true, reason: reasons[choice] ?? "The user closed the dialog: ask them how to go on." } };
}

const ISOLATED_AGENTS = new Set(["implementer", "qa"]);

const taskItems = (input) => (Array.isArray(input?.tasks) ? input.tasks : [input]);

// Why QA may not start now (an owed Builder yield, or no patch yet), or undefined.
function qaRefusal(latestPatch, owed) {
	if (owed.length > 0) {
		const { id, round } = owed[0];
		return `Builder ${id} has not yielded since your last message, so its newest patch (round ${round}) predates your request. Ask it to call yield with its structured result, then start QA.`;
	}
	if (!latestPatch) return "No Builder round patch to review yet: wait for the implementer's result first.";
	return undefined;
}

/**
 * The `task` call input with `isolated: true` on every implementer and qa item, and the patch to
 * review appended to qa items. `latestPatch` is the newest Builder round patch path of the run.
 * `owed` lists `{ id, round }` for each run Builder the Lead messaged since its last yield
 * (`round`: its newest recorded round, 0 for none). Returns `{ input }` (unchanged when no item
 * needs it) or `{ block, reason }` for QA without a patch or on a patch that predates a message.
 */
export function reviseTaskInput(input, latestPatch, owed = []) {
	const items = taskItems(input);
	if (!items.some((t) => ISOLATED_AGENTS.has(t?.agent))) return { input };
	const hasQa = items.some((t) => t?.agent === "qa");
	const reason = hasQa ? qaRefusal(latestPatch, owed) : undefined;
	if (reason) return { block: true, reason };
	const revise = (t) => (ISOLATED_AGENTS.has(t?.agent) ? isolatedItem(t, latestPatch) : t);
	return { input: Array.isArray(input.tasks) ? { ...input, tasks: input.tasks.map(revise) } : revise(input) };
}

// One implementer or qa task item, isolated; a qa item also names the patch to review.
function isolatedItem(t, latestPatch) {
	const task = t.agent === "qa" ? `${t.task}\n\nPatch to review (apply it with git apply): ${latestPatch}` : t.task;
	return { ...t, task, isolated: true };
}

const SHELL_CONTROL = ";&|<>\n";

// Whether the character at i starts a command substitution (backtick or `$(`).
const expandsAt = (command, i) => command[i] === "`" || (command[i] === "$" && command[i + 1] === "(");

// Next state of the quote scanner at i: the new quote, how far to skip, and whether i is a control character.
function scanStep(command, i, quote) {
	const ch = command[i];
	if (quote === "'") return { quote: ch === "'" ? "" : quote, skip: 0, control: false };
	if (ch === "\\") return { quote, skip: 1, control: false };
	if (quote === '"') return { quote: ch === '"' ? "" : quote, skip: 0, control: expandsAt(command, i) };
	if (ch === "'" || ch === '"') return { quote: ch, skip: 0, control: false };
	return { quote, skip: 0, control: expandsAt(command, i) || SHELL_CONTROL.includes(ch) };
}

/**
 * Index of the first shell control character outside quotes (`;`, `&`, `|`, `<`, `>`, newline,
 * backtick, `$(`), or -1. Single quotes hide everything; double quotes still expand `` ` `` and `$(`.
 */
export function shellControlAt(command) {
	let quote = "";
	for (let i = 0; i < command.length; i++) {
		const step = scanStep(command, i, quote);
		if (step.control) return i;
		quote = step.quote;
		i += step.skip;
	}
	return -1;
}

/** Whether the Lead may run this bash command: one git status/diff/log/show/fetch/commit/push or one gate command. */
export function leadBashAllowed(command) {
	const text = (command ?? "").trim();
	if (text === "" || shellControlAt(text) !== -1) return false;
	return GIT_ALLOWED.test(text) || gatesRun(text).length > 0;
}

function leadWriteRefusal(path) {
	if (LEAD_XD_BLOCKED.test(path)) return `The Lead does not change files (${path}). Start an implementer for changes.`;
	if (LEAD_WRITE.test(path) || PROC_KILL.test(path)) return undefined;
	return "The Lead writes only xd://, local://, out://, agent:// and proc://<id>/kill. Start an implementer to change files.";
}

const LEAD_BASH_REFUSAL =
	"The Lead runs only single git status|diff|log|show|fetch|commit|push commands and the quality-gate commands (crapper, dryer, coverage), without pipes, chaining or redirects. Use read/grep, or start a subagent.";

function leadGuard(toolName, input) {
	if (LEAD_BLOCKED.has(toolName)) return `The Lead does not change files (${toolName}). Start an implementer for changes.`;
	if (toolName === "write") return leadWriteRefusal(String(input?.path ?? ""));
	if (toolName === "bash" && !leadBashAllowed(String(input?.command ?? ""))) return LEAD_BASH_REFUSAL;
	return undefined;
}

function subagentGuard(name, toolName, input) {
	if (name === "planner" && toolName === "write" && !String(input?.path ?? "").startsWith("local://")) {
		return "The planner writes only to local:// (the plan file).";
	}
	if (name === "qa" && (LEAD_BLOCKED.has(toolName) || toolName === "write")) {
		return `QA judges the change and never edits (${toolName}). Report the problem as a finding.`;
	}
	return undefined;
}

/**
 * Edit guard for one tool call. `agent` is `{ kind: "main" | "sub", name }`. The Lead is guarded
 * only while the switch is on; planner and qa sessions always, since they exist only for it.
 * Returns `{ block: true, reason }` or undefined.
 */
export function guardToolCall({ enabled, agent, toolName, input }) {
	const reason = agent.kind === "main" ? (enabled ? leadGuard(toolName, input) : undefined) : subagentGuard(agent.name, toolName, input);
	return reason ? { block: true, reason } : undefined;
}

/** Title and options of the plan approval dialog; the title warns above the cost threshold. */
export function planDialog({ summary, estimateUsd, budget }) {
	const cost = Number.isFinite(estimateUsd) ? ` Estimate: $${estimateUsd.toFixed(2)}.` : " No estimate.";
	const warn = budget !== "off" && estimateUsd > COST_THRESHOLD_USD ? ` Above the $${COST_THRESHOLD_USD} threshold.` : "";
	return {
		title: `Approve the plan? ${summary}${cost}${warn}`,
		options: ["Approve and build", "Refine (give feedback)", "Stop"],
		overThreshold: warn !== "",
	};
}

/**
 * Budget in USD of a Builder started in `run`: the approved plan estimate, $5 in lane quick, and the
 * cost threshold for a build run without a plan.
 */
export function builderBudget(run) {
	if (run.lane === "quick") return QUICK_BUDGET_USD;
	return Number.isFinite(run.estimateUsd) && run.estimateUsd > 0 ? run.estimateUsd : COST_THRESHOLD_USD;
}

/**
 * Block for a Builder tool call once its cost reached PAUSE_FACTOR x its budget, or undefined.
 * Off while budget is off; `yield` always passes, so the Builder can hand back its status.
 */
export function pauseDecision({ costUsd, limitUsd, budget, toolName }) {
	if (budget === "off" || !(limitUsd > 0) || PAUSE_ALLOWED.has(toolName)) return undefined;
	if (costUsd < limitUsd * PAUSE_FACTOR) return undefined;
	return {
		block: true,
		reason:
			`Budget pause: this Builder has used $${costUsd.toFixed(2)}, ${PAUSE_FACTOR}x its $${limitUsd.toFixed(2)} budget. ` +
			"Stop working now and call yield with status paused: done, open, alternatives (cheaper path, reduced scope, stop) and remainingUsd.",
	};
}

/** The new budget after the user lets a paused Builder go on: spent so far plus its own estimate of the rest. */
export function continueBudget(spentUsd, remainingUsd, previousLimitUsd) {
	return spentUsd + (Number.isFinite(remainingUsd) && remainingUsd > 0 ? remainingUsd : previousLimitUsd);
}

/**
 * Summary of a run for the guardian run record (`orchestration`). `outcome` is open until
 * apply_change applied the change, the user stopped the run, or the lane was answer.
 */
export function runSummary(run, { pipelineVersion, qaVerdicts }) {
	return {
		runId: run.id,
		lane: run.lane,
		reason: run.reason,
		estimateUsd: run.estimateUsd,
		planApproved: run.planApproved,
		started: { ...run.started },
		builderRounds: run.builderRounds,
		qaVerdicts,
		replans: run.replans,
		loopBreaks: run.loopBreaks,
		outcome: run.outcome ?? (run.lane === "answer" ? "answered" : "open"),
		pipelineVersion,
	};
}

/** Footer text of a run: lane, and the newest Builder's cost against its budget. */
export function runFooter(run, { costUsd, limitUsd }) {
	if (!run) return undefined;
	const cost = limitUsd > 0 ? ` · builder $${(costUsd ?? 0).toFixed(2)} / $${limitUsd.toFixed(2)}` : "";
	return `${run.lane}${cost}`;
}
