/**
 * MCP guard: HTTP front for one MCP server on 127.0.0.1.
 *
 * Forwards every request to the server on upstreamPort with the guard's own
 * Authorization header, replacing any the client sent, and streams the
 * response back. Each tools/call in a POST body (one message or a batch) is
 * classified by the policy first. When a call needs confirmation the user is
 * asked in a native dialog; a denied request is answered by the guard with a
 * tool error and never reaches the server. A POST body that is not JSON or
 * exceeds MAX_BODY_BYTES is refused, so nothing the guard cannot read is
 * forwarded. Requests whose Host header is not 127.0.0.1:<port> or
 * localhost:<port> are rejected with 403.
 *
 * When every finding of a request is a missing allowlist entry (GitHub owner,
 * Jira project), the dialog also offers "Always allow"; that answer adds the
 * entries to ALLOWLIST_FILE, which extends the policy at every start.
 *
 * Every tools/call is appended to AUDIT_LOG with server, tool, decision and
 * reasons; arguments are never logged.
 */

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";

import { askUser, DIALOG_TIMEOUT_S } from "./dialog.mjs";
import { classify } from "./policy.mjs";

export const LISTEN_HOST = "127.0.0.1";
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const AUDIT_LOG = join(os.homedir(), ".local/state/mcpguard.log");
// DEV-NOTE: under ~/.config because nono mounts it read-only for the agent: only the host-side
// guard can add entries, never a sandboxed session.
export const ALLOWLIST_FILE = join(os.homedir(), ".config/mcpguard/allowlist.json");
// Case the policy compares in: GitHub owners lower case, Jira project keys upper case.
const ALLOWLIST_CASE = { owners: (v) => v.toLowerCase(), jiraProjects: (v) => v.toUpperCase() };
const ARGS_PREVIEW_CHARS = 400;
// Hop-by-hop headers (RFC 9110 section 7.6.1) plus the two the guard sets itself.
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

/** Appends record with a timestamp as one JSON line to AUDIT_LOG. */
export function auditLog(record) {
	mkdirSync(dirname(AUDIT_LOG), { recursive: true });
	appendFileSync(AUDIT_LOG, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
}

/** Reads the request body into one Buffer; resolves null when it exceeds max bytes. */
function readBody(req, max) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size <= max) chunks.push(chunk);
		});
		req.on("end", () => resolve(size > max ? null : Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** Whole allowlist file as { <server>: { owners?, jiraProjects? } }; empty when the file is missing or unreadable. */
function readAllowlistFile(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		if (err.code !== "ENOENT") console.error(`mcpguard: ignoring ${file}: ${err.message}`);
		return {};
	}
}

/**
 * policy with each owners/jiraProjects list extended by the string entries of
 * add, converted to the case the policy compares in, so hand-edited entries
 * match. A list that is empty or absent stays as it is: an empty jiraProjects
 * disables its check, and extending it would turn the check on.
 */
function extend(policy, add) {
	const out = { ...policy };
	for (const [key, toCase] of Object.entries(ALLOWLIST_CASE)) {
		const extra = Array.isArray(add?.[key]) ? add[key].filter((v) => typeof v === "string").map(toCase) : [];
		if (out[key]?.length > 0 && extra.length > 0) out[key] = [...new Set([...out[key], ...extra])];
	}
	return out;
}

/** Adds the entries of add to server's section of file, written to a temporary file first and renamed into place. */
function saveAllowlist(file, server, add) {
	const all = readAllowlistFile(file) ?? {};
	const section = { ...all[server] };
	for (const [key, values] of Object.entries(add)) section[key] = [...new Set([...(section[key] ?? []), ...values])];
	mkdirSync(dirname(file), { recursive: true });
	// Per-process temporary name: the GitHub, Jira and jflow guards share the file.
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ ...all, [server]: section }, null, 2)}\n`);
	renameSync(tmp, file);
}

/** Allowlist entries that would clear every finding of flagged, or null when another finding remains. */
function allowlistOffer(g, flagged) {
	const add = {};
	for (const v of flagged)
		for (const [key, values] of Object.entries(v.allowlist ?? {})) add[key] = [...new Set([...(add[key] ?? []), ...values])];
	if (Object.keys(add).length === 0) return null;
	const extended = extend(g.policy, add);
	return flagged.every((v) => g.classifyCall(g.server, v.tool, v.args, extended).decision === "allow") ? add : null;
}

/** Dialog text for the calls that need confirmation: a question on the first line, then reasons and arguments per call. */
function dialogText(server, flagged) {
	const heading = flagged.length === 1 ? `Allow ${flagged[0].tool} on ${server}?` : `Allow ${flagged.length} calls on ${server}?`;
	const blocks = flagged.map(({ tool, args, reasons }) => {
		const json = JSON.stringify(args ?? {}, null, 2);
		const preview = json.length > ARGS_PREVIEW_CHARS ? `${json.slice(0, ARGS_PREVIEW_CHARS)}…` : json;
		const name = flagged.length === 1 ? "" : `${tool}\n`;
		return `${name}${reasons.map((r) => `• ${r}`).join("\n")}\n\n${preview}`;
	});
	return `${heading}\n${blocks.join("\n\n")}`;
}

/** The guard's own JSON-RPC answer to parsed: a tool error for each tools/call, an error for any other request. */
function denial(parsed, reasons) {
	const text =
		`Blocked by the MCP guard (${reasons.join("; ")}): the user denied the call or did not answer within ` +
		`${DIALOG_TIMEOUT_S} s. Do not retry it or reach the server another way; ask the user.`;
	const answer = (m) =>
		m.method === "tools/call"
			? { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], isError: true } }
			: { jsonrpc: "2.0", id: m.id, error: { code: -32001, message: text } };
	return Array.isArray(parsed) ? parsed.filter((m) => m?.id !== undefined).map(answer) : answer(parsed);
}

/** Answers res with a plain-text status. */
function reply(res, status, text) {
	res.writeHead(status, { "content-type": "text/plain" }).end(`${text}\n`);
}

/**
 * Sends req to the server of g with g's Authorization and streams the answer
 * to res. body replaces the request stream when the guard has read it.
 */
function forward(g, req, res, body) {
	const headers = without(req.headers, DROP_REQUEST);
	headers.host = `${LISTEN_HOST}:${g.upstreamPort}`;
	headers.authorization = g.authorization;
	if (body) headers["content-length"] = String(body.length);
	const upstream = http.request(
		{ host: LISTEN_HOST, port: g.upstreamPort, method: req.method, path: req.url, headers },
		(upRes) => {
			res.writeHead(upRes.statusCode ?? 502, without(upRes.headers, DROP_RESPONSE));
			upRes.pipe(res);
		},
	);
	upstream.on("error", (err) => {
		console.error(`mcpguard ${g.server}: upstream ${req.method} ${req.url}: ${err.message}`);
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
		res.end();
	});
	// A client that disconnects mid-stream (SSE) releases the upstream request too.
	res.on("close", () => upstream.destroy());
	if (body) upstream.end(body);
	else req.pipe(upstream);
}

/** Policy verdict for each tools/call in parsed (one message or a batch). */
function verdictsOf(g, parsed) {
	return (Array.isArray(parsed) ? parsed : [parsed])
		.filter((m) => m?.method === "tools/call")
		.map((m) => {
			const tool = String(m.params?.name ?? "");
			const args = m.params?.arguments;
			return { tool, args, ...g.classifyCall(g.server, tool, args, g.policy) };
		});
}

/** Reads and classifies a POST, asks the user when needed, then forwards it or answers with a denial. */
async function inspect(g, req, res) {
	const body = await readBody(req, MAX_BODY_BYTES);
	if (body === null) return reply(res, 413, "request body too large");
	let parsed;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch {
		return reply(res, 400, "request body is not JSON");
	}
	const verdicts = verdictsOf(g, parsed);
	const flagged = verdicts.filter((v) => v.decision === "confirm");
	const offer = flagged.length > 0 ? allowlistOffer(g, flagged) : null;
	const always = offer ? `Always allow ${Object.values(offer).flat().join(", ")}` : undefined;
	const answer = flagged.length === 0 ? "allow" : await g.confirm(dialogText(g.server, flagged), { always });
	const approved = answer === "allow" || (answer === "always" && offer !== null);
	const outcome = approved ? "approved" : "denied";
	for (const { tool, decision, reasons } of verdicts) {
		g.log({ server: g.server, tool, decision: decision === "allow" ? "allow" : outcome, reasons });
	}
	if (answer === "always" && offer) {
		g.policy = extend(g.policy, offer);
		g.log({ server: g.server, allowlisted: offer });
		try {
			saveAllowlist(g.allowlistFile, g.server, offer);
		} catch (err) {
			// The call stays approved; only the persistence failed, so the next start asks again.
			console.error(`mcpguard ${g.server}: cannot save ${g.allowlistFile}: ${err.message}`);
		}
	}
	if (approved) return forward(g, req, res, body);
	const refusal = JSON.stringify(denial(parsed, flagged.flatMap((v) => v.reasons)));
	res.writeHead(200, { "content-type": "application/json" }).end(refusal);
}

/** Routes one request: Host check, extra routes, plain forwarding for non-POST, inspection for POST. */
function route(g, port, req, res) {
	if (!allowedHost(req.headers.host, port)) {
		reply(res, 403, "forbidden host");
		req.resume();
		return;
	}
	if (g.extra(req, res)) return;
	if (req.method !== "POST") return forward(g, req, res);
	inspect(g, req, res).catch((err) => {
		// Fails closed: nothing is forwarded after an error in the inspection.
		console.error(`mcpguard ${g.server}: ${err.message}`);
		if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
		res.end();
	});
}

/**
 * Creates the guard server; it is not listening yet, and the Host check uses
 * the port it is bound to. server names the policy ("github", "jira", "jflow");
 * authorization is the Authorization header value sent upstream; policy holds
 * the classify options (owners, jiraProjects, ownEmails), extended by server's
 * entries in allowlistFile. extra(req, res) runs after the Host check and may
 * answer a request itself by returning true. confirm(text, { always }) resolves
 * "allow", "always" or "deny". confirm, classifyCall and log default to the
 * dialog, the policy and the audit log.
 */
export function createGuard({
	server,
	upstreamPort,
	authorization,
	policy = {},
	allowlistFile = ALLOWLIST_FILE,
	extra = () => false,
	confirm = askUser,
	classifyCall = classify,
	log = auditLog,
}) {
	const g = {
		server,
		upstreamPort,
		authorization,
		policy: extend(policy, readAllowlistFile(allowlistFile)?.[server]),
		allowlistFile,
		extra,
		confirm,
		classifyCall,
		log,
	};
	const httpServer = http.createServer((req, res) => route(g, httpServer.address().port, req, res));
	return httpServer;
}

/** Lower-case e-mail addresses from the host's git config (global user.email); empty when unset. */
export function gitEmails() {
	try {
		const email = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return email.trim() ? [email.trim().toLowerCase()] : [];
	} catch {
		return [];
	}
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

/**
 * Starts command with args and env as the guarded MCP server, waits until it
 * listens on upstreamPort, then serves guard on listenPort. The process exits
 * when the server exits or does not listen within startTimeoutMs; SIGTERM and
 * SIGINT stop both. name prefixes the log lines.
 */
export async function serve({ name, command, args, env, upstreamPort, listenPort, guard, startTimeoutMs = 10_000 }) {
	const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
	child.on("error", (err) => {
		console.error(`${name}: cannot start ${command}: ${err.message}`);
		process.exit(1);
	});
	child.on("exit", (code, signal) => {
		console.error(`${name}: ${command} exited (${signal ?? code})`);
		process.exit(1);
	});
	// DEV-NOTE: no SIGHUP handler. nohup sets SIGHUP to ignored; a handler would
	// replace that and stop the guard when the starting terminal closes.
	for (const sig of ["SIGTERM", "SIGINT"]) {
		process.on(sig, () => {
			child.kill("SIGTERM");
			process.exit(0);
		});
	}
	try {
		await waitForPort(upstreamPort, startTimeoutMs);
	} catch (err) {
		console.error(`${name}: ${err.message}`);
		child.kill("SIGTERM");
		process.exit(1);
	}
	guard.listen(listenPort, LISTEN_HOST, () => {
		console.error(`${name}: up on http://${LISTEN_HOST}:${listenPort} -> ${LISTEN_HOST}:${upstreamPort}`);
	});
}
