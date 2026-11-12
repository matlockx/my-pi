/**
 * MCP guard policy: decides whether one tools/call passes or needs the
 * user's confirmation. Pure; no I/O.
 *
 * A call needs confirmation when it uses a destructive tool, writes files to a
 * GitHub default branch, writes outside the GitHub owner or Jira project
 * allowlist, carries a secret anywhere in its arguments, or carries personal
 * data in a free-text field. Everything else passes.
 *
 * DEV-NOTE: see my-pi notes/specs/2026-11-12-mcp-guard.md ("findings only").
 */

import { RULES } from "../../extensions/secret-redactor/patterns.ts";

/** Tools whose effect is hard to undo or copies data out, per server name. */
const DESTRUCTIVE = {
	github: new Set(["delete_file", "merge_pull_request", "actions_run_trigger", "create_repository", "fork_repository"]),
	jira: new Set([
		"jira_delete_issue",
		"jira_remove_issue_link",
		"jira_edit_comment",
		"jira_add_worklog",
		"jira_batch_create_issues",
		"jira_batch_create_versions",
		"jira_create_sprint",
		"jira_update_sprint",
		"jira_create_version",
		"jira_update_version",
	]),
};
/** GitHub tools that write files to `branch`, the repository default when absent. */
const FILE_WRITES = new Set(["create_or_update_file", "push_files"]);
const DEFAULT_BRANCHES = new Set(["main", "master"]);
/** Read-only tool names; any other name counts as a write. */
const READ = /^(?:jira_)?(?:get|list|search|batch_get|download)(?:_|$)|_(?:read|get|list)$/;
/** Argument names whose values are free text sent to other people. */
const FREE_TEXT = new Set(["body", "comment", "content", "description", "message", "summary", "text", "title"]);

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /\+\d{1,3}[ /-]?\(?\d{2,5}\)?(?:[ /-]?\d{2,}){2,}/;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Every string leaf of value with the name of the property holding it (arrays keep their parent's name). */
function strings(value, key = "", out = []) {
	if (typeof value === "string") out.push({ key, text: value });
	else if (Array.isArray(value)) for (const item of value) strings(item, key, out);
	else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, k, out);
	return out;
}

/** Reports whether digits pass the Luhn checksum. */
function luhn(digits) {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
		sum += d;
	}
	return sum % 10 === 0;
}

/** Reports whether candidate passes the IBAN mod-97 check. */
function validIban(candidate) {
	const s = candidate.replaceAll(" ", "");
	const moved = s.slice(4) + s.slice(0, 4);
	let rest = 0;
	for (const ch of moved) {
		const n = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
		for (const d of n) rest = (rest * 10 + Number(d)) % 97;
	}
	return rest === 1;
}

/** Kinds of personal data in text: e-mail (other than ownEmails), phone, iban, card. */
export function personalData(text, ownEmails = []) {
	const kinds = new Set();
	if ((text.match(EMAIL) ?? []).some((e) => !ownEmails.includes(e.toLowerCase()))) kinds.add("e-mail");
	if (PHONE.test(text)) kinds.add("phone");
	if ((text.match(IBAN) ?? []).some(validIban)) kinds.add("iban");
	if ((text.match(CARD) ?? []).some((c) => luhn(c.replace(/\D/g, "")))) kinds.add("card");
	return [...kinds];
}

/** Names of the secret rules matching text. */
export function secrets(text) {
	return RULES.filter((rule) => text.search(rule.regex) !== -1).map((rule) => rule.name);
}

/** Jira project keys named by `*_key`/`*_keys` arguments (`PROJ-12` and `PROJ` both give PROJ). */
function jiraProjects(args) {
	return strings(args)
		.filter(({ key }) => /_keys?$/.test(key))
		.flatMap(({ text }) => text.split(/[\s,]+/))
		.map((token) => token.split("-")[0])
		.filter((project) => /^[A-Z][A-Z0-9]+$/.test(project));
}

/** Finding about GitHub file writes to the default branch. */
function defaultBranchReasons(tool, input) {
	return FILE_WRITES.has(tool) && (!input.branch || DEFAULT_BRANCHES.has(input.branch))
		? [`writes files to the default branch (${input.branch || "default"})`]
		: [];
}

/**
 * Allowlist entries a write lacks: { owners } (lower case) for a GitHub owner
 * outside owners, { jiraProjects } for Jira projects outside projects; none
 * when projects is empty.
 */
function missingEntries(server, input, write, owners, projects) {
	if (!write) return {};
	if (server === "github" && typeof input.owner === "string" && !owners.includes(input.owner.toLowerCase()))
		return { owners: [input.owner.toLowerCase()] };
	if (server === "jira" && projects.length > 0) {
		const foreign = [...new Set(jiraProjects(input).filter((p) => !projects.includes(p)))];
		if (foreign.length > 0) return { jiraProjects: foreign };
	}
	return {};
}

/** Findings about the argument values: secrets anywhere, personal data in free-text fields. */
function contentReasons(input, ownEmails) {
	const reasons = [];
	const leaves = strings(input);
	const found = [...new Set(leaves.flatMap(({ text }) => secrets(text)))];
	if (found.length > 0) reasons.push(`secret in the arguments (${found.join(", ")})`);
	const personal = [
		...new Set(leaves.filter(({ key }) => FREE_TEXT.has(key)).flatMap(({ text }) => personalData(text, ownEmails))),
	];
	if (personal.length > 0) reasons.push(`personal data in the arguments (${personal.join(", ")})`);
	return reasons;
}

/**
 * Classifies one tools/call of server ("github", "jira" or "jflow").
 * owners: lower-case GitHub owners writes may target. jiraProjects: Jira project
 * keys writes may target; empty disables that check. ownEmails: lower-case
 * addresses that are not reported as personal data.
 * Returns { decision: "allow" | "confirm", reasons, allowlist } with one reason
 * per finding; allowlist holds the owners or jiraProjects entries whose
 * absence caused a finding.
 */
export function classify(server, tool, args, { owners = [], jiraProjects: projects = [], ownEmails = [] } = {}) {
	const input = args && typeof args === "object" ? args : {};
	const write = !READ.test(tool);
	const allowlist = missingEntries(server, input, write, owners, projects);
	const reasons = [
		...(DESTRUCTIVE[server]?.has(tool) ? [`destructive tool ${tool}`] : []),
		...(server === "github" ? defaultBranchReasons(tool, input) : []),
		...(allowlist.owners ? [`repository owner ${input.owner} is not in the allowlist`] : []),
		...(allowlist.jiraProjects ? [`Jira project ${allowlist.jiraProjects.join(", ")} is not in the allowlist`] : []),
		...contentReasons(input, ownEmails),
	];
	return { decision: reasons.length > 0 ? "confirm" : "allow", reasons, allowlist };
}
