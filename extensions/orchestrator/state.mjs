/**
 * Orchestrator switch: command parsing, saved state, the omp settings it overrides, and the
 * conflict with omp's own plan and vibe modes. Pure apart from reading persona files; index.ts
 * applies the results.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { COST_THRESHOLD_USD, MAX_BUILDER_ROUNDS, PAUSE_FACTOR, QUICK_BUDGET_USD } from "./gate.mjs";

// Files whose content defines the pipeline; with PIPELINE_SETTINGS they make the pipeline version.
const PIPELINE_FILES = ["./lead.md", "../../agents/planner.md", "../../agents/implementer.md", "../../agents/qa.md", "../../agents/guardian.md", "../../prompts/quick-review.md"].map((p) =>
	fileURLToPath(new URL(p, import.meta.url)),
);

export const STATE_ENTRY = "orchestrator";
/** Agent definitions (my-pi/agents) that exist only for orchestrator mode; disabled while it is off. */
export const ORCHESTRATOR_AGENTS = ["planner", "implementer", "qa"];
/** Task isolation while orchestrator mode is on: patch mode, patches kept unapplied. */
export const ISOLATION = { "task.isolation.enabled": true, "task.isolation.merge": "patch", "task.isolation.apply": false };
/** Soft request budgets per role while orchestrator mode is on; omp force-stops an agent at 1.5x. */
export const REQUEST_BUDGETS = { implementer: 150, qa: 80, planner: 80, guardian: 40 };
export const DISABLED_AGENTS = "task.disabledAgents";
export const SOFT_BUDGETS = "task.agentSoftRequestBudget";
/** omp settings orchestrator mode may override. */
export const SETTING_IDS = [...Object.keys(ISOLATION), DISABLED_AGENTS, SOFT_BUDGETS];
/** PR review rounds per pull request the Lead may run in orchestrator mode (jflow allows 10). */
export const PR_ROUND_CAP = 3;
/** Agents in whose sessions quick-review stands down while orchestrator mode is on (QA replaces it). */
const QA_REPLACES_REVIEW = new Set(["implementer", "qa", "planner", "guardian"]);

const USAGE = "Usage: /orchestrate on | off | status | budget on|off | rate <1-5> [note]";
const DEFAULT_STATE = { enabled: false, budget: "on" };

const rateCommand = (rest) => {
	const rating = Number(rest[0]);
	if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: "Rating must be a whole number from 1 to 5." };
	const note = rest.slice(1).join(" ");
	return note ? { action: "rate", rating, note } : { action: "rate", rating };
};

const budgetCommand = (rest) => {
	const value = (rest[0] ?? "").toLowerCase();
	return (value === "on" || value === "off") && rest.length === 1 ? { action: "budget", value } : { error: USAGE };
};

const COMMANDS = {
	"": () => ({ action: "status" }),
	status: () => ({ action: "status" }),
	on: (rest) => (rest.length ? { error: USAGE } : { action: "on" }),
	off: (rest) => (rest.length ? { error: USAGE } : { action: "off" }),
	budget: budgetCommand,
	rate: rateCommand,
};

/** Parses the `/orchestrate` arguments into `{ action, ... }` or `{ error }`. */
export function parseCommand(args) {
	const [word = "", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const command = Object.hasOwn(COMMANDS, word.toLowerCase()) ? COMMANDS[word.toLowerCase()] : undefined;
	return command ? command(rest) : { error: USAGE };
}

/** Global switch default shared by all sessions (only `enabled`; the budget stays per session). */
export const GLOBAL_DEFAULT_PATH = join(homedir(), ".omp", "agent", "orchestrator.json");

/** Global default of the switch from `path`; off when the file is missing, unreadable or malformed. */
export function readGlobalDefault(path = GLOBAL_DEFAULT_PATH) {
	try {
		return JSON.parse(readFileSync(path, "utf8"))?.enabled === true;
	} catch {
		return false;
	}
}

/** Writes the global default to `path` atomically (temp file, then rename), creating its directory. Throws on I/O failure. */
export function writeGlobalDefault(enabled, path = GLOBAL_DEFAULT_PATH) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ enabled: enabled === true })}\n`);
	renameSync(tmp, path);
}

const savedEntry = (entries) => (entries ?? []).findLast((e) => e?.type === "custom" && e.customType === STATE_ENTRY && e.data && typeof e.data === "object");

/** Whether a session branch carries a saved switch state (false for a new session). */
export const hasSavedState = (entries) => savedEntry(entries) !== undefined;

/**
 * Latest saved switch state on a session branch. A branch with no saved state (a new session)
 * starts with `globalDefault` (boolean, off when omitted) and budget on.
 */
export function loadState(entries, globalDefault = false) {
	const saved = savedEntry(entries);
	if (!saved) return { ...DEFAULT_STATE, enabled: globalDefault === true };
	return { enabled: saved.data.enabled === true, budget: saved.data.budget === "off" ? "off" : "on" };
}

/** Why orchestrator mode cannot be switched on under the given omp mode state, or undefined. */
export function modeConflict(modes) {
	if (modes?.plan === "active" || modes?.plan === "paused") return "omp plan mode is on; leave it first (Alt+Shift+P)";
	if (modes?.vibe === "active") return "omp vibe mode is on; leave it first (/vibe)";
	return undefined;
}

/**
 * Setting overrides orchestrator mode wants, by setting id. `base` holds the user's own values of
 * `task.disabledAgents` and `task.agentSoftRequestBudget`. Settings absent from the result carry
 * the user's value unchanged (their override is released).
 */
export function settingsPlan(enabled, base) {
	if (enabled) return { ...ISOLATION, [SOFT_BUDGETS]: { ...(base?.[SOFT_BUDGETS] ?? {}), ...REQUEST_BUDGETS } };
	return { [DISABLED_AGENTS]: [...new Set([...(base?.[DISABLED_AGENTS] ?? []), ...ORCHESTRATOR_AGENTS])] };
}

/** `owner/repo#N`-style key of a jflow watcher review-round prompt, or undefined for other prompts. */
export function prRoundKey(prompt) {
	const text = prompt ?? "";
	if (!/^jflow watcher, round \d+/.test(text)) return undefined;
	const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(text);
	if (url) return `${url[1]}#${url[2]}`;
	const pr = /PR #(\d+)/.exec(text);
	return pr ? `#${pr[1]}` : "PR";
}

/** Whether quick-review skips this session: orchestrator mode on, in the Lead or an orchestrator agent. */
export function quickReviewStandsDown(mode, agent) {
	if (mode !== "orchestrated") return false;
	return agent.kind === "main" || QA_REPLACES_REVIEW.has(agent.name);
}

/** `pi.events` channel carrying `{ text }` whenever the switch changes; lean-footer draws it. */
export const FOOTER_EVENT = "orchestrator:footer";

/** Switch text of a FOOTER_EVENT payload, or undefined. */
export function footerText(data) {
	return typeof data?.text === "string" ? data.text : undefined;
}

/** Whether a footer text (`statusText`) says the switch is on. */
export const footerOn = (text) => text.startsWith("orch: on");

/**
 * Setting handles of `ids` from omp's settings registry module (`lookup(id)` returns a handle with
 * get, override and clearOverride). Undefined when the module has no `lookup`.
 */
export function handlesOf(mod, ids) {
	if (typeof mod?.lookup !== "function") return undefined;
	const isHandle = (h) => typeof h?.get === "function" && typeof h.override === "function" && typeof h.clearOverride === "function";
	return new Map(ids.map((id) => [id, mod.lookup(id)]).filter(([, h]) => isHandle(h)));
}

/** omp plan/vibe state of a handler context (`ctx.sessionModes.getState()`); undefined outside the interactive TUI. */
export function sessionModeState(ctx) {
	const modes = ctx?.sessionModes;
	return typeof modes?.getState === "function" ? modes.getState() : undefined;
}

/** Footer text of the switch, shown on and off (user requirement: the state is always visible). */
export function statusText(state) {
	if (!state.enabled) return "orch: off";
	return state.budget === "off" ? "orch: on · budget off" : "orch: on";
}

/** omp setting that shows each pinned subagent's current tool call below its row. */
export const LIVE_PREVIEW = "display.subagentLivePreview";

/**
 * Notice after `/orchestrate on`. While the live preview is off and the hint was not shown in this
 * session yet, it names the setting: Builder and QA work happens in subagents.
 */
export function onNotice({ previewOn, hinted }) {
	const notice = "Orchestrator mode on: the Lead routes your next request.";
	if (previewOn !== false || hinted) return notice;
	return `${notice} Tip: set ${LIVE_PREVIEW} to true (/settings) to see each subagent's current tool call.`;
}

/**
 * Version of the orchestration pipeline: a hash of the persona files and the settings that shape a
 * run. A retro change to any of them starts a new version, so runs can be compared before and after.
 */
export function pipelineVersion(files, settings) {
	const hash = createHash("sha256");
	for (const file of [...files].sort()) {
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			text = "(missing)";
		}
		hash.update(`${file.split("/").slice(-2).join("/")}\u001f${text}\u001e`);
	}
	hash.update(JSON.stringify(settings));
	return hash.digest("hex").slice(0, 12);
}

/** Planner note on past estimate accuracy, or undefined without enough data (ledger.mjs estimateAccuracy). */
export function accuracyNote(accuracy) {
	if (!accuracy || accuracy.runs < 3) return undefined;
	const r = accuracy.ratio;
	const how = r > 1.15 ? `cost ${r.toFixed(2)}x the estimate; estimate higher` : r < 0.85 ? `cost ${r.toFixed(2)}x the estimate; estimate lower` : "were close to the estimates";
	return `Past estimate accuracy: the last ${accuracy.runs} planned runs ${how}.`;
}

/** Pipeline version of the persona files and orchestrator settings as they are now. */
export function currentPipelineVersion() {
	return pipelineVersion(PIPELINE_FILES, { ...settingsPlan(true, {}), cost: { COST_THRESHOLD_USD, QUICK_BUDGET_USD, PAUSE_FACTOR, MAX_BUILDER_ROUNDS } });
}
