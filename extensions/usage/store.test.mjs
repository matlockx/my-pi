import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HOUR_MS } from "./parse.mjs";
import { deviceName, readRepo, writeAccounts, writeLimits, writeRows } from "./store.mjs";

const DAY1 = Date.parse("2026-11-12T23:00:00.000Z");
const row = (hour, sessionId, cost, extra = {}) => ({
	hour,
	sessionId,
	project: "shop",
	title: "t",
	agent: "main",
	feature: "user",
	provider: "anthropic",
	model: "m",
	account: "A",
	requests: 1,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost,
	premium: 0,
	...extra,
});
const repo = () => mkdtempSync(join(tmpdir(), "usage-store-"));

test("re-running a write changes nothing; a newer value replaces; rows missing from a later scan stay", () => {
	const dev = join(repo(), "devices", "mac-1");
	const rows = [row(DAY1, "s1", 1), row(DAY1 + HOUR_MS, "s1", 2)];
	assert.equal(writeRows(dev, rows), 2, "one file per UTC day");
	assert.equal(writeRows(dev, rows), 0);
	assert.equal(writeRows(dev, [row(DAY1, "s1", 5)]), 1);
	const { rows: back } = readRepo(join(dev, "..", ".."));
	assert.deepEqual(back.map((r) => [r.hour, r.cost]).sort(), [
		[DAY1, 5],
		[DAY1 + HOUR_MS, 2],
	]);
});

test("titles and projects are redacted before they reach the repository", () => {
	const root = repo();
	// Assembled at runtime so no secret-shaped literal sits in the source.
	const token = ["ghp", "_", "Ab3".repeat(12)].join("");
	writeRows(join(root, "devices", "mac-1"), [row(DAY1, "s1", 1, { title: `fix ${token} leak`, project: token })]);
	const text = readFileSync(join(root, "devices", "mac-1", "hourly", "2026-11-12.jsonl"), "utf8");
	assert.ok(!text.includes(token));
	assert.equal(text.match(/REDACTED/g)?.length, 2);
});

test("readRepo unions devices, filters the time range, and can leave one device out", () => {
	const root = repo();
	writeRows(join(root, "devices", "mac-1"), [row(DAY1, "s1", 1), row(DAY1 + 2 * HOUR_MS, "s1", 2)]);
	writeRows(join(root, "devices", "mac-2"), [row(DAY1 + HOUR_MS, "s2", 4)]);
	writeLimits(join(root, "devices", "mac-2"), [
		{ recordedAt: DAY1 + 5, provider: "anthropic", account: "A", limitId: "anthropic:5h", usedFraction: 0.2 },
	]);
	const all = readRepo(root, { since: DAY1 + HOUR_MS });
	assert.deepEqual(all.rows.map((r) => [r.device, r.cost]).sort(), [
		["mac-1", 2],
		["mac-2", 4],
	]);
	assert.equal(all.limits.length, 0, "snapshot before since");
	const others = readRepo(root, { excludeDevice: "mac-2" });
	assert.deepEqual(others.rows.map((r) => r.device), ["mac-1", "mac-1"]);
	assert.equal(readRepo(root, { until: DAY1 + 1 }).rows.length, 1);
});

test("labels: the root accounts.json wins over devices, and the first device in name order over later ones", () => {
	const root = repo();
	writeAccounts(join(root, "devices", "b-mac"), { A: "from b", B: "only b" });
	writeAccounts(join(root, "devices", "a-mac"), { A: "from a", C: "from a" });
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "accounts.json"), JSON.stringify({ C: "manual" }));
	assert.deepEqual(readRepo(root).labels, { A: "from a", B: "only b", C: "manual" });
	assert.equal(writeAccounts(join(root, "devices", "a-mac"), { A: "from a" }), false);
});

test("deviceName keeps hosts apart that share a hostname", () => {
	assert.equal(deviceName("Martins-MBP.local", "1f2e3d4c-aaaa\n"), "Martins-MBP-1f2e3d4c");
	assert.notEqual(deviceName("mac", "11111111"), deviceName("mac", "22222222"));
});
