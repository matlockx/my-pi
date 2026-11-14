/**
 * Builder rounds: patches written by the extension in the Builder's isolated workspace, the QA
 * triggers for the quick lane, the no-progress checks of the Builder/QA loop, and orphaned
 * isolation workspaces.
 *
 * omp writes `<artifacts>/<agentId>.patch` only at the first completion and at release, so it is
 * stale after a follow-up turn (spec, phase 0b). The Builder session therefore records a baseline
 * tree when it starts and writes `<agentId>.round-<n>.patch` against it on every `yield`. Trees are
 * built with a temporary index file, so the workspace index stays untouched and the user's
 * uncommitted changes copied into the workspace are part of the baseline, not of the patch.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const KEY = Symbol.for("my-pi.orchestrator.registry");
/** Budget for writing a round patch inside the Builder's `yield` call; omp blocks the call at 30 s. */
export const ROUND_PATCH_DEADLINE_MS = 20_000;

/**
 * `promise`, or a rejection with `message` after `ms`. The work behind `promise` is not cancelled;
 * the caller stops waiting for it.
 */
export function withDeadline(promise, ms, message) {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
		timer.unref?.();
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * @typedef {object} Round One Builder result: its patch file and structured output.
 * @property {number} round
 * @property {string} path Patch file; empty when writing it failed.
 * @property {string} hash
 * @property {Record<string, unknown> | undefined} result The Builder's `yield` data.
 * @property {string} [error] Why no patch was written.
 */

/**
 * @typedef {object} QaReport QA's `yield` data.
 * @property {string} [verdict] PASS | CONCERNS | FAIL
 * @property {{ severity?: string, file?: string, line?: number, text?: string }[]} [findings]
 * @property {{ command?: string, passed?: boolean }[]} [testsRun]
 */

/**
 * Process-wide record of Builder rounds and QA reports, written in the subagent sessions and read
 * by the Lead's session (module state is per session; globalThis is shared, spec phase 0).
 * `rounds`: Builder id -> [{ round, path, hash, result, error? }]; `qa`: QA id -> report;
 * `owed`: ids of Builders the Lead messaged since their last yield (a round is owed);
 * `budgets`: Builder id -> budget in USD; `budget`: the switch ("on" | "off"). Budgets live here
 * because the pause is enforced in the Builder's session, not in the Lead's.
 */
export function orchestratorRegistry(scope = globalThis) {
	// DEV-NOTE: the registry outlives code reloads in a running omp process, so one created by an older
	// version lacks newer fields (`owed` once crashed recordYield); fill each missing field, keep the rest.
	const reg = (scope[KEY] ??= {});
	reg.rounds ??= new Map();
	reg.qa ??= new Map();
	reg.owed ??= new Set();
	reg.budgets ??= new Map();
	reg.budget ??= "on";
	return reg;
}

export const QA_LINE_LIMIT = 40;
const TEST_PATH = /(_test\.go|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|(^|\/)tests?\/|(^|\/)test_[^/]*\.py|_test\.py)$|(^|\/)tests?\//;
const ASSERTION = /\b(assert|expect|require\.|t\.(Error|Fatal|Fail)|should\b|toBe|toEqual)/;
const RISKY_PATH = /(auth|login|password|token|secret|session|payment|billing|invoice|money|price|refund|ledger|wallet|persist|repositor|migration|schema|\.sql$)/i;

async function git(cwd, args, env) {
	const { stdout } = await execFileP("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: env ?? process.env });
	return stdout;
}

/** Top-level directory of the git work tree containing `cwd`. */
export async function repoTop(cwd) {
	return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

/** Tree id of the work tree as it is now (tracked and untracked, ignored files left out). */
export async function snapshotTree(top) {
	const index = join(tmpdir(), `orch-index-${randomUUID()}`);
	const env = { ...process.env, GIT_INDEX_FILE: index };
	try {
		await git(top, ["add", "-A"], env);
		return (await git(top, ["write-tree"], env)).trim();
	} finally {
		rmSync(index, { force: true });
	}
}

/** Binary diff from the `baseline` tree to the work tree as it is now. */
export async function diffSince(top, baseline) {
	const current = await snapshotTree(top);
	return git(top, ["diff", "--binary", baseline, current]);
}

/** Path of the Builder's baseline file in the artifacts directory. */
export const baselinePath = (dir, id) => join(dir, `${id}.baseline`);

/** Round patches of a Builder, oldest first: `{ round, path }`. */
export function roundPatches(dir, id) {
	const pattern = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.round-(\\d+)\\.patch$`);
	let names = [];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.map((name) => pattern.exec(name))
		.filter(Boolean)
		.map((m) => ({ round: Number(m[1]), path: join(dir, m[0]) }))
		.sort((a, b) => a.round - b.round);
}

/** Writes the next round patch; returns `{ round, path, hash }`. */
export function writeRoundPatch(dir, id, patch) {
	const round = (roundPatches(dir, id).at(-1)?.round ?? 0) + 1;
	const path = join(dir, `${id}.round-${round}.patch`);
	writeFileSync(path, patch);
	return { round, path, hash: hashText(patch) };
}

/** Reads the stored baseline tree id, or undefined. */
export function readBaseline(dir, id) {
	const path = baselinePath(dir, id);
	return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}

export function hashText(text) {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const SUBMODULE = /^(new file|deleted file|old|new) mode 160000|^[-+]Subproject commit/;

// Counts one `+` or `-` body line of a file's diff into `file`.
function countLine(file, line) {
	const sign = line[0];
	if ((sign !== "+" && sign !== "-") || line.startsWith("+++") || line.startsWith("---")) return;
	const assertion = ASSERTION.test(line) ? 1 : 0;
	if (sign === "+") Object.assign(file, { added: file.added + 1, addedAssertions: file.addedAssertions + assertion });
	else Object.assign(file, { removed: file.removed + 1, removedAssertions: file.removedAssertions + assertion });
}

// Applies one diff line after a file header; returns whether it marks a nested repository.
function fileLine(file, line) {
	if (line.startsWith("deleted file mode")) file.deleted = true;
	else if (SUBMODULE.test(line)) return true;
	else countLine(file, line);
	return false;
}

/**
 * Files and line counts of a unified diff: `{ files: [{ path, deleted, added, removed,
 * removedAssertions, addedAssertions }], changedLines, nested }`. `nested` is true when the
 * patch changes a submodule or nested repository pointer.
 */
export function patchStats(patch) {
	const files = [];
	let nested = false;
	for (const line of (patch ?? "").split("\n")) {
		const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (head) files.push({ path: head[2], deleted: false, added: 0, removed: 0, removedAssertions: 0, addedAssertions: 0 });
		else if (files.length && fileLine(files[files.length - 1], line)) nested = true;
	}
	return { files, changedLines: files.reduce((n, f) => n + f.added + f.removed, 0), nested };
}

// Reasons in the patch itself: size, deleted or weakened tests, risky paths.
function patchReasons(stats) {
	const reasons = [];
	const paths = (list) => list.map((f) => f.path).join(", ");
	if (stats.changedLines > QA_LINE_LIMIT) reasons.push(`${stats.changedLines} changed lines (over ${QA_LINE_LIMIT})`);
	const tests = stats.files.filter((f) => TEST_PATH.test(f.path));
	const deleted = tests.filter((f) => f.deleted);
	const weakened = tests.filter((f) => !f.deleted && f.removedAssertions > f.addedAssertions);
	const risky = stats.files.filter((f) => RISKY_PATH.test(f.path));
	if (deleted.length) reasons.push(`test file deleted: ${paths(deleted)}`);
	if (weakened.length) reasons.push(`assertions removed: ${paths(weakened)}`);
	if (risky.length) reasons.push(`risky path: ${paths(risky)}`);
	return reasons;
}

/**
 * Reasons why a quick-lane or PR round needs QA despite the lane (spec, QA policy). `result` is the
 * Builder's structured output; an empty `testsRun` or `lintRun` means it did not verify.
 */
export function qaTriggers(patch, result) {
	const reasons = patchReasons(patchStats(patch));
	if (!result?.testsRun?.length) reasons.push("Builder ran no tests");
	if (!result?.lintRun?.length) reasons.push("Builder ran no linter");
	return reasons;
}

const normalise = (text) => String(text ?? "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const findingKeys = (report) => new Set((report?.findings ?? []).map((f) => `${f.file ?? ""}|${normalise(f.text)}`));
const failingTests = (report) => new Set((report?.testsRun ?? []).filter((t) => t.passed === false).map((t) => normalise(t.command)));
const overlap = (a, b) => [...a].filter((x) => b.has(x));

/**
 * Why the next Builder fix round would make no progress, or undefined. `rounds` are the Builder's
 * round patches (`{ hash }`, oldest first); `reports` the QA reports of the run, oldest first.
 */
export function progressBreak(rounds, reports) {
	const [prevRound, lastRound] = rounds.slice(-2);
	if (prevRound && lastRound && prevRound.hash === lastRound.hash) return "the last fix round changed nothing (identical patch)";
	const [prev, last] = reports.slice(-2);
	if (!prev || !last) return undefined;
	const repeated = overlap(findingKeys(last), findingKeys(prev));
	if (repeated.length) return `QA reported the same finding again: ${repeated[0].split("|").join(": ")}`;
	const tests = overlap(failingTests(last), failingTests(prev));
	if (tests.length) return `the same test failed twice: ${tests[0]}`;
	const older = reports.slice(0, -2).reduce((all, r) => new Set([...all, ...findingKeys(r)]), new Set());
	const returned = overlap(findingKeys(last), older);
	if (returned.length) return `a finding fixed earlier came back: ${returned[0].split("|").join(": ")}`;
	return undefined;
}

/**
 * Isolation workspaces under `root` (`~/.omp/wt`) whose owner process is gone: `[{ dir, pid }]`.
 * `alive(pid)` tells whether a process exists. Entries without a readable owner file are skipped.
 */
export function orphanWorkspaces(root, alive) {
	let names = [];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const orphans = [];
	for (const name of names) {
		const dir = join(root, name);
		try {
			const owner = JSON.parse(readFileSync(join(dir, ".omp-isolation-owner.json"), "utf8"));
			if (Number.isInteger(owner?.pid) && !alive(owner.pid)) orphans.push({ dir, pid: owner.pid });
		} catch {
			// no owner file: not an omp isolation workspace, or not readable
		}
	}
	return orphans;
}

/** Whether a process with this id exists (signal 0 checks without sending). */
export function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}
