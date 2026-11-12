/**
 * AWS MCP behind the MCP guard.
 *
 * Runs awslabs.aws-api-mcp-server (through uvx, pinned) as a stdio child and
 * the guard on 127.0.0.1:8086. The server uses the host's ~/.aws (profiles,
 * SSO cache); commands pick an account with --profile, and the default profile
 * of ~/.config/mcpguard/tiers.json applies without one. Local file access is
 * off. Each call is classified by mcp/aws/policy.mjs with the tier map, read
 * at start: a changed map needs a restart.
 *
 * Run with `node guard.mjs` from a host shell (bin/my-pi-start).
 */

import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { gitEmails } from "../guard/guard.mjs";
import { serveStdio } from "../guard/stdio.mjs";
import { loadTiers } from "../guard/tiers.mjs";
import { classifyAws } from "./policy.mjs";

const LISTEN_PORT = 8086;
// DEV-NOTE: pinned; uvx would otherwise run whatever PyPI serves at start time.
const PACKAGE = "awslabs.aws-api-mcp-server@1.6.0";
const WORKDIR = join(os.homedir(), ".local/state/awsmcp");
// First start downloads the package and its bundled AWS CLI.
const START_TIMEOUT_MS = 180_000;
/** Region of commands whose profile names none. */
const FALLBACK_REGION = "eu-central-1";

/** Server environment: process env plus the server options; the profile option only when profile is set. */
export function serverEnv(base, profile, workdir) {
	return {
		...base,
		...(profile ? { AWS_API_MCP_PROFILE_NAME: profile } : {}),
		AWS_REGION: FALLBACK_REGION,
		AWS_API_MCP_WORKING_DIR: join(workdir, "work"),
		AWS_API_MCP_ALLOW_UNRESTRICTED_LOCAL_FILE_ACCESS: "no-access",
		AWS_API_MCP_TELEMETRY: "false",
		AWS_API_MCP_SUPPRESS_DEPRECATION_WARNING: "true",
	};
}

async function main() {
	const tiers = loadTiers();
	fs.mkdirSync(join(WORKDIR, "work"), { recursive: true });
	await serveStdio({
		name: "awsmcp",
		command: "uvx",
		// --directory: a .env in the start directory must not configure the server.
		args: ["--directory", WORKDIR, PACKAGE],
		env: serverEnv(process.env, tiers.aws?.default, WORKDIR),
		listenPort: LISTEN_PORT,
		startTimeoutMs: START_TIMEOUT_MS,
		guard: { server: "aws", policy: { tiers, ownEmails: gitEmails() }, classifyCall: classifyAws },
	});
}

if (import.meta.main) await main();
