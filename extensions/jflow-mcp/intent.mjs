// A prompt the user typed that names jflow is the approval: "create pr with
// jflow" needs no second confirm dialog. Extension-injected prompts (e.g.
// quick-review follow-ups) never approve, only what the user typed or sent.

/** True when this input event pre-approves jflow tool calls for its turn. */
export function inputApprovesJflow(event) {
	return event?.source !== "extension" && /\bjflow\b/i.test(event?.text ?? "");
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
