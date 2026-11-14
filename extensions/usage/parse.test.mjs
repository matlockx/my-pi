import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HOUR_MS, accountHash, hourlyRows, logIdentity, parseEntries, promptFeature, scanSessions } from "./parse.mjs";

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const usage = (cost, extra = {}) => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: cost }, ...extra });
const header = (min = 0, extra = {}) => ({ type: "session", id: "s", timestamp: at(min), cwd: "/Users/x/projects/shop", ...extra });
const user = (min, text) => ({ type: "message", timestamp: at(min), message: { role: "user", content: [{ type: "text", text }] } });
const custom = (min, customType) => ({ type: "custom_message", timestamp: at(min), customType });
const reply = (min, cost, stopReason = "stop", provider = "anthropic") => ({
	type: "message",
	timestamp: at(min),
	message: { role: "assistant", provider, model: "claude-opus-5-5", usage: usage(cost), stopReason },
});
const pin = (min, hash, provider = "anthropic") => ({ type: "credential_pin", timestamp: at(min), provider, hash });

test("accountHash reproduces omp's credential_pin recipe and skips identities omp never pins", () => {
	assert.equal(
		accountHash("anthropic", { accountId: "acc-1", email: "a@example.com", orgId: "org-1" }),
		"d9290d67ee7568adfc673559ff6ba1826348dd0f722e96b3a94f7f166cb90e5d",
	);
	assert.equal(accountHash("github-copilot", { orgId: "org-1" }), undefined);
});

test("a run takes the feature of the message that started it, through every tool-call reply", () => {
	const { events, runs } = parseEntries([
		header(),
		user(1, "fix the bug"),
		custom(1, "memory-recall"),
		reply(2, 1, "toolUse"),
		custom(3, "jflow-watch"),
		reply(4, 1),
		custom(5, "quick-review-report"),
		user(6, "Address the quick-review findings above. Fix them."),
		reply(7, 1, "toolUse"),
		reply(8, 1),
		custom(9, "jflow-watch"),
		reply(10, 1),
		user(11, "/skill-install ub-mode"),
		reply(12, 1),
	]);
	assert.deepEqual(
		events.map((e) => e.feature),
		["user", "user", "quick-review-fix", "quick-review-fix", "jflow-watch", "command:/skill-install"],
	);
	assert.deepEqual(
		runs.map(([, f]) => f),
		["user", "quick-review-fix", "jflow-watch", "command:/skill-install"],
	);
});

test("a slash command needs a space or the end after its name; a pasted path is a plain prompt", () => {
	assert.equal(promptFeature("/review the diff"), "command:/review");
	assert.equal(promptFeature("/skill:plan"), "command:/skill:plan");
	assert.equal(promptFeature("/Users/me/projects/x/notes.md why does this fail?"), "user");
	assert.equal(promptFeature("/ordner/datei"), "user");
});

test("a session touched since the cutoff is read whole, its untouched subagent logs included", async () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-scan-"));
	const id = "01a1a136-b5fd-77f9-8e1d-040fb9157988";
	const lines = (...entries) => entries.map((e) => JSON.stringify(e)).join("\n");
	mkdirSync(join(dir, "-shop", `2026-11-13T10-00-00-000Z_${id}`), { recursive: true });
	const main = join(dir, "-shop", `2026-11-13T10-00-00-000Z_${id}.jsonl`);
	const sub = join(dir, "-shop", `2026-11-13T10-00-00-000Z_${id}`, "Scout.jsonl");
	writeFileSync(main, lines(header(), user(1, "go"), reply(2, 1)));
	writeFileSync(sub, lines(header(3), reply(4, 2)));
	utimesSync(main, new Date(T0), new Date(T0));
	const old = new Date(T0 - 10 * 24 * HOUR_MS);
	utimesSync(sub, old, old);
	const scan = await scanSessions(dir, T0 - HOUR_MS);
	assert.deepEqual(
		scan.rows.map((r) => [r.agent, r.cost]).sort(),
		[
			["Scout", 2],
			["main", 1],
		],
	);
	assert.equal((await scanSessions(dir, T0 + 24 * HOUR_MS)).rows.length, 0, "nothing touched: nothing read");
});

test("side requests are attributed by purpose and fall back to the current model", () => {
	const { events } = parseEntries([
		header(),
		{ type: "model_change", timestamp: at(0), model: "anthropic/claude-sonnet-5" },
		{ type: "model_usage", timestamp: at(1), purpose: "job-caption", provider: "anthropic", model: "claude-haiku-5", usage: usage(0.1) },
		{ type: "compaction", timestamp: at(2), usage: usage(0.2) },
	]);
	assert.deepEqual(
		events.map((e) => [e.feature, e.provider, e.model, e.cost]),
		[
			["side:job-caption", "anthropic", "claude-haiku-5", 0.1],
			["side:compaction", "anthropic", "claude-sonnet-5", 0.2],
		],
	);
});

test("requests before a provider's first pin take that pin; a later pin applies only from then on", () => {
	const { events } = parseEntries([
		header(),
		user(1, "go"),
		reply(2, 1, "toolUse"),
		reply(2, 1, "toolUse", "github-copilot"),
		pin(3, "A"),
		reply(4, 1, "toolUse"),
		pin(5, "B"),
		reply(6, 1),
	]);
	assert.deepEqual(
		events.map((e) => e.account),
		["A", undefined, "A", "B"],
	);
});

test("entries older than the session header are copies from another session and are skipped", () => {
	const { events } = parseEntries([header(30), reply(10, 5), user(31, "go"), reply(32, 1)]);
	assert.deepEqual(
		events.map((e) => e.cost),
		[1],
	);
});

test("logIdentity tells the main log from subagent logs of the same root session", () => {
	const dir = "/s";
	const id = "01a1a136-b5fd-77f9-8e1d-040fb9157988";
	assert.deepEqual(logIdentity(dir, join(dir, "-p", `2026-11-03T11-41-19-741Z_${id}.jsonl`)), {
		folder: "-p",
		sessionId: id,
		agent: "main",
	});
	assert.deepEqual(logIdentity(dir, join(dir, "-p", `2026-11-03T11-41-19-741Z_${id}`, "Scout.jsonl")), {
		folder: "-p",
		sessionId: id,
		agent: "Scout",
	});
	assert.equal(logIdentity(dir, join(dir, "-p", "notes.jsonl")), undefined);
});

test("hourlyRows sums per hour and counts subagents toward the root session and its active run", () => {
	const main = parseEntries([
		header(0),
		{ type: "title", title: "old" },
		pin(0, "A"),
		user(1, "plan it"),
		reply(2, 1),
		custom(20, "jflow-watch"),
		reply(21, 2),
		reply(61, 4),
		{ type: "title_change", timestamp: at(62), title: "Shop scope" },
	]);
	const sub = parseEntries([
		header(10, { cwd: "/elsewhere" }),
		user(10, "inventory the code"),
		reply(11, 8),
		{ type: "model_usage", timestamp: at(12), purpose: "task-completion-probe", usage: usage(0.5), provider: "anthropic", model: "m" },
	]);
	const rows = hourlyRows([
		{ folder: "-p", sessionId: "R", agent: "main", parsed: main },
		{ folder: "-p", sessionId: "R", agent: "Scout", parsed: sub },
	]);
	const pick = (r) => [r.hour - T0, r.agent, r.feature, r.title, r.project, r.account, r.requests, r.cost];
	assert.deepEqual(rows.map(pick).sort(), [
		[0, "Scout", "side:task-completion-probe", "Shop scope", "shop", "unpinned:anthropic", 1, 0.5],
		[0, "Scout", "user", "Shop scope", "shop", "unpinned:anthropic", 1, 8],
		[0, "main", "jflow-watch", "Shop scope", "shop", "A", 1, 2],
		[0, "main", "user", "Shop scope", "shop", "A", 1, 1],
		[HOUR_MS, "main", "jflow-watch", "Shop scope", "shop", "A", 1, 4],
	]);
});

test("guardian entries land in the ledger: latest run record per runId, findings with their run ids", async () => {
	const entry = (min, customType, data) => ({ type: "custom", timestamp: at(min), customType, data });
	const { ledger, events } = parseEntries([
		header(),
		entry(1, "guardian-run", { runId: "r1", costUsd: 1 }),
		entry(2, "guardian-run", { runId: "r1", costUsd: 1, rating: 4 }),
		entry(3, "guardian-findings", { runIds: ["r1"], findings: [{ scope: "task", category: "navigation", severity: "MED", evidence: "B:1", suggestion: "s" }] }),
		entry(4, "guardian-improvement", { id: "i1", decision: "applied" }),
		entry(5, "other-extension", { runId: "x" }),
	]);
	assert.equal(events.length, 0, "custom entries are not requests");
	assert.deepEqual(ledger.runs.map((r) => r.rating ?? null), [null, 4]);
	assert.deepEqual(ledger.findings.map((f) => [f.runIds, f.category]), [[["r1"], "navigation"]]);
	assert.deepEqual(ledger.improvements.map((i) => [i.id, i.date]), [["i1", T0 + 4 * 60_000]]);

	const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
	mkdirSync(join(dir, "-shop"));
	const lines = [header(), user(1, "x"), reply(2, 1), entry(3, "guardian-run", { runId: "r1", costUsd: 1 }), entry(4, "guardian-run", { runId: "r1", costUsd: 2 })];
	writeFileSync(join(dir, "-shop", "2026-11-13T10-00-00-000Z_01a1a136-b5fd-77f9-8e1d-040fb9157988.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
	const scan = await scanSessions(dir);
	assert.deepEqual(scan.ledger.runs.map((r) => [r.runId, r.costUsd, r.project]), [["r1", 2, "shop"]]);
});
