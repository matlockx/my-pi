// A prompt the user typed that names jflow is the approval: "create pr with
// jflow" needs no second confirm dialog. Extension-injected prompts (e.g.
// quick-review follow-ups) never approve, only what the user typed or sent.

/** True when this input event pre-approves jflow tool calls for its turn. */
export function inputApprovesJflow(event) {
	return event?.source !== "extension" && /\bjflow\b/i.test(event?.text ?? "");
}

// Repos under this GitHub org get auto-approve by default (https or ssh remote).
const AUTO_ORG = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])BauerMediaGroup-Stardust\//i;

/** True when a git remote URL points at github.com/BauerMediaGroup-Stardust/*. */
export function isAutoRemote(url) {
	return AUTO_ORG.test(url?.trim() ?? "");
}

/**
 * True when an agent call asks review_status to merge while /jflow-merge is
 * off: only the user turns merging on, never the agent.
 */
export function agentMergeBlocked(toolName, args, mergeOn) {
	return toolName === "review_status" && Boolean(args?.merge) && !mergeOn;
}

/**
 * Footer status: transport, whether the server answered, and auto-approve.
 * undefined (no status) when stdio jflow is simply not installed.
 */
export function statusText({ mode, up, auto }) {
	if (up === undefined) return undefined;
	if (!up) return `jflow: ${mode} down`;
	return `jflow: ${mode}${auto ? " auto" : ""} ✓`;
}
