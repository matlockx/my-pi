/**
 * Work items of a run: the Jira keys and GitHub issues or pull requests it belongs to.
 *
 * Sources, in precedence order for the primary item: an explicit `/track` id, the git branch,
 * a jflow watcher PR round, the prompt text. Every item found is kept; one is marked primary.
 *
 * A Jira key in prompt text counts only when its project prefix is known (configured, learned
 * from a branch or from `/track`), so `UTF-8`, `SHA-256` or `CVE-2024-1` are not taken for keys.
 * The same rule covers lowercase keys in branch names (`actions/checkout-7.0.1`).
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 2_000;

/** `git -C cwd args`, trimmed stdout; undefined on failure, empty output or timeout (2 s). */
export async function gitOutput(cwd, args) {
	try {
		const { stdout } = await execFileP("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

// Prefixes that look like Jira projects but name standards, hashes and encodings.
const NOT_JIRA = new Set(["UTF", "SHA", "ISO", "CVE", "RFC", "HTTP", "TLS", "SSL", "MD", "AES", "RSA", "UTC", "GMT", "ES", "GPT", "IPV"]);
const JIRA_UPPER = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
const JIRA_ANY = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d+)\b/g;
const GITHUB_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/g;
const SHORT_REF = /(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
const URI_REF = /\b(issue|pr):\/\/(?:([\w.-]+)\/([\w.-]+)\/)?(\d+)\b/g;
const PR_ROUND = /^jflow watcher, round \d+/;

/** `owner/repo` of a GitHub remote URL (https or ssh), or undefined. */
export function repoOfRemote(url) {
	const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec((url ?? "").trim());
	return m ? `${m[1]}/${m[2]}` : undefined;
}

// Jira keys in text; accept(prefix, writtenUppercase) decides per key.
function jiraKeys(text, pattern, accept) {
	const keys = [];
	for (const [, prefix, number] of (text ?? "").matchAll(pattern)) {
		const upper = prefix.toUpperCase();
		if (NOT_JIRA.has(upper) || !accept(upper, prefix === upper)) continue;
		const id = `${upper}-${number}`;
		if (!keys.some((k) => k.id === id)) keys.push({ id, kind: "jira" });
	}
	return keys;
}

/** Jira keys of a branch name: uppercase keys always, lowercase ones only with a known prefix. */
export function branchItems(branch, known) {
	return jiraKeys(branch, JIRA_ANY, (prefix, upper) => upper || known.has(prefix));
}

const ghKind = (pull) => (pull ? "github-pr" : "github-issue");

// `issue://N` / `pr://owner/repo/N` reference: owner/repo#N, or the raw reference without a repo.
function uriItem([, type, owner, name, n], repo) {
	const where = owner ? `${owner}/${name}` : repo;
	return { id: where ? `${where}#${n}` : `${type}://${n}`, kind: ghKind(type === "pr") };
}

/** GitHub issues and pull requests named in text; `repo` resolves `issue://N` and `pr://N`. */
export function githubItems(text, repo) {
	const t = text ?? "";
	return [
		...[...t.matchAll(GITHUB_URL)].map(([, owner, name, type, n]) => ({ id: `${owner}/${name}#${n}`, kind: ghKind(type === "pull") })),
		...[...t.matchAll(SHORT_REF)].map(([, owner, name, n]) => ({ id: `${owner}/${name}#${n}`, kind: "github-issue" })),
		...[...t.matchAll(URI_REF)].map((m) => uriItem(m, repo)),
	];
}

/** Parses one explicit `/track` id: a Jira key (any case) or a GitHub reference. */
export function parseTrackId(text, repo) {
	const value = (text ?? "").trim();
	const jira = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(value);
	if (jira) return { id: `${jira[1].toUpperCase()}-${jira[2]}`, kind: "jira" };
	return githubItems(value, repo)[0];
}

/**
 * Work items of one run. `known` is the set of known Jira prefixes (uppercase).
 * Returns items in precedence order, deduplicated by id; the first is primary.
 */
export function collectWorkItems({ explicit, branch, prompt, repo, known }) {
	const found = [];
	const add = (items, source) => {
		for (const item of items) if (!found.some((f) => f.id === item.id)) found.push({ ...item, source });
	};
	if (explicit) add([explicit], "explicit");
	add(branchItems(branch, known), "branch");
	const round = PR_ROUND.test(prompt ?? "");
	if (round) add(githubItems(prompt, repo).filter((i) => i.kind === "github-pr"), "pr-round");
	add([...jiraKeys(prompt, JIRA_UPPER, (prefix) => known.has(prefix)), ...githubItems(prompt, repo)], "prompt");
	return found.map((item, i) => ({ ...item, primary: i === 0 }));
}

/** Jira prefixes to learn from a run's items: branch and explicit keys only. */
export function prefixesToLearn(items) {
	return items
		.filter((i) => i.kind === "jira" && (i.source === "branch" || i.source === "explicit"))
		.map((i) => i.id.replace(/-\d+$/, ""));
}

const isWorkItem = (v) => typeof v?.id === "string" && typeof v.kind === "string";

/**
 * Work item of the latest `/track` entry on a session branch (`customType` entries with
 * `data.item`); undefined when the latest one is `/track off` or none exists.
 */
export function lastTracked(entries, customType) {
	const latest = entries.findLast((e) => e.type === "custom" && e.customType === customType);
	const item = latest?.data?.item;
	return isWorkItem(item) ? item : undefined;
}

/**
 * Reads the guardian state file: `jiraProjects` (user-edited) and `learnedJiraProjects`
 * (written by the extension). A missing or unreadable file reads as empty.
 */
export function readState(path) {
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		return data && typeof data === "object" ? data : {};
	} catch {
		return {};
	}
}

/** Known Jira prefixes of a state object, uppercase. */
export function knownPrefixes(state) {
	const all = [...(state.jiraProjects ?? []), ...(state.learnedJiraProjects ?? [])];
	return new Set(all.filter((p) => typeof p === "string").map((p) => p.toUpperCase()));
}

/**
 * Adds learned prefixes to the state file. Re-reads the file first, so concurrent sessions
 * only ever add; writes through a temporary file and rename. Returns whether it wrote.
 */
export function learnPrefixes(path, prefixes) {
	const state = readState(path);
	const known = knownPrefixes(state);
	const fresh = [...new Set(prefixes)].filter((p) => !known.has(p));
	if (fresh.length === 0) return false;
	const next = { ...state, learnedJiraProjects: [...(state.learnedJiraProjects ?? []), ...fresh].sort() };
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`);
	renameSync(tmp, path);
	return true;
}
