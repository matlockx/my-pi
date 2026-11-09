/**
 * Pure decisions of the git-gate extension: which bash commands commit, in which
 * directories, and whether the staged tree can be checked before the commit runs.
 */

import path from "node:path";

import { commandDirs } from "../quick-review/gate.mjs";

/** Lines of the check's output a block reason carries, counted from the end. */
export const OUTPUT_TAIL_LINES = 40;

// DEV-NOTE: `(?![\w-])` keeps `git commit-tree` and `git add-on` style words out;
// the optional `-C <dir>` covers `git -C repo commit`.
const GIT = String.raw`\bgit\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?`;
const COMMIT = new RegExp(`${GIT}commit(?![\\w-])`);
const STAGE = new RegExp(`${GIT}(?:add|stage|rm|mv)(?![\\w-])`);
// `-a`, `-am`, `--all` on the commit itself, up to the end of that command.
const COMMIT_ALL = new RegExp(
	`${GIT}commit(?![\\w-])[^;&|\\n]*?\\s(?:--all\\b|-[A-Za-z]*a[A-Za-z]*(?=\\s|$))`,
);

// A heredoc's body up to its delimiter line (`<<'EOF'`, `<<-EOF`, `<<"END"`).
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;

/**
 * The command with each heredoc's body removed: a commit message or script fed
 * on standard input is data, not a command git runs.
 *
 * @param {string} command The bash command as the agent sent it.
 * @returns {string}
 */
export function withoutHeredocs(command) {
	return (command ?? "").replace(HEREDOC, "");
}

/**
 * Reports whether a bash command runs `git commit`, outside any heredoc body.
 *
 * @param {string} command The bash command as the agent sent it.
 * @returns {boolean}
 */
export function isCommit(command) {
	return COMMIT.test(withoutHeredocs(command));
}

/**
 * Names why the staged tree cannot be checked before command runs: the same
 * command stages files (`git add`, `git rm`, `git mv`) or commits with `-a`, so
 * what it commits is not staged yet when the check runs. Empty when it can be.
 * Heredoc bodies are not read.
 *
 * @param {string} command A bash command that commits (isCommit).
 * @returns {string}
 */
export function stagingProblem(command) {
	const run = withoutHeredocs(command);
	if (STAGE.test(run) || COMMIT_ALL.test(run)) {
		return (
			"git-gate: stage and commit in separate commands, without `git commit -a`. " +
			"dev/check checks the staged tree before the commit runs, and files staged by " +
			"the same command are not staged yet at that point."
		);
	}
	return "";
}

/**
 * The directories a committing command runs git in: each `cd <dir>` and
 * `git -C <dir>` it names, resolved against base, or base alone where it names
 * none. A leading `~` is the user's home directory.
 *
 * @param {string} command A bash command that commits.
 * @param {string} base The directory the command starts in.
 * @param {string} home The user's home directory.
 * @returns {string[]} Absolute directories, deduplicated, in command order.
 */
export function checkDirs(command, base, home) {
	const named = commandDirs(command).map((dir) =>
		path.resolve(base, dir === "~" ? home : dir.replace(/^~\//, `${home}/`)),
	);
	return named.length > 0 ? [...new Set(named)] : [base];
}

/**
 * The reason a failed dev/check gives for blocking the commit: the repository,
 * the exit status, and the last OUTPUT_TAIL_LINES lines of its output.
 *
 * @param {string} root The repository's top-level directory.
 * @param {{ code: number, killed?: boolean, stdout?: string, stderr?: string }} result
 * @returns {string}
 */
export function blockReason(root, result) {
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n");
	const tail = output.slice(-OUTPUT_TAIL_LINES).join("\n");
	const status = result.killed ? "was stopped (timeout)" : `exited ${result.code}`;
	return `git-gate: ${path.join(root, "dev", "check")} ${status}; the commit did not run. ` +
		`Fix what it reports, stage the fix, and commit again.\n\n${tail}`;
}
