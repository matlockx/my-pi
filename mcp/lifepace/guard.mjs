/**
 * lifepace MCP behind the MCP guard: runs mcp/lifepace/server.mjs as a stdio
 * child and the guard on 127.0.0.1:8088, with session approvals on
 * (policy.mjs).
 *
 * Run with `node guard.mjs` from a host shell (bin/my-pi-start), never from
 * an omp session: the child needs the owner's ssh-agent, which the nono
 * sandbox denies.
 */

import { fileURLToPath } from "node:url";

import { gitEmails } from "../guard/guard.mjs";
import { serveStdio } from "../guard/stdio.mjs";
import { classifyLifepace } from "./policy.mjs";

const LISTEN_PORT = 8088;

async function main() {
	await serveStdio({
		name: "lifepacemcp",
		command: process.execPath,
		args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
		env: process.env,
		listenPort: LISTEN_PORT,
		guard: { server: "lifepace", policy: { ownEmails: gitEmails() }, classifyCall: classifyLifepace, sessions: true },
	});
}

if (import.meta.main) await main();
