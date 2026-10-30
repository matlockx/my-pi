/**
 * Go module proxy for nono-sandboxed omp sessions.
 *
 * Listens on 127.0.0.1:8083 and answers the GOPROXY protocol
 * (https://go.dev/ref/mod#goproxy-protocol). Modules matching the host's
 * GOPRIVATE are fetched by `go mod download` on the host, with the host's git
 * and SSH setup, into a module cache under ~/.local/state/gomodproxy that the
 * sandbox cannot write. The sandbox receives module files only, never a key or
 * token. Every other path, /sumdb/ included, is forwarded to proxy.golang.org,
 * so a private module path never reaches it.
 *
 * Anything that can connect to 127.0.0.1:8083 can read every private module
 * the host's git credentials can read. Nothing can be pushed through it.
 *
 * Requests whose Host header is not 127.0.0.1:<port> or localhost:<port> are
 * rejected with 403.
 *
 * Run with `node proxy.mjs` from a host shell (the `gomodproxy` fish function).
 */

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { join } from "node:path";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 8083;
const UPSTREAM = "https://proxy.golang.org";
const STATE_DIR = join(os.homedir(), ".local/state/gomodproxy");
const GO_TIMEOUT_MS = 300_000;
// Hop-by-hop headers (RFC 9110 section 7.6.1) plus the ones the proxy sets or must not forward.
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
	"cookie",
]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "trailer", "upgrade"]);
const CONTENT_TYPE = { list: "text/plain", latest: "application/json", info: "application/json", mod: "text/plain", zip: "application/zip" };
// Field of `go mod download -json` output holding the file served for each kind.
const DOWNLOAD_FIELD = { latest: "Info", info: "Info", mod: "GoMod", zip: "Zip" };

/** Reports whether host is a loopback Host header for port. Absent host is false. */
export function allowedHost(host, port) {
	return host === `${LISTEN_HOST}:${port}` || host === `localhost:${port}`;
}

/**
 * Reports whether modulePath matches a comma-separated GOPRIVATE pattern list,
 * with the semantics of Go's module.MatchPrefixPatterns: a pattern matches the
 * leading path elements of equal count; `*` and `?` never cross a slash.
 */
export function matchesPatterns(patterns, modulePath) {
	const elems = modulePath.split("/");
	for (let pattern of patterns.split(",")) {
		pattern = pattern.trim().replace(/\/+$/, "");
		if (!pattern) continue;
		const n = pattern.split("/").length;
		if (elems.length < n) continue;
		const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]");
		if (new RegExp(`^${re}$`).test(elems.slice(0, n).join("/"))) return true;
	}
	return false;
}

/** Decodes a GOPROXY case-escaped path element (`!x` is `X`); null when the escaping is invalid. */
export function unescape(s) {
	if (/[A-Z]/.test(s) || /![^a-z]|!$/.test(s)) return null;
	return s.replace(/!([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Splits a request path into { module, kind, version }. kind is list, latest,
 * info, mod or zip, or null for an unknown endpoint under a module path.
 * Returns null for a path without `/@` (such as /sumdb/...), and
 * { module: null } when the escaping is invalid.
 */
export function parsePath(urlPath) {
	const at = urlPath.indexOf("/@");
	if (at <= 1) return null;
	const module = unescape(decodeURIComponent(urlPath.slice(1, at)));
	const rest = urlPath.slice(at + 1);
	if (rest === "@v/list") return { module, kind: "list", version: null };
	if (rest === "@latest") return { module, kind: "latest", version: null };
	const m = /^@v\/(.+)\.(info|mod|zip)$/.exec(rest);
	if (m) return { module, kind: m[2], version: unescape(decodeURIComponent(m[1])) };
	return { module, kind: null, version: null };
}

function without(headers, drop) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!drop.has(name)) out[name] = value;
	}
	return out;
}

/**
 * Runs the go command with args and resolves to its parsed -json output.
 * Resolves to { Error } when go prints no JSON (it exits non-zero and prints
 * JSON with an Error field for a module or version that does not exist).
 */
function goJSON(args, { cwd, env }) {
	return new Promise((resolve) => {
		execFile("go", args, { cwd, env, timeout: GO_TIMEOUT_MS, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
			try {
				resolve(JSON.parse(stdout));
			} catch {
				resolve({ Error: String(stderr).trim() || err?.message || "go printed no JSON" });
			}
		});
	});
}

/** Returns the production runner: go on the host, direct VCS access, private cache. */
export function hostRunner(stateDir) {
	const cwd = join(stateDir, "work");
	fs.mkdirSync(cwd, { recursive: true });
	// DEV-NOTE: GOPROXY=direct and GOSUMDB=off because only GOPRIVATE modules reach this
	// runner; a host GONOPROXY/GOPROXY override must not send them to a public service.
	const env = {
		...process.env,
		GOMODCACHE: join(stateDir, "mod"),
		GOPROXY: "direct",
		GOSUMDB: "off",
		GOFLAGS: "-mod=mod",
		GIT_TERMINAL_PROMPT: "0",
	};
	return (args) => goJSON(args, { cwd, env });
}

/**
 * Creates the proxy server; it is not listening yet. patterns is the GOPRIVATE
 * list, runGo(args) resolves to go's -json output, upstream the base URL of
 * the public proxy.
 */
export function createProxy({ patterns, runGo, upstream = UPSTREAM }) {
	const base = new URL(upstream);
	const client = base.protocol === "https:" ? https : http;

	async function servePrivate(req, res, { module, kind, version }) {
		if (module === null || kind === null || (kind !== "list" && kind !== "latest" && version === null)) {
			res.writeHead(400, { "content-type": "text/plain" }).end("bad module request\n");
			return;
		}
		const query = `${module}@${version ?? "latest"}`;
		const out =
			kind === "list"
				? await runGo(["list", "-m", "-versions", "-json", query])
				: await runGo(["mod", "download", "-json", query]);
		// DEV-NOTE: 404 for every failure, transient ones included. go treats 404 as
		// "no module at this path" and probes the next shorter path, which is how
		// `go get module/pkg` finds the module root; the body carries go's message.
		if (out.Error) {
			res.writeHead(404, { "content-type": "text/plain" }).end(`${out.Error}\n`);
			return;
		}
		if (kind === "list") {
			const body = (out.Versions ?? []).map((v) => `${v}\n`).join("");
			res.writeHead(200, { "content-type": CONTENT_TYPE.list }).end(req.method === "HEAD" ? undefined : body);
			return;
		}
		const file = out[DOWNLOAD_FIELD[kind]];
		let size;
		try {
			size = fs.statSync(file).size;
		} catch {
			res.writeHead(404, { "content-type": "text/plain" }).end(`go reported no ${DOWNLOAD_FIELD[kind]} file for ${query}\n`);
			return;
		}
		res.writeHead(200, { "content-type": CONTENT_TYPE[kind], "content-length": size });
		if (req.method === "HEAD") res.end();
		else fs.createReadStream(file).pipe(res);
	}

	function forward(req, res) {
		const headers = without(req.headers, DROP_REQUEST);
		headers.host = base.host;
		const upstreamReq = client.request(
			{ protocol: base.protocol, host: base.hostname, port: base.port, method: req.method, path: req.url, headers },
			(upRes) => {
				res.writeHead(upRes.statusCode ?? 502, without(upRes.headers, DROP_RESPONSE));
				upRes.pipe(res);
			},
		);
		upstreamReq.on("error", (err) => {
			console.error(`gomodproxy: upstream ${req.method} ${req.url}: ${err.message}`);
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end();
		});
		res.on("close", () => upstreamReq.destroy());
		upstreamReq.end();
	}

	const server = http.createServer((req, res) => {
		req.resume();
		if (!allowedHost(req.headers.host, server.address().port)) {
			res.writeHead(403, { "content-type": "text/plain" }).end("forbidden host\n");
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { "content-type": "text/plain", allow: "GET, HEAD" }).end("method not allowed\n");
			return;
		}
		// DEV-NOTE: a path not starting with a single slash (absolute-form or `//host`)
		// could retarget the forwarded request; go never sends one.
		if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
			res.writeHead(400, { "content-type": "text/plain" }).end("bad request path\n");
			return;
		}
		let parsed;
		let lookup;
		try {
			const pathname = new URL(req.url, "http://x").pathname;
			parsed = parsePath(pathname);
			const m = /^\/sumdb\/[^/]+\/lookup\/(.+)@[^@/]*$/.exec(pathname);
			lookup = m ? unescape(decodeURIComponent(m[1])) : undefined;
		} catch {
			parsed = { module: null, kind: null, version: null };
		}
		// DEV-NOTE: a checksum lookup names the module; for a private one it is refused here
		// so the name never reaches the public sumdb, even when the client lacks GONOSUMDB.
		if (lookup === null || (lookup && matchesPatterns(patterns, lookup))) {
			res.writeHead(404, { "content-type": "text/plain" }).end("private module: no checksum database lookup (GONOSUMDB unset?)\n");
			return;
		}
		if (parsed === null) return forward(req, res);
		if (parsed.module === null) {
			res.writeHead(400, { "content-type": "text/plain" }).end("bad module path escaping\n");
			return;
		}
		if (!matchesPatterns(patterns, parsed.module)) return forward(req, res);
		servePrivate(req, res, parsed).catch((err) => {
			console.error(`gomodproxy: ${req.url}: ${err.message}`);
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
			res.end();
		});
	});
	return server;
}

function main() {
	let patterns = "";
	try {
		patterns = execFileSync("go", ["env", "GOPRIVATE"], { encoding: "utf8" }).trim();
	} catch (err) {
		console.error(`gomodproxy: go env GOPRIVATE failed: ${err.message}`);
		process.exit(1);
	}
	if (!patterns) {
		console.error("gomodproxy: GOPRIVATE is empty; nothing to serve from the host");
		process.exit(1);
	}
	// DEV-NOTE: no SIGHUP handler. nohup sets SIGHUP to ignored; a handler would
	// replace that and stop the proxy when the starting terminal closes.
	createProxy({ patterns, runGo: hostRunner(STATE_DIR) }).listen(LISTEN_PORT, LISTEN_HOST, () => {
		console.error(`gomodproxy: up on http://${LISTEN_HOST}:${LISTEN_PORT} (private: ${patterns}; rest -> ${UPSTREAM})`);
	});
}

if (import.meta.main) main();
