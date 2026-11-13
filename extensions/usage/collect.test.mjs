import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { accountsAndLimits, collect, resolveUnpinned, sync } from "./collect.mjs";
import { accountHash } from "./parse.mjs";
import { readRepo } from "./store.mjs";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const anthropic = { accountId: "acc-1", email: "a@example.com", orgId: "org-1", orgName: "Org" };
const A = accountHash("anthropic", anthropic);
const C = accountHash("github-copilot", { accountId: "gh-user" });
const reports = [
	{
		provider: "anthropic",
		fetchedAt: NOW,
		metadata: anthropic,
		limits: [
			{ id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0.4 }, window: { label: "5 Hour", durationMs: 18e6, resetsAt: NOW + 1 } },
		],
	},
	{ provider: "github-copilot", fetchedAt: NOW, metadata: { accountId: "gh-user" }, limits: [] },
];
const history = [
	{ recordedAt: NOW - 1, provider: "anthropic", accountId: "acc-1", email: "a@example.com", limitId: "anthropic:5h", usedFraction: 0.3 },
	{ recordedAt: NOW - 2, provider: "github-copilot", accountId: null, limitId: "copilot:premium", usedFraction: 0.1 },
];

test("accounts are labelled from usage reports, and history joins them by provider, accountId and email", () => {
	const r = accountsAndLimits(reports, history);
	assert.deepEqual(r.labels, { [A]: "anthropic: a@example.com (Org)", [C]: "github-copilot: gh-user" });
	assert.deepEqual(
		r.snapshots.map((s) => [s.account, s.recordedAt, s.usedFraction]),
		[
			[A, NOW, 0.4],
			[A, NOW - 1, 0.3],
		],
	);
	assert.equal(r.unmatched, 1);
});

test("unpinned rows take the provider's account only when the device has exactly one", () => {
	const rows = [
		{ provider: "github-copilot", account: "unpinned:github-copilot" },
		{ provider: "openai", account: "unpinned:openai" },
	];
	const two = new Map([["openai", ["x", "y"]], ["github-copilot", [C]]]);
	assert.deepEqual(
		resolveUnpinned(rows, two).map((r) => r.account),
		[C, "unpinned:openai"],
	);
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function clone(remote, dir) {
	git(tmpdir(), "clone", "--quiet", remote, dir);
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
	git(dir, "config", "commit.gpgsign", "false");
}

function sessions(cost) {
	const dir = mkdtempSync(join(tmpdir(), "usage-sessions-"));
	const id = "01a1a136-b5fd-77f9-8e1d-040fb9157988";
	mkdirSync(join(dir, "-shop"));
	const at = (m) => new Date(NOW - 3_600_000 + m * 60_000).toISOString();
	const lines = [
		{ type: "session", id, timestamp: at(0), cwd: "/x/shop" },
		{ type: "message", timestamp: at(1), message: { role: "user", content: "go" } },
		{ type: "message", timestamp: at(2), message: { role: "assistant", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cost: { total: cost } }, stopReason: "stop" } },
		{ type: "credential_pin", timestamp: at(2), provider: "anthropic", hash: A },
	];
	writeFileSync(join(dir, "-shop", `2026-11-13T11-00-00-000Z_${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
	return dir;
}

test("two devices push to one remote in turn without conflicts, and a re-run writes nothing", async () => {
	const root = mkdtempSync(join(tmpdir(), "usage-remote-"));
	const remote = join(root, "remote.git");
	git(root, "init", "--quiet", "--bare", remote);
	const a = join(root, "a");
	const b = join(root, "b");
	clone(remote, a);
	const usage = () => ({ reports, history });

	const first = await collect({ repo: a, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage });
	assert.equal(first.rows, 1);
	assert.equal(sync(a, "mac-a"), "pushed (upstream set)");

	clone(remote, b);
	await collect({ repo: b, device: "mac-b", sessionsDir: sessions(2), now: NOW, usage });
	assert.equal(sync(b, "mac-b"), "pushed");

	const again = await collect({ repo: a, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage });
	assert.equal(again.changed, 0);
	assert.equal(sync(a, "mac-a"), "pulled");
	assert.ok(existsSync(join(a, "devices", "mac-b", "hourly", "2026-11-13.jsonl")));
	assert.deepEqual(
		readRepo(a).rows.map((r) => [r.device, r.cost, r.account]),
		[
			["mac-a", 1, A],
			["mac-b", 2, A],
		],
	);
});
