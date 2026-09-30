/**
 * Wiring test for the agent_end handler: drives it against a mock ExtensionAPI.
 * Run: `node --experimental-strip-types --test extension.test.ts`
 *
 * Covers the dialog timing; the review/fix rules are covered by gate.test.mjs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import extension from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Loads the extension against a fresh mock pi; the confirm dialog stays open until answered. */
function setup() {
	const handlers = new Map<string, Handler>();
	const sent: Array<{ text: string; options: unknown }> = [];
	const dialog = Promise.withResolvers<boolean>();
	let idle = false;

	const pi = {
		on: (name: string, fn: Handler) => handlers.set(name, fn),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: (text: string, options: unknown) =>
			sent.push({ text, options }),
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	};
	const ctx = {
		cwd: "/nonexistent",
		hasUI: true,
		isIdle: () => idle,
		ui: {
			notify: () => {},
			setStatus: () => {},
			confirm: () => dialog.promise,
		},
	};
	extension(pi as never);

	return {
		sent,
		endTurn: (text: string) =>
			handlers.get("agent_end")!(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: text },
					],
				},
				ctx,
			),
		answer: async (ok: boolean) => {
			idle = true; // the loop has ended by the time the user answers
			dialog.resolve(ok);
			// Flush the detached continuation, which the handler no longer exposes.
			await new Promise((r) => setImmediate(r));
		},
	};
}

const LOW_ONLY =
	"**VERDICT: PASS**\n\n## Findings\n\n**LOW** `a.ts:1` — nit → tidy";

// The handler awaiting the open dialog would never settle; the test timeout turns that
// hang into a failure.
test("agent_end returns while the fix dialog is still open", { timeout: 2000 }, async () => {
	const { sent, endTurn, answer } = setup();

	await endTurn(LOW_ONLY);
	assert.equal(sent.length, 0, "nothing sent before the answer");

	await answer(true);
	assert.equal(sent.length, 1);
	assert.match(sent[0].text, /^Address the quick-review findings/);
	assert.equal(sent[0].options, undefined, "idle agent: message starts a turn");

	// The fix turn's own agent_end is routed as the fix echo, not a new review.
	await endTurn("fixed it");
	assert.equal(sent.length, 1);
});

test("declining the fix dialog sends nothing", { timeout: 2000 }, async () => {
	const { sent, endTurn, answer } = setup();
	await endTurn(LOW_ONLY);
	await answer(false);
	assert.equal(sent.length, 0);
});
