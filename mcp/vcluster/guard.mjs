/**
 * vcluster MCP behind the MCP guard: runs mcp/vcluster/server.mjs as a stdio
 * child and the guard on 127.0.0.1:8087. Both tools pass the base policy (no
 * tier checks): listing is a read, and connecting only writes a context for
 * the vcluster tier into the user's own kubeconfig.
 *
 * Run with `node guard.mjs` from a host shell (bin/my-pi-start).
 */

import { fileURLToPath } from "node:url";

import { gitEmails } from "../guard/guard.mjs";
import { serveStdio } from "../guard/stdio.mjs";

const LISTEN_PORT = 8087;

async function main() {
	await serveStdio({
		name: "vclustermcp",
		command: process.execPath,
		args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
		env: process.env,
		listenPort: LISTEN_PORT,
		guard: { server: "vcluster", policy: { ownEmails: gitEmails() } },
	});
}

if (import.meta.main) await main();
