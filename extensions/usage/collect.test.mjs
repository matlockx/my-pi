import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { accountsAndLimits, collect, pushReports, resolveUnpinned, runJson, sync, writeReports } from "./collect.mjs";
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

test("JSON output above Node's 1 MiB default buffer is read whole", () => {
	const script = "process.stdout.write(JSON.stringify({ entries: Array.from({ length: 20000 }, (_, i) => ({ i, pad: 'x'.repeat(100) })) }))";
	assert.equal(runJson(process.execPath, ["-e", script]).entries.length, 20000, "about 2.4 MB of output");
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function clone(remote, dir) {
	git(tmpdir(), "clone", "--quiet", remote, dir);
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
	git(dir, "config", "commit.gpgsign", "false");
}

function sessions(cost, extra = [], shift = 0) {
	const dir = mkdtempSync(join(tmpdir(), "usage-sessions-"));
	const id = "01a1a136-b5fd-77f9-8e1d-040fb9157988";
	mkdirSync(join(dir, "-shop"));
	const at = (m) => new Date(NOW + shift - 3_600_000 + m * 60_000).toISOString();
	const lines = [
		{ type: "session", id, timestamp: at(0), cwd: "/x/shop" },
		{ type: "message", timestamp: at(1), message: { role: "user", content: "go" } },
		{ type: "message", timestamp: at(2), message: { role: "assistant", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cost: { total: cost } }, stopReason: "stop" } },
		{ type: "credential_pin", timestamp: at(2), provider: "anthropic", hash: A },
		...extra.map((e) => ({ timestamp: at(3), ...e })),
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

test("a later run skips logs untouched for two days; backfill reads them and all history again", async () => {
	const repo = mkdtempSync(join(tmpdir(), "usage-backfill-"));
	const days = [];
	const usage = (d) => (days.push(d), { reports, history });
	await collect({ repo, device: "mac", sessionsDir: sessions(0), now: NOW, usage });
	const old = sessions(2);
	const stale = new Date(NOW - 5 * 24 * 3_600_000);
	utimesSync(join(old, "-shop", "2026-11-13T11-00-00-000Z_01a1a136-b5fd-77f9-8e1d-040fb9157988.jsonl"), stale, stale);

	assert.equal((await collect({ repo, device: "mac", sessionsDir: old, now: NOW, usage })).rows, 0);
	assert.equal((await collect({ repo, device: "mac", sessionsDir: old, now: NOW, usage, backfill: true })).rows, 1);
	assert.deepEqual(days, [3650, 3, 3650], "first run and backfill ask omp for all history");
	assert.deepEqual(
		readRepo(repo).rows.map((r) => r.cost),
		[2],
		"the backfilled row replaces the stored one by key",
	);
});

test("the first device to push a period's report wins, and the loser drops its copy without a conflict", async () => {
	const root = mkdtempSync(join(tmpdir(), "usage-reports-"));
	const remote = join(root, "remote.git");
	git(root, "init", "--quiet", "--bare", remote);
	const [a, b] = [join(root, "a"), join(root, "b")];
	const usage = () => ({ reports, history });
	clone(remote, a);
	await collect({ repo: a, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage });
	sync(a, "mac-a");
	clone(remote, b);
	await collect({ repo: b, device: "mac-b", sessionsDir: sessions(2), now: NOW, usage });
	sync(b, "mac-b");
	sync(a, "mac-a");

	// Both checkouts hold both devices' rows; 2026-11-13 ends at 23:00Z in Berlin, so the day is due
	// 24 hours later even though no snapshot shows a sync after its end.
	const later = Date.parse("2026-11-14T23:00:00.000Z");
	const day = join("reports", "daily", "2026-11-13.html");
	assert.ok(writeReports({ repo: a, now: later, tz: "Europe/Berlin", device: "mac-a" }).includes(day));
	assert.ok(writeReports({ repo: b, now: later, tz: "Europe/Berlin", device: "mac-b" }).includes(day));
	assert.equal(pushReports(a), "reports pushed");
	assert.match(pushReports(b), /^reports dropped/);
	assert.equal(existsSync(join(b, day)), false, "the losing copy is gone with its commit");

	assert.equal(sync(b, "mac-b"), "pulled");
	assert.deepEqual(writeReports({ repo: b, now: later, tz: "Europe/Berlin", device: "mac-b" }), [], "nothing left to write");
	assert.match(readFileSync(join(b, day), "utf8"), /by mac-a\./);
	assert.equal(pushReports(b), "reports unchanged");
});

test("a day waiting for a device is provisional, and rebuilt as final once it syncs or the wait ends", async () => {
	const repo = mkdtempSync(join(tmpdir(), "usage-wait-"));
	git(repo, "init", "--quiet");
	const usage = () => ({ reports: [], history: [] });
	const tz = "Europe/Berlin";
	await collect({ repo, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage });
	const day = join("reports", "daily", "2026-11-13.html");
	const early = Date.parse("2026-11-14T02:00:00.000Z");
	assert.ok(writeReports({ repo, now: early, tz, device: "mac-b" }).includes(day), "provisional, not absent");
	assert.match(readFileSync(join(repo, day), "utf8"), /· so far/);
	assert.deepEqual(writeReports({ repo, now: early, tz, device: "mac-b" }), [], "no new data: nothing rewritten");
	assert.deepEqual(writeReports({ repo, now: early + 3_600_000, tz, device: "mac-b" }), [], "the clock alone rebuilds nothing");

	const final = writeReports({ repo, now: Date.parse("2026-11-14T23:00:00.000Z"), tz, device: "mac-b" });
	assert.ok(final.includes(day), "the maximum wait ends: rebuilt as final");
	assert.doesNotMatch(readFileSync(join(repo, day), "utf8"), /· so far/);
});

test("a provisional day turns final once the device that holds it back syncs after the day", async () => {
	const repo = mkdtempSync(join(tmpdir(), "usage-late-"));
	git(repo, "init", "--quiet");
	const usage = () => ({ reports: [], history: [] });
	const tz = "Europe/Berlin";
	await collect({ repo, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage });
	const day = join("reports", "daily", "2026-11-13.html");
	const now = Date.parse("2026-11-14T10:00:00.000Z");
	writeReports({ repo, now, tz, device: "mac-a" });
	assert.match(readFileSync(join(repo, day), "utf8"), /· so far/);

	// The device syncs later: a limit snapshot after the day's end makes the day ready.
	const late = [{ ...reports[0], fetchedAt: Date.parse("2026-11-14T00:30:00.000Z") }];
	await collect({ repo, device: "mac-a", sessionsDir: sessions(1), now: now - 1, usage: () => ({ reports: late, history: [] }) });
	const rebuilt = writeReports({ repo, now, tz, device: "mac-a" });
	assert.ok(rebuilt.includes(day));
	assert.doesNotMatch(readFileSync(join(repo, day), "utf8"), /· so far/);
	assert.deepEqual(writeReports({ repo, now, tz, device: "mac-a" }), []);
});

test("today gets a provisional report, the running week and month cover it, and the index lists both as running", async () => {
	const repo = mkdtempSync(join(tmpdir(), "usage-today-"));
	git(repo, "init", "--quiet");
	const usage = () => ({ reports: [], history: [] });
	const tz = "Europe/Berlin";
	await collect({ repo, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage });
	await collect({ repo, device: "mac-b", sessionsDir: sessions(2, [], 24 * 3_600_000), now: NOW, usage });
	const now = Date.parse("2026-11-14T12:00:00.000Z");
	const written = writeReports({ repo, now, tz, device: "mac-a" });
	const path = (kind, key) => join("reports", kind, `${key}.html`);
	for (const p of [path("daily", "2026-11-13"), path("daily", "2026-11-14"), path("weekly", "2026-W46"), path("monthly", "2026-11")]) assert.ok(written.includes(p), p);
	const page = (p) => readFileSync(join(repo, p), "utf8");
	assert.match(page(path("daily", "2026-11-14")), /· so far/);
	assert.match(page(path("weekly", "2026-W46")), /data up to and including Sat 14 Nov/);
	assert.match(page(path("daily", "2026-11-13")), /href="\.\.\/daily\/2026-11-14\.html">2026-11-14 →/, "yesterday links to today");
	const index = page(join("reports", "index.html"));
	for (const p of ["daily/2026-11-13", "daily/2026-11-14", "weekly/2026-W46", "monthly/2026-11"]) assert.match(index, new RegExp(`${p}\\.html[^]*?<em class="badge">running</em>`));
	assert.equal((index.match(/<em class="badge">running<\/em>/g) ?? []).length, 5, "both days, the week, the month and the year");
	assert.deepEqual(writeReports({ repo, now, tz, device: "mac-a" }), [], "a second run without new data writes nothing");
});

test("a final ready day keeps its hash when a later day appears", async () => {
	const repo = mkdtempSync(join(tmpdir(), "usage-final-"));
	git(repo, "init", "--quiet");
	await collect({ repo, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage: () => ({ reports: [], history: [] }) });
	const tz = "Europe/Berlin";
	const day = join("reports", "daily", "2026-11-13.html");
	writeReports({ repo, now: Date.parse("2026-11-16T12:00:00.000Z"), tz, device: "mac-a" });
	const before = readFileSync(join(repo, day), "utf8");
	assert.deepEqual(writeReports({ repo, now: Date.parse("2026-11-16T15:00:00.000Z"), tz, device: "mac-a" }), [], "hours later, nothing changes");
	assert.equal(readFileSync(join(repo, day), "utf8"), before);
});

test("reports reach back to the oldest data, and a new device rebuilds only the periods it adds data to", async () => {
	const repo = mkdtempSync(join(tmpdir(), "usage-history-"));
	git(repo, "init", "--quiet");
	const usage = () => ({ reports: [], history: [] });
	const tz = "Europe/Berlin";
	const later = Date.parse("2026-12-20T12:00:00.000Z");
	const report = (kind, key) => join("reports", kind, `${key}.html`);
	await collect({ repo, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage });

	const first = writeReports({ repo, now: later, tz, device: "mac-a" });
	assert.equal(first[0], report("daily", "2026-11-13"), "nothing before the oldest row");
	for (const p of [report("daily", "2026-11-20"), report("weekly", "2026-W46"), report("monthly", "2026-11")]) assert.ok(first.includes(p), p);
	assert.deepEqual(writeReports({ repo, now: later, tz, device: "mac-a" }), [], "unchanged data rewrites nothing");

	await collect({ repo, device: "mac-b", sessionsDir: sessions(2), now: NOW, usage });
	const rebuilt = writeReports({ repo, now: later, tz, device: "mac-a" });
	for (const p of [report("daily", "2026-11-13"), report("daily", "2026-11-14"), report("weekly", "2026-W46"), report("monthly", "2026-11")])
		assert.ok(rebuilt.includes(p), `${p}: its period or the one it compares with gained rows`);
	assert.equal(rebuilt.includes(report("daily", "2026-11-20")), false);
	assert.match(readFileSync(join(repo, report("daily", "2026-11-13")), "utf8"), /\$3\.00/, "both devices' cost");
});

test("a report links forward once the next period has a report, and is rebuilt to add the link", async () => {
	const repo = mkdtempSync(join(tmpdir(), "usage-next-"));
	git(repo, "init", "--quiet");
	await collect({ repo, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage: () => ({ reports: [], history: [] }) });
	const tz = "Europe/Berlin";
	const page = (key) => readFileSync(join(repo, "reports", "daily", `${key}.html`), "utf8");
	writeReports({ repo, now: Date.parse("2026-11-16T12:00:00.000Z"), tz, device: "mac-a" });
	assert.match(page("2026-11-14"), /href="\.\.\/daily\/2026-11-15\.html">2026-11-15 →/);
	assert.doesNotMatch(page("2026-11-15"), /2026-11-16 →/, "the newest day has nothing to link to");

	const nextDay = writeReports({ repo, now: Date.parse("2026-11-17T12:00:00.000Z"), tz, device: "mac-a" });
	assert.ok(nextDay.includes(join("reports", "daily", "2026-11-15.html")), "rebuilt for the new link");
	assert.match(page("2026-11-15"), /href="\.\.\/daily\/2026-11-16\.html">2026-11-16 →/);
});

test("guardian run records reach the repo, the Guardian page and the period's Pipeline section; a re-run writes nothing", async () => {
	const repo = mkdtempSync(join(tmpdir(), "usage-ledger-"));
	git(repo, "init", "--quiet");
	const usage = () => ({ reports: [], history: [] });
	const tz = "Europe/Berlin";
	const later = Date.parse("2026-11-16T12:00:00.000Z");
	await collect({ repo, device: "mac-a", sessionsDir: sessions(1), now: NOW, usage });
	writeReports({ repo, now: later, tz, device: "mac-a" });
	assert.equal(existsSync(join(repo, "reports", "guardian", "index.html")), false, "no ledger, no page");

	const run = { type: "custom", customType: "guardian-run", data: { runId: "r1", startedAt: NOW - 3_000_000, costUsd: 1, mode: "orchestrated", orchestration: { runId: "o1", lane: "build", qaVerdicts: [] } } };
	await collect({ repo, device: "mac-a", sessionsDir: sessions(1, [run]), now: NOW, usage });
	assert.deepEqual(readRepo(repo).runs.map((r) => r.runId), ["r1"]);
	const written = writeReports({ repo, now: later, tz, device: "mac-a" });
	assert.ok(written.includes(join("reports", "guardian", "index.html")));
	assert.ok(written.includes(join("reports", "daily", "2026-11-13.html")), "the ledger is part of the report's input hash");
	assert.match(readFileSync(join(repo, "reports", "daily", "2026-11-13.html"), "utf8"), /<h2>Pipeline<\/h2>/);
	assert.match(readFileSync(join(repo, "reports", "index.html"), "utf8"), /href="guardian\/index\.html"/);
	assert.deepEqual(writeReports({ repo, now: later, tz, device: "mac-a" }), []);
});
