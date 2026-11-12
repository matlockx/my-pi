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
 * rejected with 403. Every MCP request passes the MCP guard
 * (../guard/guard.mjs), which asks the user in a dialog before a destructive
 * call, a write outside OWNERS, or arguments carrying a secret or personal data
 * reach the server.
 *
 * `GET /asset?url=<GitHub attachment URL>` downloads an image attached to an
 * issue, pull request or comment (`https://github.com/user-attachments/assets/<uuid>`
 * or `https://github.com/<owner>/<repo>/assets/<id>/<uuid>`) and returns it.
 * The token goes only to that github.com request; the signed storage URL it
 * redirects to is fetched without it. Only PNG, JPEG, GIF and WebP up to
 * 25 MiB are returned.
 *
 * Anything that can connect to 127.0.0.1:8082 can use the GitHub access the
 * token grants; only the token itself stays hidden.
 *
 * Run with `node proxy.mjs` from a host shell (the `ghmcp` fish function).
 */

import { execFileSync } from "node:child_process";

import { createGuard, gitEmails, LISTEN_HOST, serve } from "../guard/guard.mjs";

const LISTEN_PORT = 8082;
const UPSTREAM_PORT = 18082;
// DEV-NOTE: read-write (no --read-only), so the agent can open/close issues and PRs; the guard
// asks before destructive calls. --lockdown-mode hides issue and PR content written by users
// without push access, which is where prompt injection would come from.
// --listen-host keeps the server off the LAN; empty binds every interface.
const SERVER_ARGS = [
	"http",
	"--listen-host",
	LISTEN_HOST,
	"--port",
	String(UPSTREAM_PORT),
	"--toolsets",
	"context,repos,issues,pull_requests,actions,users",
	"--lockdown-mode",
];
// GitHub owners (lower case) the guard lets writes target without asking.
const OWNERS = ["bauermediagroup-stardust", "matlockx"];
// Removed from the server's environment so the token reaches it only per request.
const TOKEN_ENV = ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
const ASSET_ROUTE = "/asset";
const ASSET_PATHS = [/^\/user-attachments\/assets\/[0-9a-f-]{36}$/, /^\/[\w.-]+\/[\w.-]+\/assets\/\d+\/[0-9a-f-]{36}$/];
const ASSET_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const ASSET_MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Returns raw as a URL when it names a GitHub attachment on https://github.com
 * without query, fragment, credentials or port; otherwise null.
 */
export function assetUrl(raw) {
	const url = URL.parse(raw ?? "");
	if (url?.protocol !== "https:" || url.host !== "github.com") return null;
	if (url.search || url.hash || url.username || url.password) return null;
	return ASSET_PATHS.some((path) => path.test(url.pathname)) ? url : null;
}

/**
 * Requests url with the token and follows at most ASSET_MAX_REDIRECTS https
 * redirects without it. Returns the final response, or null when a redirect
 * leaves https or the limit is exceeded.
 */
async function followRedirects(url, token, fetchImpl) {
	let res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
	for (let hop = 0; REDIRECTS.has(res.status); hop++) {
		await res.body?.cancel();
		const next = URL.parse(res.headers.get("location") ?? "", url);
		if (hop === ASSET_MAX_REDIRECTS || next?.protocol !== "https:") return null;
		res = await fetchImpl(next, { redirect: "manual" });
	}
	return res;
}

/** Reads body into one Buffer; returns null once it exceeds max bytes. */
async function readCapped(body, max) {
	const chunks = [];
	let size = 0;
	for await (const chunk of body) {
		size += chunk.byteLength;
		if (size > max) return null;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/**
 * Downloads the attachment at url. Returns { status: 200, type, body } on
 * success, else { status, message } with 404 when GitHub reports the asset
 * missing or invisible to the token, 415 for a non-raster type, 502 otherwise.
 */
async function fetchAsset(url, token, fetchImpl) {
	const res = await followRedirects(url, token, fetchImpl);
	if (!res) return { status: 502, message: "redirect left https or exceeded the limit" };
	const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	let failure = null;
	if (res.status === 404) failure = { status: 404, message: "asset not found or not visible to the token" };
	else if (res.status !== 200) failure = { status: 502, message: `GitHub answered ${res.status}` };
	else if (!ASSET_TYPES.has(type)) failure = { status: 415, message: `not a PNG, JPEG, GIF or WebP image: ${type || "no type"}` };
	if (failure) {
		await res.body?.cancel();
		return failure;
	}
	const body = await readCapped(res.body ?? [], ASSET_MAX_BYTES);
	return body ? { status: 200, type, body } : { status: 502, message: `larger than ${ASSET_MAX_BYTES} bytes` };
}

/** Answers GET /asset?url=… with the attachment image or a plain-text error. */
async function serveAsset(req, res, token, fetchImpl) {
	req.resume();
	const reply = (status, message) => res.writeHead(status, { "content-type": "text/plain" }).end(`${message}\n`);
	if (req.method !== "GET") return reply(405, "GET only");
	const url = assetUrl(new URL(req.url, "http://localhost").searchParams.get("url"));
	if (!url) return reply(400, "url must be a GitHub attachment: https://github.com/user-attachments/assets/<uuid>");
	try {
		const asset = await fetchAsset(url, token, fetchImpl);
		if (asset.status !== 200) return reply(asset.status, asset.message);
		res.writeHead(200, {
			"content-type": asset.type,
			"content-length": asset.body.length,
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
		}).end(asset.body);
	} catch (err) {
		console.error(`ghmcp-proxy: asset ${url}: ${err.message}`);
		if (!res.headersSent) reply(502, "fetch failed");
	}
}

/**
 * Creates the proxy server: the MCP guard for "github" with the token as
 * Authorization, plus the /asset route. It is not listening yet. fetch
 * downloads attachments and defaults to the global fetch; guard holds further
 * createGuard options (policy, confirm, log).
 */
export function createProxy({ token, upstreamPort, fetch: fetchImpl = globalThis.fetch, guard = {} }) {
	return createGuard({
		...guard,
		server: "github",
		upstreamPort,
		authorization: `Bearer ${token}`,
		extra: (req, res) => {
			if (req.url.split("?")[0] !== ASSET_ROUTE) return false;
			void serveAsset(req, res, token, fetchImpl);
			return true;
		},
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
	await serve({
		name: "ghmcp-proxy",
		command: "github-mcp-server",
		args: SERVER_ARGS,
		env,
		upstreamPort: UPSTREAM_PORT,
		listenPort: LISTEN_PORT,
		guard: createProxy({ token, upstreamPort: UPSTREAM_PORT, guard: { policy: { owners: OWNERS, ownEmails: gitEmails() } } }),
	});
}

if (import.meta.main) await main();
