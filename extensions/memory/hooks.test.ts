/**
 * Prompt-matched memory injection: drives the before_agent_start handler against a mock
 * ExtensionAPI and a real MemoryStorage in a scratch HOME.
 * Run: `node --experimental-strip-types --test extensions/memory/hooks.test.ts`
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { promptKeywords } from "./keywords.ts";

// DEV-NOTE: storage.ts resolves ~/.pi/memory at import time, so HOME must point
// at a scratch dir before the dynamic imports below.
const home = mkdtempSync(join(tmpdir(), "memory-hooks-test-"));
process.env.HOME = home;
const { MemoryStorage } = await import("./storage.ts");
const { registerHooks, RECALL_TYPE } = await import("./hooks.ts");

type Result = { systemPrompt: string; message?: { customType: string; content: string; details: { ids: string[] } } };

test.after(() => rmSync(home, { recursive: true, force: true }));

test("promptKeywords drops stop words, short words and numbers, keeps first-seen order", () => {
	assert.deepEqual(promptKeywords("How does the Backoff work? Wie ist das backoff in 2026 bei Kafka-Retries"), [
		"backoff",
		"work",
		"kafka",
		"retries",
	]);
	assert.deepEqual(promptKeywords("Größe prüfen"), ["größe", "prüfen"]);
	assert.equal(promptKeywords("alpha beta gamma delta epsilon zeta theta iota kappa lambda omega").length, 10);
	assert.deepEqual(promptKeywords("can you do that for me please?"), []);
});

test("before_agent_start injects prompt-matched memories once, outside the system prompt", async () => {
	const storage = new MemoryStorage();
	const save = (id: string, content: string, project: string, created_at: string) =>
		storage.upsertShared({ id, content, type: "decision", concepts: null, files: null, project, created_at });
	save("old", "kafka consumer retries use exponential backoff", "svc-a", "2026-01-01T00:00:00.000Z");
	save("other", "backoff capped at 30s", "svc-b", "2026-11-01T00:00:00.000Z");
	save("recent-match", "http client backoff is linear", "svc-a", "2026-11-05T00:00:00.000Z");
	for (let i = 0; i < 4; i++) save(`recent-${i}`, `unrelated note ${i}`, "svc-a", `2026-11-0${6 + i}T00:00:00.000Z`);

	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	registerHooks({ on: (name: string, fn: never) => handlers.set(name, fn) } as never, storage);
	const branch: unknown[] = [];
	const ctx = { cwd: "/repos/svc-a", sessionManager: { getBranch: () => branch }, ui: { notify: () => {} } };
	const fire = (prompt: string) =>
		handlers.get("before_agent_start")!({ prompt, systemPrompt: "BASE" }, ctx) as Promise<Result>;

	const first = await fire("Wie funktioniert das Backoff bei Kafka?");
	// The five newest memories sit in the system prompt; only the older match is added as a message.
	assert.match(first.systemPrompt, /http client backoff is linear/);
	assert.doesNotMatch(first.systemPrompt, /kafka consumer/);
	assert.equal(first.message?.customType, RECALL_TYPE);
	assert.deepEqual(first.message?.details.ids, ["old"]);
	assert.match(first.message!.content, /kafka consumer retries use exponential backoff/);
	assert.doesNotMatch(first.message!.content, /linear|capped/);

	// The system prompt does not depend on the prompt, so the provider cache prefix holds.
	assert.equal((await fire("something else entirely")).systemPrompt, first.systemPrompt);

	// A memory already recalled on this branch is not injected again.
	branch.push({ type: "custom_message", customType: RECALL_TYPE, details: first.message!.details });
	assert.equal((await fire("kafka backoff again")).message, undefined);
	storage.close();
});
