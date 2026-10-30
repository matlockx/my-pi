/**
 * GitHub MCP token proxy.
 *
 * Starts `github-mcp-server http` on 127.0.0.1:18082 without any token and
 * listens on 127.0.0.1:8082. Every forwarded request carries
 * `Authorization: Bearer <token>`, replacing any client-supplied value. The
 * token is taken from `gh auth token` stdout at start-up and held in memory
 * only: no environment variable, argument or file carries it, so a same-user
 * process (a nono-sandboxed omp session included) cannot read it through
 * `sysctl(KERN_PROCARGS2)` or `ps -E`.
 *
 * Requests whose Host header is not 127.0.0.1:<port> or localhost:<port> are
 * rejected with 403.
 *
 * Anything that can connect to 127.0.0.1:8082 can use the GitHub access the
 * token grants; only the token itself stays hidden.
 *
 * Run with `node proxy.mjs` from a host shell (the `ghmcp` fish function).
 */

import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 8082;
const UPSTREAM_PORT = 18082;
const UPSTREAM_START_TIMEOUT_MS = 10_000;
// DEV-NOTE: read-write (no --read-only), so the agent can open/close issues and PRs.
// --listen-host keeps the server off the LAN; empty binds every interface.
const SERVER_ARGS = [
	"http",
	"--listen-host",
	LISTEN_HOST,
	"--port",
	String(UPSTREAM_PORT),
	"--toolsets",
	"context,repos,issues,pull_requests,actions,users",
];
// Removed from the server's environment so the token reaches it only per request.
const TOKEN_ENV = ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
// Hop-by-hop headers (RFC 9110 section 7.6.1) plus the two the proxy sets itself.
const DROP_REQUEST = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"authorization",
]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "trailer", "upgrade"]);

/** Reports whether host is a loopback Host header for port. Absent host is false. */
export function allowedHost(host, port) {
	return host === `${LISTEN_HOST}:${port}` || host === `localhost:${port}`;
}

/** Returns a copy of headers without the names in drop. */
function without(headers, drop) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!drop.has(name)) out[name] = value;
	}
	return out;
}

/**
 * Creates the proxy server. It is not listening yet; the Host check uses the
 * port the server is bound to.
 */
export function createProxy({ token, upstreamPort }) {
	const server = http.createServer((req, res) => {
		if (!allowedHost(req.headers.host, server.address().port)) {
			res.writeHead(403, { "content-type": "text/plain" }).end("forbidden host\n");
			req.resume();
			return;
		}
		const headers = without(req.headers, DROP_REQUEST);
		headers.host = `${LISTEN_HOST}:${upstreamPort}`;
		headers.authorization = `Bearer ${token}`;
		const upstream = http.request(
			{ host: LISTEN_HOST, port: upstreamPort, method: req.method, path: req.url, headers },
			(upRes) => {
				res.writeHead(upRes.statusCode ?? 502, without(upRes.headers, DROP_RESPONSE));
				upRes.pipe(res);
			},
		);
		upstream.on("error", (err) => {
			console.error(`ghmcp-proxy: upstream ${req.method} ${req.url}: ${err.message}`);
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end();
		});
		// A client that disconnects mid-stream (SSE) releases the upstream request too.
		res.on("close", () => upstream.destroy());
		req.pipe(upstream);
	});
	return server;
}

/** Resolves once port on the loopback address accepts connections; rejects after timeoutMs. */
function waitForPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const sock = net.connect(port, LISTEN_HOST);
			sock.once("connect", () => {
				sock.destroy();
				resolve();
			});
			sock.once("error", () => {
				sock.destroy();
				if (Date.now() > deadline) reject(new Error(`port ${port} not listening after ${timeoutMs} ms`));
				else setTimeout(attempt, 200);
			});
		};
		attempt();
	});
}

function readToken() {
	try {
		return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

async function main() {
	const token = readToken();
	if (!token) {
		console.error("ghmcp-proxy: gh auth token printed nothing; run gh auth login");
		process.exit(1);
	}
	const env = { ...process.env };
	for (const name of TOKEN_ENV) delete env[name];
	const server = spawn("github-mcp-server", SERVER_ARGS, { env, stdio: ["ignore", "inherit", "inherit"] });
	server.on("error", (err) => {
		console.error(`ghmcp-proxy: cannot start github-mcp-server: ${err.message}`);
		process.exit(1);
	});
	server.on("exit", (code, signal) => {
		console.error(`ghmcp-proxy: github-mcp-server exited (${signal ?? code})`);
		process.exit(1);
	});
	// DEV-NOTE: no SIGHUP handler. nohup sets SIGHUP to ignored; a handler would
	// replace that and stop the proxy when the starting terminal closes.
	for (const sig of ["SIGTERM", "SIGINT"]) {
		process.on(sig, () => {
			server.kill("SIGTERM");
			process.exit(0);
		});
	}
	try {
		await waitForPort(UPSTREAM_PORT, UPSTREAM_START_TIMEOUT_MS);
	} catch (err) {
		console.error(`ghmcp-proxy: ${err.message}`);
		server.kill("SIGTERM");
		process.exit(1);
	}
	createProxy({ token, upstreamPort: UPSTREAM_PORT }).listen(LISTEN_PORT, LISTEN_HOST, () => {
		console.error(`ghmcp-proxy: up on http://${LISTEN_HOST}:${LISTEN_PORT}/mcp -> ${LISTEN_HOST}:${UPSTREAM_PORT}`);
	});
}

if (import.meta.main) await main();
