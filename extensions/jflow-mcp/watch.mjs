// PR watcher: polls jflow's review_status tool after `pr` and `review_resolve`
// until Copilot has finished (and, with merge, until the PR is merged), and
// decides what happens with the outcome. Pure apart from the injected check,
// sleep and clock, so the loop is testable without jflow or GitHub.

export const POLL_MS = 30_000;
// Same budgets as `jflow review --wait` / `--merge`.
export const COPILOT_TIMEOUT_MS = 30 * 60_000;
export const MERGE_TIMEOUT_MS = 8 * 3_600_000;
// Fix rounds per PR and session; Copilot finds new nits on most pushes.
export const MAX_ROUNDS = 10;
// Failed status checks in a row before the watcher gives up.
export const MAX_FAILURES = 3;

/** Parses the review_status result: its last line is the JSON status. */
export function parseStatus(text) {
	const line = String(text ?? "").trim().split("\n").at(-1) ?? "";
	let status;
	try {
		status = JSON.parse(line);
	} catch {
		throw new Error(`unexpected review_status result: ${line.slice(0, 200)}`);
	}
	if (typeof status?.status !== "string" || typeof status?.pr !== "number") {
		throw new Error(`unexpected review_status result: ${line.slice(0, 200)}`);
	}
	return status;
}

/** Resolves after ms, rejects when signal aborts. The timer never keeps the process alive. */
export function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

/**
 * Calls check() every pollMs until the status is done, the timeout has passed
 * or MAX_FAILURES checks in a row failed (rethrows the last error). The
 * timeout is checked before every call, so no check (and no merge) runs once
 * it has passed. onStatus sees every status, e.g. for a footer; onError sees
 * every failed check that is retried.
 */
export async function watchPR({
	check,
	timeoutMs,
	signal,
	onStatus = () => {},
	onError = () => {},
	sleep = delay,
	now = Date.now,
	pollMs = POLL_MS,
}) {
	const deadline = now() + timeoutMs;
	let last;
	let failures = 0;
	for (;;) {
		if (now() >= deadline) {
			return { ...last, status: "timeout", done: true, detail: `gave up waiting; last status: ${last?.detail ?? "unknown"}` };
		}
		try {
			last = await check();
			failures = 0;
			onStatus(last);
			if (last.done) return last;
		} catch (err) {
			if (signal?.aborted || ++failures >= MAX_FAILURES) throw err;
			onError(err, failures);
		}
		await sleep(pollMs, signal);
	}
}

// What the watcher does next while it is in a review_status status.
// DEV-NOTE: keep in step with the watch* status constants in jflow cmd/reviewwait.go.
const NEXT_STEPS = {
	copilot_pending: "wait for Copilot's review",
	sonar_pending: "wait for SonarQube Cloud's analysis",
	awaiting_approval: "wait for a coworker's approval; Teams reminder every hour",
	merge_ready: "merge the PR",
	merge_blocked: "retry the merge on the next check",
};

/** Renders a duration in whole minutes or hours and minutes, e.g. "7 h 12 min". */
function span(ms) {
	const min = Math.max(0, Math.round(ms / 60_000));
	return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * The next step of a watch, given its state record (see describeWatch).
 */
export function watchNextStep(w) {
	if (w.running) {
		if (w.error) return `retry the check in ${Math.round(POLL_MS / 1000)} s`;
		return NEXT_STEPS[w.status] ?? "check the PR";
	}
	if (w.status === "feedback" && w.handedToAgent) return "agent works through the feedback, then review_resolve restarts the watcher";
	if (w.status === "merged" || w.status === "closed") return "none";
	return w.merge ? "none; /jflow-merge on starts a new watcher" : "none";
}

/** One footer line for a watch state record, e.g. "jflow #118: copilot pending → wait for Copilot's review". */
export function watchFooter(w) {
	const pr = w.pr ? `#${w.pr}` : "PR";
	const state = w.error && w.running ? "check failed" : (w.status ?? "starting").replaceAll("_", " ");
	return w.running ? `jflow ${pr}: ${state} → ${watchNextStep(w)}` : `jflow ${pr}: watcher stopped (${state})`;
}

/**
 * Describes a watch state record for the user and the agent. The record holds
 * repo, pr, merge, running, status, detail, error, rounds, startedAt,
 * lastCheckAt and deadline (epoch ms).
 */
export function describeWatch(w, now = Date.now()) {
	const pr = w.pr ? `PR #${w.pr}` : "the PR of the current branch";
	const lines = [
		`${pr} in ${w.repo} — watcher ${w.running ? "running" : "stopped"}, merge on approval ${w.merge ? "on" : "off"}`,
		`current state: ${(w.status ?? "starting").replaceAll("_", " ")}${w.detail ? ` — ${w.detail}` : ""}`,
	];
	if (w.error) lines.push(`last error: ${w.error}`);
	lines.push(`next step: ${watchNextStep(w)}`);
	const facts = [`fix rounds: ${w.rounds ?? 0}/${MAX_ROUNDS}`];
	if (w.lastCheckAt) facts.unshift(`last check: ${Math.round((now - w.lastCheckAt) / 1000)} s ago`);
	if (w.running && w.deadline) facts.push(`gives up in ${span(w.deadline - now)}`);
	lines.push(facts.join(" · "));
	return lines.join("\n");
}

/**
 * Decides what to do with a finished watch: hand open review threads to the
 * agent while rounds are left, otherwise tell the user.
 * Returns { prompt } or { notify, level }.
 */
export function nextStep(status, { repo, rounds }) {
	// pr is unknown when the budget ran out before the first check.
	const where = `${status.pr ? `PR #${status.pr}` : "the PR"}${status.url ? ` (${status.url})` : ""}`;
	if (status.status === "feedback") {
		if (rounds >= MAX_ROUNDS) {
			return { notify: `jflow watcher: ${where} still has ${status.detail} after ${MAX_ROUNDS} fix rounds — over to you`, level: "warning" };
		}
		return {
			prompt:
				`jflow watcher, round ${rounds + 1}/${MAX_ROUNDS}: ${where} has ${status.detail}. ` +
				`Call jflow_review with path "${repo}" and pr ${status.pr}, work through the comments as its ` +
				"instructions say, commit the fixes with jflow_commit, then call jflow_review_resolve. " +
				"The watcher checks the PR again after review_resolve.",
		};
	}
	const level = status.status === "merged" || status.status === "clean" ? "info" : "warning";
	return { notify: `jflow watcher: ${where}: ${status.detail ?? status.status}`, level };
}
