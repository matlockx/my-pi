/**
 * jflow MCP behind the MCP guard.
 *
 * Runs `jflow mcp --http 127.0.0.1:18765` and the guard on 127.0.0.1:8765
 * (the JFLOW_MCP_URL of the jflow-mcp extension). A random token, created at
 * start and known only to this process and its jflow child, is required by
 * jflow (JFLOW_MCP_TOKEN) and sent by the guard, so a request that bypasses
 * the guard gets 401.
 *
 * Run with `node guard.mjs` from a host shell (bin/my-pi-start).
 */

import { randomBytes } from "node:crypto";

import { createGuard, gitEmails, LISTEN_HOST, serve } from "../guard/guard.mjs";

const LISTEN_PORT = 8765;
const UPSTREAM_PORT = 18765;

async function main() {
	const token = randomBytes(32).toString("hex");
	await serve({
		name: "jflow mcp",
		command: "jflow",
		args: ["mcp", "--http", `${LISTEN_HOST}:${UPSTREAM_PORT}`],
		env: { ...process.env, JFLOW_MCP_TOKEN: token },
		upstreamPort: UPSTREAM_PORT,
		listenPort: LISTEN_PORT,
		guard: createGuard({
			server: "jflow",
			upstreamPort: UPSTREAM_PORT,
			authorization: `Bearer ${token}`,
			policy: { ownEmails: gitEmails() },
		}),
	});
}

if (import.meta.main) await main();
