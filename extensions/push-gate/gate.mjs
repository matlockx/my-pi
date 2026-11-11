/**
 * Decision logic for the push gate, kept free of pi APIs so it is testable.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** jflow tools that push the branch: pr pushes and opens the PR, review_resolve pushes fixes. */
export const PUSH_TOOLS = new Set(["jflow_pr", "jflow_review_resolve"]);

/** Gate outputs written into the repo; excluded from the fingerprint, since running a gate writes them. */
const GATE_OUTPUTS = [".metrics", "target/coverage"];

/** Source extensions crapper or dryer score; a repo with none of them has nothing to gate. */
const GATED_SOURCE = /\.(go|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|java|rs|clj|cljc|cljs|bb)$/;

// shortcut: a regex over the command text, not a shell parser. A push hidden behind an
// alias, a script or a variable passes; extend the list if one shows up in practice.
const GIT_PUSH = /\bgit\b(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+push\b/;
const GIT_C = /\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/;
const CD = /\bcd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;

/**
 * Matches a program at command position: start of the line or after `;`, `&`, `|`, `(`,
 * `then` or `do`, optionally behind env assignments or a runner (`uv run`, `npx`,
 * `python -m`). `command -v crapper` or `echo dryer` therefore do not count as a gate run.
 */
const atCommand = (program, rest = "") =>
	new RegExp(
		`(?:^|[;&|(]|\\bthen\\b|\\bdo\\b)\\s*(?:\\w+=\\S*\\s+)*(?:uv\\s+run\\s+|npx\\s+|python3?\\s+-m\\s+)?${program}\\b${rest}`,
		"m",
	);

/** Commands that produce the coverage figure: crapper, or the coverage tool of a Sonar repo. */
const COVERAGE = [
	atCommand("crapper", "(?![^;&|]*(?:--no-coverage|--help|\\s-h\\b))"),
	atCommand("go\\s+test", "[^;&|]*-cover"),
	atCommand("pytest", "[^;&|]*--cov"),
	atCommand("(?:vitest|jest)", "[^;&|]*--coverage"),
	atCommand("npm\\s+run\\s+coverage"),
];
const DRYER = atCommand("dryer", "(?![^;&|]*(?:--help|\\s-h\\b))");

/** Shell output when the gate program does not exist (bash, zsh, fish); such a run measured nothing. */
const NOT_INSTALLED = /command not found|Unknown command/;

/**
 * Names the gates a finished bash command ran.
 *
 * @param {string} command The bash command line.
 * @param {string} [output] The command's output; a "command not found" result counts as no run.
 * @returns {Array<"coverage"|"dryer">} Gates the command ran, empty when none.
 */
export function gatesRun(command, output = "") {
	const text = command ?? "";
	if (NOT_INSTALLED.test(output)) return [];
	const gates = [];
	if (COVERAGE.some((pattern) => pattern.test(text))) gates.push("coverage");
	if (DRYER.test(text)) gates.push("dryer");
	return gates;
}

/**
 * Reads the directory a bash command works in: the `git -C` target, else the last `cd`.
 *
 * @param {string} command The bash command line.
 * @returns {string} The directory verbatim, quotes stripped; "" when the command names none.
 */
export function commandDir(command) {
	const text = command ?? "";
	const unquote = (dir) => dir.replace(/^["']|["']$/g, "");
	const gitC = GIT_C.exec(text);
	if (gitC) return unquote(gitC[1]);
	const cds = [...text.matchAll(CD)].map((match) => unquote(match[1]));
	return cds.findLast((dir) => dir && !dir.startsWith("-") && !dir.includes("$")) ?? "";
}

/**
 * Decides whether a tool call pushes, and from which directory.
 *
 * @param {string} toolName Name of the called tool.
 * @param {Record<string, unknown>} input The call's arguments.
 * @returns {{dir: string} | null} The directory the push runs in ("" for the session directory), or null when the call does not push.
 */
export function pushTarget(toolName, input) {
	if (PUSH_TOOLS.has(toolName)) {
		return { dir: typeof input?.path === "string" ? input.path.replace(/^@/, "") : "" };
	}
	if (toolName === "bash" && GIT_PUSH.test(String(input?.command ?? ""))) {
		return { dir: commandDir(String(input.command)) };
	}
	return null;
}

/**
 * Lists the gates whose last run does not match the content about to be pushed.
 *
 * @param {{coverage?: string, dryer?: string}} ran Fingerprint of the tree at each gate's last run.
 * @param {string} current Fingerprint of the tree now.
 * @returns {Array<"coverage"|"dryer">} Gates to run before the push, in report order.
 */
export function staleGates(ran, current) {
	return /** @type {const} */ (["coverage", "dryer"]).filter((gate) => ran?.[gate] !== current);
}

/**
 * True when the repo holds source a gate scores.
 *
 * @param {string[]} files Paths from `git ls-files`.
 * @returns {boolean}
 */
export function hasGatedSource(files) {
	return files.some((file) => GATED_SOURCE.test(file));
}

/**
 * Builds the message returned to the agent when a push is blocked.
 *
 * @param {Array<"coverage"|"dryer">} stale Gates to run.
 * @param {boolean} sonar True when the repo has a SonarQube gate.
 * @param {string} docPath Absolute path of the gate rules.
 * @returns {string}
 */
export function blockReason(stale, sonar, docPath) {
	const commands = {
		coverage: sonar
			? "the repo's coverage tool (Sonar repo: 80 % on changed lines)"
			: "`crapper --threshold 10 <files the branch changed>`",
		dryer: "`dryer --threshold 0.8`",
	};
	return (
		"Push blocked: the quality gates have not run on this exact content. " +
		`Run ${stale.map((gate) => commands[gate]).join(" and ")} from the repo root, ` +
		`fix what they report, then push again. Rules: read ${docPath}. ` +
		"Tools not installed or the user waives the gates: tell the user, who can run `/push-gate skip`."
	);
}

/**
 * Runs git in a directory.
 *
 * @param {string} cwd Working directory.
 * @param {string[]} args git arguments.
 * @param {NodeJS.ProcessEnv} [env] Extra environment.
 * @returns {Promise<string>} stdout, trimmed.
 */
async function git(cwd, args, env) {
	const { stdout } = await run("git", args, {
		cwd,
		env: env ? { ...process.env, ...env } : process.env,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.trim();
}

/**
 * Repository root containing dir.
 *
 * @param {string} dir A directory.
 * @returns {Promise<string>} The root, or "" when dir is not inside a working tree.
 */
export async function repoRoot(dir) {
	try {
		return await git(dir, ["rev-parse", "--show-toplevel"]);
	} catch {
		return "";
	}
}

/**
 * Fingerprints the content a push would carry once committed: the tree object of every
 * tracked and untracked, non-ignored file in the working tree, gate outputs excluded.
 *
 * Equal before and after a commit of the same content, so gates run on uncommitted work
 * still count for the push that follows the commit. Uses a throwaway index, so the user's
 * staging area is left as it is.
 *
 * @param {string} root Repository root.
 * @returns {Promise<string>} The tree id.
 */
export async function contentFingerprint(root) {
	const dir = await mkdtemp(join(tmpdir(), "push-gate-"));
	try {
		const env = { GIT_INDEX_FILE: join(dir, "index") };
		await git(root, ["read-tree", "HEAD"], env).catch(() => git(root, ["read-tree", "--empty"], env));
		// DEV-NOTE: git add exits non-zero when an exclude pathspec names an ignored path
		// (git 2.56). Ignored paths are never added, so only unignored outputs need excluding;
		// check-ignore exits 1 when none is ignored.
		const ignored = (await git(root, ["check-ignore", "--", ...GATE_OUTPUTS]).catch(() => "")).split("\n");
		const excludes = GATE_OUTPUTS.filter((path) => !ignored.includes(path)).map((path) => `:(exclude)${path}`);
		await git(root, ["add", "-A", "--", ".", ...excludes], env);
		return await git(root, ["write-tree"], env);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Lists the files git knows in the repo.
 *
 * @param {string} root Repository root.
 * @returns {Promise<string[]>}
 */
export async function trackedFiles(root) {
	return (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard"])).split("\n");
}

/**
 * True when the repo has a SonarQube gate: `sonar-project.properties`, or a workflow that
 * mentions Sonar.
 *
 * @param {string} root Repository root.
 * @returns {Promise<boolean>}
 */
export async function hasSonar(root) {
	if (await stat(join(root, "sonar-project.properties")).catch(() => null)) return true;
	const workflows = join(root, ".github", "workflows");
	const names = await readdir(workflows).catch(() => []);
	for (const name of names) {
		if (!/\.ya?ml$/.test(name)) continue;
		if (/sonar/i.test(await readFile(join(workflows, name), "utf8").catch(() => ""))) return true;
	}
	return false;
}
