import test from "node:test";
import assert from "node:assert/strict";

import { delay, describeWatch, MAX_FAILURES, MAX_ROUNDS, nextStep, notifiedMessage, parseStatus, watchFooter, watchPR } from "./watch.mjs";

test("parseStatus reads the JSON on the last line, after jflow's log", () => {
	const st = parseStatus('ℹ Teams: sent\n{"pr":42,"status":"awaiting_approval","done":false,"detail":"waiting"}\n');
	assert.deepEqual(st, { pr: 42, status: "awaiting_approval", done: false, detail: "waiting" });
	assert.throws(() => parseStatus("Error: no open PR"), /unexpected review_status result/);
	assert.throws(() => parseStatus('{"status":"clean"}'), /unexpected/);
});

// Fake clock: sleep advances it, so timeouts need no real waiting.
function clock() {
	let t = 0;
	return { now: () => t, sleep: async (ms) => void (t += ms) };
}

const st = (status, done = false, detail = status) => ({ pr: 42, status, done, detail });

test("watchPR polls until a done status", async () => {
	const seq = [st("copilot_pending"), st("copilot_pending"), st("feedback", true, "2 unresolved review thread(s)")];
	const seen = [];
	const c = clock();
	const got = await watchPR({ check: async () => seq.shift(), timeoutMs: 10_000, onStatus: (s) => seen.push(s.status), pollMs: 1_000, ...c });
	assert.equal(got.status, "feedback");
	assert.deepEqual(seen, ["copilot_pending", "copilot_pending", "feedback"]);
	assert.equal(c.now(), 2_000);
});

test("watchPR times out with the last detail", async () => {
	const got = await watchPR({ check: async () => st("copilot_pending", false, "Copilot is still reviewing"), timeoutMs: 5_000, pollMs: 1_000, ...clock() });
	assert.equal(got.status, "timeout");
	assert.equal(got.done, true);
	assert.equal(got.pr, 42);
	assert.match(got.detail, /Copilot is still reviewing/);
});

test("watchPR runs no check once the budget is used up", async () => {
	let calls = 0;
	const got = await watchPR({ check: async () => (calls++, st("merge_ready")), timeoutMs: 0, ...clock() });
	assert.equal(calls, 0);
	assert.equal(got.status, "timeout");
	assert.match(nextStep(got, { rounds: 0 }).notify, /^jflow watcher: the PR: gave up waiting; last status: unknown$/);
});

test("watchPR retries single failures and gives up after MAX_FAILURES in a row", async () => {
	let calls = 0;
	const flaky = async () => (++calls === 1 ? Promise.reject(new Error("blip")) : st("clean", true));
	assert.equal((await watchPR({ check: flaky, timeoutMs: 60_000, ...clock() })).status, "clean");

	calls = 0;
	const down = async () => {
		calls++;
		throw new Error("down");
	};
	// The budget covers MAX_FAILURES polls, so the failures end the watch, not the timeout.
	await assert.rejects(watchPR({ check: down, timeoutMs: 10 * 60_000, ...clock() }), /down/);
	assert.equal(calls, MAX_FAILURES);
});

test("watchPR reports retried failures to onError", async () => {
	let calls = 0;
	const errors = [];
	const flaky = async () => (++calls === 1 ? Promise.reject(new Error("MCP HTTP 404")) : st("clean", true));
	await watchPR({ check: flaky, timeoutMs: 60_000, onError: (err, n) => errors.push(`${err.message}/${n}`), ...clock() });
	assert.deepEqual(errors, ["MCP HTTP 404/1"]);
});

test("describeWatch shows state, next step and budget of a running watcher", () => {
	const now = 10 * 3_600_000;
	const w = {
		repo: "/r", pr: 118, merge: true, running: true, status: "awaiting_approval", detail: "waiting for oliver's approval",
		rounds: 3, lastCheckAt: now - 12_000, deadline: now + 7 * 3_600_000 + 12 * 60_000,
	};
	assert.equal(
		describeWatch(w, now),
		[
			"PR #118 in /r — watcher running, merge on approval on",
			"current state: awaiting approval — waiting for oliver's approval",
			"next step: wait for a coworker's approval; Teams reminder every 12 h",
			"last check: 12 s ago · fix rounds: 3/10 · gives up in 7 h 12 min",
		].join("\n"),
	);
	assert.equal(watchFooter(w), "jflow #118: awaiting approval → wait for a coworker's approval; Teams reminder every 12 h");
});

test("describeWatch tells a failing check and a stopped watcher apart", () => {
	const failing = { repo: "/r", pr: 118, merge: true, running: true, status: "copilot_pending", error: "MCP HTTP 404 (1 failed check(s) in a row)", rounds: 0 };
	assert.match(describeWatch(failing), /last error: MCP HTTP 404.*\nnext step: retry the check in 30 s/);
	assert.equal(watchFooter(failing), "jflow #118: check failed → retry the check in 30 s");

	const handed = { repo: "/r", pr: 118, merge: true, running: false, status: "feedback", handedToAgent: true, rounds: 4 };
	assert.match(describeWatch(handed), /watcher stopped.*\n.*\nnext step: agent works through the feedback/);
	assert.equal(watchFooter(handed), "jflow #118: watcher stopped (feedback)");

	const timedOut = { repo: "/r", pr: 118, merge: true, running: false, status: "timeout", rounds: 4 };
	assert.match(describeWatch(timedOut), /next step: none; \/jflow-merge on starts a new watcher/);
	assert.match(describeWatch({ ...timedOut, status: "merged" }), /next step: none$/m);
});

test("watchPR stops when aborted", async () => {
	const ac = new AbortController();
	const run = watchPR({ check: async () => st("awaiting_approval"), timeoutMs: 60_000, signal: ac.signal, pollMs: 60_000 });
	ac.abort(new Error("session ended"));
	await assert.rejects(run, /session ended/);
	await assert.rejects(delay(10, AbortSignal.abort(new Error("gone"))), /gone/);
});

test("nextStep hands feedback to the agent until MAX_ROUNDS", () => {
	const feedback = { ...st("feedback", true, "2 unresolved review thread(s)"), url: "https://gh/pr/42" };
	const step = nextStep(feedback, { repo: "/r", rounds: 0 });
	assert.match(step.prompt, /round 1\/10/);
	assert.match(step.prompt, /jflow_review with path "\/r" and pr 42/);
	assert.match(step.prompt, /jflow_review_resolve/);

	const capped = nextStep(feedback, { repo: "/r", rounds: MAX_ROUNDS });
	assert.equal(capped.prompt, undefined);
	assert.equal(capped.level, "warning");
	assert.match(capped.notify, /after 10 fix rounds/);
});

test("nextStep reports final states to the user", () => {
	assert.deepEqual(nextStep(st("merged", true, "merged (squash) after approval by alice"), { repo: "/r", rounds: 0 }), {
		notify: "jflow watcher: PR #42: merged (squash) after approval by alice",
		level: "info",
	});
	assert.equal(nextStep(st("clean", true), { rounds: 0 }).level, "info");
	for (const s of ["changes_requested", "not_mergeable", "timeout", "closed"]) {
		assert.equal(nextStep(st(s, true), { rounds: 0 }).level, "warning", s);
	}
});

test("notifiedMessage reports a Teams message sent by the check, and nothing otherwise", () => {
	const sent = { ...st("awaiting_approval", false, "waiting for olli's approval; sent the review request"), url: "https://gh/pr/42", notified: "olli" };
	assert.equal(
		notifiedMessage(sent),
		"jflow watcher: PR #42 (https://gh/pr/42): sent a Teams message to olli — waiting for olli's approval; sent the review request",
	);
	assert.equal(notifiedMessage(st("awaiting_approval", false, "waiting for olli's approval (asked 9:00AM)")), undefined);
});
