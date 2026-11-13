import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { allowedHost, createGuard, MAX_BODY_BYTES, SESSION_IDLE_MS } from "./guard.mjs";

const AUTH = "Bearer guard-held";

/** Starts a fake MCP server that records each request's headers and body and answers {"ok":true}. */
async function startUpstream(t) {
	const seen = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			seen.push({ headers: req.headers, body });
			res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => server.close());
	return { seen, port: server.address().port };
}

/** Path of an allowlist file in a fresh temporary directory, removed after t. */
function tempAllowlist(t) {
	const dir = mkdtempSync(join(os.tmpdir(), "mcpguard-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "allowlist.json");
}

/**
 * Starts a guard for "github" in front of upstreamPort; answers the dialog with answer ("allow",
 * "always", "deny") and records prompts, offered "always" labels and log records.
 */
async function startGuard(t, upstreamPort, answer, allowlistFile = tempAllowlist(t)) {
	const prompts = [];
	const offers = [];
	const logged = [];
	const guard = createGuard({
		server: "github",
		upstreamPort,
		authorization: AUTH,
		policy: { owners: ["matlockx"] },
		allowlistFile,
		confirm: async (text, { always }) => {
			prompts.push(text);
			offers.push(always);
			return answer;
		},
		log: (record) => logged.push(record),
	});
	guard.listen(0, "127.0.0.1");
	await once(guard, "listening");
	t.after(() => guard.close());
	return { port: guard.address().port, prompts, offers, logged };
}

/** POSTs body to the guard and returns status and response text. */
function post(port, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { "content-type": "application/json", ...headers } },
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (text += chunk));
				res.on("end", () => resolve({ status: res.statusCode, text }));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const DELETE = call(7, "delete_file", { owner: "matlockx", repo: "r", path: "a", branch: "b", message: "m" });
const COMMENT = call(8, "add_issue_comment", { owner: "matlockx", repo: "r", issue_number: 1, body: "done" });

test("allowedHost accepts only loopback names on the bound port", () => {
	assert.equal(allowedHost("127.0.0.1:8082", 8082), true);
	assert.equal(allowedHost("localhost:8082", 8082), true);
	assert.equal(allowedHost("evil.example:8082", 8082), false);
	assert.equal(allowedHost("127.0.0.1:9999", 8082), false);
	assert.equal(allowedHost(undefined, 8082), false);
});

test("an allowed call reaches the server unchanged with the guard's Authorization", async (t) => {
	const up = await startUpstream(t);
	const g = await startGuard(t, up.port, false);
	const body = JSON.stringify(COMMENT);

	const res = await post(g.port, body, { authorization: "Bearer client-supplied" });

	assert.equal(res.text, '{"ok":true}');
	assert.equal(up.seen[0].body, body);
	assert.equal(up.seen[0].headers.authorization, AUTH);
	assert.equal(g.prompts.length, 0);
	assert.deepEqual(g.logged, [{ server: "github", tool: "add_issue_comment", decision: "allow", reasons: [] }]);
});

test("a flagged call reaches the server only after Allow", async (t) => {
	const up = await startUpstream(t);
	const g = await startGuard(t, up.port, "allow");

	const res = await post(g.port, JSON.stringify(DELETE));

	assert.equal(res.text, '{"ok":true}');
	assert.equal(up.seen.length, 1);
	assert.match(g.prompts[0], /^Allow delete_file on github\?\n• destructive tool delete_file\n\n\{\n {2}"owner": "matlockx"/);
	assert.equal(g.logged[0].decision, "approved");
});

test("a denied call never reaches the server and returns a tool error for its id", async (t) => {
	const up = await startUpstream(t);
	const g = await startGuard(t, up.port, "deny");

	const res = await post(g.port, JSON.stringify(DELETE));

	assert.equal(up.seen.length, 0);
	const answer = JSON.parse(res.text);
	assert.equal(answer.id, 7);
	assert.equal(answer.result.isError, true);
	assert.match(answer.result.content[0].text, /^Blocked by the MCP guard \(destructive tool delete_file\)/);
	assert.equal(g.logged[0].decision, "denied");
});

test("a denied batch answers every request in it and forwards nothing", async (t) => {
	const up = await startUpstream(t);
	const g = await startGuard(t, up.port, "deny");
	const batch = [{ jsonrpc: "2.0", id: 1, method: "ping" }, COMMENT, DELETE, { jsonrpc: "2.0", method: "notifications/x" }];

	const res = await post(g.port, JSON.stringify(batch));

	assert.equal(up.seen.length, 0);
	const answers = JSON.parse(res.text);
	assert.deepEqual(answers.map((a) => a.id), [1, 8, 7]);
	assert.equal(answers[0].error.code, -32001);
	assert.deepEqual(g.logged.map((r) => r.decision), ["allow", "denied"]);
});

test("Always allow stores the owner, and later calls and restarts pass without asking", async (t) => {
	const up = await startUpstream(t);
	const file = tempAllowlist(t);
	const g = await startGuard(t, up.port, "always", file);
	const foreign = call(9, "add_issue_comment", { owner: "Other", repo: "r", issue_number: 1, body: "x" });

	await post(g.port, JSON.stringify(foreign));
	await post(g.port, JSON.stringify(foreign));
	const restarted = await startGuard(t, up.port, "deny", file);
	await post(restarted.port, JSON.stringify(foreign));

	assert.deepEqual(g.offers, ["Always allow other"]);
	assert.equal(restarted.prompts.length, 0);
	assert.equal(up.seen.length, 3);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { github: { owners: ["other"] } });
});

test("Always allow is not offered while another finding remains", async (t) => {
	const up = await startUpstream(t);
	const file = tempAllowlist(t);
	const g = await startGuard(t, up.port, "always", file);
	const foreignDelete = call(9, "delete_file", { owner: "Other", repo: "r", path: "a", branch: "b", message: "m" });

	const res = await post(g.port, JSON.stringify(foreignDelete));

	assert.deepEqual(g.offers, [undefined]);
	assert.equal(up.seen.length, 0, "an unoffered always answer is a denial");
	assert.match(res.text, /Blocked by the MCP guard/);
	assert.throws(() => readFileSync(file), { code: "ENOENT" });
});

test("a hand-edited owner in mixed case still matches", async (t) => {
	const up = await startUpstream(t);
	const file = tempAllowlist(t);
	writeFileSync(file, JSON.stringify({ github: { owners: ["Other"] } }));
	const g = await startGuard(t, up.port, "deny", file);

	await post(g.port, JSON.stringify(call(9, "add_issue_comment", { owner: "OTHER", repo: "r", issue_number: 1, body: "x" })));

	assert.equal(g.prompts.length, 0);
	assert.equal(up.seen.length, 1);
});

test("a body the guard cannot read is refused, not forwarded", async (t) => {
	const up = await startUpstream(t);
	const g = await startGuard(t, up.port, true);

	assert.equal((await post(g.port, "\x1f\x8b gzip bytes", { "content-encoding": "gzip" })).status, 400);
	assert.equal((await post(g.port, "x".repeat(MAX_BODY_BYTES + 1))).status, 413);
	assert.equal(up.seen.length, 0);
});

test("a foreign Host header is rejected without contacting the server", async (t) => {
	const up = await startUpstream(t);
	const g = await startGuard(t, up.port, true);

	const res = await post(g.port, JSON.stringify(COMMENT), { host: `rebind.example:${g.port}` });

	assert.equal(res.status, 403);
	assert.equal(up.seen.length, 0);
});

test("a deny verdict refuses the whole request without a dialog and forwards nothing", async (t) => {
	const up = await startUpstream(t);
	const prompts = [];
	const logged = [];
	const guard = createGuard({
		server: "kube",
		upstreamPort: up.port,
		authorization: AUTH,
		allowlistFile: tempAllowlist(t),
		classifyCall: (_server, tool) =>
			tool === "pods_list"
				? { decision: "deny", reasons: ["context x is skipped in tiers.json"], allowlist: {} }
				: { decision: "allow", reasons: [], allowlist: {} },
		confirm: async (text) => (prompts.push(text), "allow"),
		log: (record) => logged.push(record),
	});
	guard.listen(0, "127.0.0.1");
	await once(guard, "listening");
	t.after(() => guard.close());

	const res = await post(guard.address().port, JSON.stringify([call(1, "pods_log", {}), call(2, "pods_list", {})]));

	assert.equal(up.seen.length, 0);
	assert.equal(prompts.length, 0);
	const answers = JSON.parse(res.text);
	assert.deepEqual(answers.map((a) => a.id), [1, 2]);
	assert.match(
		answers[1].result.content[0].text,
		/^Blocked by the MCP guard \(context x is skipped in tiers\.json\): the guard's configuration refuses it without asking\./,
	);
	assert.deepEqual(logged.map((r) => r.decision), ["refused", "refused"]);
});

/**
 * Starts a guard with sessions whose policy confirms read_db with session: true and write_db without;
 * the dialog answers from answers in order; the clock is clock.now. Forwarded requests answer {"ok":true}.
 */
async function startSessionGuard(t, answers, clock = { now: 0 }) {
	const offers = [];
	const logged = [];
	let forwarded = 0;
	const guard = createGuard({
		server: "db",
		allowlistFile: tempAllowlist(t),
		sessions: true,
		now: () => clock.now,
		classifyCall: (_server, tool) =>
			tool === "read_db"
				? { decision: "confirm", reasons: ["reads"], allowlist: {}, session: true }
				: { decision: "confirm", reasons: ["writes"], allowlist: {} },
		forward: (req, res) => {
			forwarded++;
			req.resume();
			res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
		},
		confirm: async (_text, { always }) => {
			offers.push(always);
			return answers.shift() ?? "deny";
		},
		log: (record) => logged.push(record),
	});
	guard.listen(0, "127.0.0.1");
	await once(guard, "listening");
	t.after(() => guard.close());
	return { port: guard.address().port, offers, logged, forwarded: () => forwarded };
}

/** Sends method with body and headers to the guard; resolves status, headers and text. */
function send(port, method, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, method, path: "/mcp", headers: { "content-type": "application/json", ...headers } },
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (text += chunk));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const READ = JSON.stringify(call(2, "read_db", { query: "SELECT 1" }));
const WRITE = JSON.stringify(call(3, "write_db", { query: "UPDATE t SET a = 1" }));

/** Opens a session on the guard at port and returns its id. */
async function open(port) {
	const res = await send(port, "POST", INIT);
	assert.match(res.headers["mcp-session-id"] ?? "", /^[0-9a-f-]{36}$/);
	return res.headers["mcp-session-id"];
}

test("a guard without sessions issues no session id", async (t) => {
	const up = await startUpstream(t);
	const { port } = await startGuard(t, up.port, "allow");

	const res = await send(port, "POST", INIT);

	assert.equal(res.headers["mcp-session-id"], undefined);
});

test("allow for this session passes that session's later calls of the tool without a dialog", async (t) => {
	const g = await startSessionGuard(t, ["always"]);
	const sid = await open(g.port);

	await send(g.port, "POST", READ, { "mcp-session-id": sid });
	const again = await send(g.port, "POST", READ, { "mcp-session-id": sid });

	assert.equal(again.text, '{"ok":true}');
	assert.deepEqual(g.offers, ["Allow for this session"]);
	assert.equal(g.forwarded(), 3);
	assert.deepEqual(
		g.logged.filter((r) => r.tool).map((r) => r.decision),
		["approved", "session"],
	);
	assert.deepEqual(g.logged.find((r) => r.sessionApproved)?.sessionApproved, ["read_db"]);
});

test("another session, no session id or an unknown one is asked again and offered no carried approval", async (t) => {
	const g = await startSessionGuard(t, ["always", "deny", "deny", "deny"]);
	const first = await open(g.port);
	const second = await open(g.port);
	await send(g.port, "POST", READ, { "mcp-session-id": first });

	const other = await send(g.port, "POST", READ, { "mcp-session-id": second });
	const none = await send(g.port, "POST", READ);
	const forged = await send(g.port, "POST", READ, { "mcp-session-id": "00000000-0000-0000-0000-000000000000" });

	for (const res of [other, none, forged]) assert.match(res.text, /Blocked by the MCP guard/);
	// The second session is a known one, so it may approve for itself; the other two get no session button.
	assert.deepEqual(g.offers, ["Allow for this session", "Allow for this session", undefined, undefined]);
});

test("a call the policy does not mark session gets no session button, and always does not approve it", async (t) => {
	const g = await startSessionGuard(t, ["always"]);
	const sid = await open(g.port);

	const res = await send(g.port, "POST", JSON.stringify([JSON.parse(READ), JSON.parse(WRITE)]), { "mcp-session-id": sid });

	assert.deepEqual(g.offers, [undefined]);
	assert.match(res.text, /Blocked by the MCP guard \(reads; writes\)/);
	assert.equal(g.forwarded(), 1);
});

test("DELETE and idle time end a session and its approvals", async (t) => {
	const clock = { now: 0 };
	const g = await startSessionGuard(t, ["always", "always", "deny", "deny"], clock);
	const ended = await open(g.port);
	const idle = await open(g.port);
	await send(g.port, "POST", READ, { "mcp-session-id": ended });
	await send(g.port, "POST", READ, { "mcp-session-id": idle });

	const del = await send(g.port, "DELETE", "", { "mcp-session-id": ended });
	clock.now = SESSION_IDLE_MS + 1;
	const afterDelete = await send(g.port, "POST", READ, { "mcp-session-id": ended });
	const afterIdle = await send(g.port, "POST", READ, { "mcp-session-id": idle });

	assert.equal(del.status, 204);
	for (const res of [afterDelete, afterIdle]) assert.match(res.text, /Blocked by the MCP guard/);
	assert.deepEqual(g.offers.slice(2), [undefined, undefined]);
});
