/**
 * Jira MCP behind the MCP guard.
 *
 * Runs mcp-atlassian (Jira only) on 127.0.0.1:18084 and the guard on
 * 127.0.0.1:8084. Site and e-mail come from `acli jira auth status`, the API
 * token from the login keychain (service jira-mcp, account = e-mail). The token
 * is held in this process's memory and sent per request as Basic auth;
 * mcp-atlassian gets placeholder credentials with ALLOW_GLOBAL_CRED_FALLBACK
 * off, so a request that bypasses the guard is rejected.
 *
 * Writes to Jira projects other than project_key in ~/.config/jflow/config.yaml
 * need confirmation; without that file the project check is off.
 *
 * Run with `node guard.mjs` from a host shell (the `jiramcp` fish function).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { createGuard, gitEmails, LISTEN_HOST, serve } from "../guard/guard.mjs";

const LISTEN_PORT = 8084;
const UPSTREAM_PORT = 18084;
// DEV-NOTE: pinned; uvx would otherwise run whatever PyPI serves at start time.
const PACKAGE = "mcp-atlassian@0.24.2";
const WORKDIR = join(os.homedir(), ".local/state/jiramcp");
// First start downloads the package.
const START_TIMEOUT_MS = 60_000;

/** Trimmed stdout of command, or "" when it fails. */
function output(command, args) {
	try {
		return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/** Site and e-mail from `acli jira auth status` output; each undefined when absent. */
export function parseAcliStatus(text) {
	return { site: text.match(/^\s*Site:\s*(\S+)/m)?.[1], email: text.match(/^\s*Email:\s*(\S+)/m)?.[1] };
}

/** project_key from the text of jflow's config.yaml, or "" when absent. */
export function projectKey(configText) {
	return configText.match(/^project_key:\s*["']?([A-Z][A-Z0-9]+)["']?\s*$/m)?.[1] ?? "";
}

/** Project key from ~/.config/jflow/config.yaml, or "" when the file is missing. */
function jflowProject() {
	try {
		return projectKey(readFileSync(join(os.homedir(), ".config/jflow/config.yaml"), "utf8"));
	} catch {
		return "";
	}
}

async function main() {
	const { site, email } = parseAcliStatus(output("acli", ["jira", "auth", "status"]));
	if (!site || !email) {
		console.error("jiramcp: acli is not logged in (acli jira auth login)");
		process.exit(1);
	}
	const token = output("security", ["find-generic-password", "-s", "jira-mcp", "-a", email, "-w"]);
	if (!token) {
		console.error(`jiramcp: no Jira API token in the keychain: security add-generic-password -U -s jira-mcp -a ${email} -w`);
		process.exit(1);
	}
	const project = jflowProject();
	mkdirSync(join(WORKDIR, "files"), { recursive: true });
	// DEV-NOTE: placeholder credentials make mcp-atlassian register its Jira tools; with fallback
	// off they never authenticate anything. MCP_ALLOWED_URL_DOMAINS stops a client header from
	// sending the injected credentials to another host. --directory: mcp-atlassian loads ./.env.
	const env = {
		...process.env,
		JIRA_URL: `https://${site}`,
		JIRA_USERNAME: email,
		JIRA_API_TOKEN: "unused",
		ALLOW_GLOBAL_CRED_FALLBACK: "false",
		MCP_ALLOWED_URL_DOMAINS: site,
		MCP_ATLASSIAN_FILES_DIR: join(WORKDIR, "files"),
	};
	await serve({
		name: "jiramcp",
		command: "uvx",
		args: ["--directory", WORKDIR, PACKAGE, "--transport", "streamable-http", "--stateless", "--host", LISTEN_HOST, "--port", String(UPSTREAM_PORT)],
		env,
		upstreamPort: UPSTREAM_PORT,
		listenPort: LISTEN_PORT,
		startTimeoutMs: START_TIMEOUT_MS,
		guard: createGuard({
			server: "jira",
			upstreamPort: UPSTREAM_PORT,
			authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
			policy: { jiraProjects: project ? [project] : [], ownEmails: [email.toLowerCase(), ...gitEmails()] },
		}),
	});
}

if (import.meta.main) await main();
