/**
 * Process-wide guardian registry and the run record built from it.
 *
 * omp evaluates the extension module once per session, subagent sessions included, so module
 * state is per session. The registry lives on globalThis under a Symbol.for key, which every
 * session of the omp process shares: the main session announces its current run there, and
 * each subagent session registers its meter under its agent id.
 */

import { snapshot, sumSnapshots } from "./meter.mjs";

const KEY = Symbol.for("my-pi.guardian.registry");
/** Custom session entry type of run records; the latest entry per runId wins. */
export const RUN_ENTRY = "guardian-run";

/**
 * The registry of a scope (globalThis in production), created on first use. `mode` is set by the
 * orchestrator extension ("off" | "orchestrated"); `lastRecord` is the latest run record written;
 * `orchestration` is a function the orchestrator sets that returns the summary of its current run
 * (copied into the run record as `orchestration`).
 */
export function registry(scope = globalThis) {
	scope[KEY] ??= { run: undefined, agents: new Map(), mode: "off", lastRecord: undefined, orchestration: undefined };
	return scope[KEY];
}

/**
 * Makes `run` ({ runId, sessionId, startedAt }) the current run. Agents of earlier runs that have
 * ended are dropped, so the registry does not grow over a long session.
 */
export function startRun(reg, run) {
	for (const [id, agent] of reg.agents) if (agent.ended && agent.runId !== run.runId) reg.agents.delete(id);
	reg.run = run;
}

/** Registers a subagent's meter with the current run; returns that run's id (undefined without one). */
export function joinRun(reg, { id, role, meter }) {
	const runId = reg.run?.runId;
	reg.agents.set(id, { id, role, meter, runId, ended: false });
	return runId;
}

/** Marks a subagent as ended; its figures stay until the next run starts. */
export function endAgent(reg, id) {
	const agent = reg.agents.get(id);
	if (agent) agent.ended = true;
}

/**
 * The run record (`guardian-run` session entry) of a finished main-session run: totals over the
 * main session and every subagent registered with the run, per-agent figures, work items.
 * Subagents still running at that point are marked `running` with their figures so far.
 */
export function buildRunRecord({ run, mode, mainMeter, agents, branch, workItems, endedAt }) {
	const parts = [
		{ id: "Main", role: "main", running: false, figures: snapshot(mainMeter) },
		...agents.filter((a) => a.runId === run.runId).map((a) => ({ id: a.id, role: a.role, running: !a.ended, figures: snapshot(a.meter) })),
	];
	const total = sumSnapshots(parts.map((p) => p.figures));
	return {
		runId: run.runId,
		sessionId: run.sessionId,
		mode,
		startedAt: run.startedAt,
		endedAt,
		branch,
		workItems,
		costUsd: total.costUsd,
		requests: total.requests,
		tokens: total.tokens,
		waste: total.waste,
		perAgent: parts.map((p) => ({ id: p.id, role: p.role, running: p.running, costUsd: p.figures.costUsd, requests: p.figures.requests })),
		loopBreaks: parts.flatMap((p) => p.figures.loopBreaks.map((b) => ({ ...b, agent: p.id }))),
	};
}
