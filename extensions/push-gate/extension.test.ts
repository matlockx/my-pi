/**
 * Wiring test for the push gate: drives the tool_call/tool_result handlers and the
 * /push-gate command against a mock ExtensionAPI and a real temporary git repo.
 * Run: `node --experimental-strip-types --test extension.test.ts`
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { tempRepo } from "./test-repo.mjs";
import extension from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup(cwd: string) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		on: (name: string, fn: Handler) => handlers.set(name, fn),
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, def),
	};
	const ctx = { cwd, hasUI: false, ui: { notify: () => {} } };
	extension(pi as never);
	return {
		push: (toolName: string, input: Record<string, unknown>) =>
			handlers.get("tool_call")!({ toolName, input }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>,
		ranBash: (command: string) =>
			handlers.get("tool_result")!({ toolName: "bash", input: { command }, content: [{ type: "text", text: "ok" }] }, ctx),
		command: (name: string, args: string) => commands.get(name)!.handler(args, ctx),
	};
}

test("a push is blocked until both gates ran on the content being pushed", async (t) => {
	const { root, git } = tempRepo(t);
	const gate = setup(root);

	const blocked = await gate.push("jflow_pr", { path: root });
	assert.equal(blocked?.block, true);
	assert.match(blocked!.reason!, /crapper.*dryer/s);
	assert.match(blocked!.reason!, /quality-gates\.md/);

	await gate.ranBash("crapper --threshold 10 main.go");
	assert.match((await gate.push("bash", { command: "git push" }))!.reason!, /dryer/);
	assert.doesNotMatch((await gate.push("bash", { command: "git push" }))!.reason!, /crapper/);

	await gate.ranBash(`cd ${root} && dryer --threshold 0.8`);
	assert.equal(await gate.push("jflow_pr", { path: root }), undefined);

	// Committing the gated content keeps the gates current; a later edit does not.
	git("commit", "-qam", "noop", "--allow-empty");
	assert.equal(await gate.push("jflow_review_resolve", { path: root }), undefined);
	writeFileSync(join(root, "main.go"), "package main\n\nfunc x() {}\n");
	assert.equal((await gate.push("jflow_review_resolve", { path: root }))?.block, true);
});

test("/push-gate skip lets exactly one push through", async (t) => {
	const { root } = tempRepo(t);
	const gate = setup(root);

	await gate.command("push-gate", "skip");
	assert.equal(await gate.push("bash", { command: "git push origin HEAD" }), undefined);
	assert.equal((await gate.push("bash", { command: "git push origin HEAD" }))?.block, true);
});

test("repos without scored source and calls that do not push pass untouched", async (t) => {
	const { root, git } = tempRepo(t);
	git("rm", "-q", "main.go");
	writeFileSync(join(root, "main.tf"), "terraform {}\n");
	const gate = setup(root);

	assert.equal(await gate.push("jflow_pr", { path: root }), undefined);
	assert.equal(await gate.push("jflow_commit", { path: root }), undefined);
	assert.equal(await gate.push("bash", { command: "git status" }), undefined);
});
