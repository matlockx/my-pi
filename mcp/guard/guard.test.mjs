import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { allowedHost, createGuard, MAX_BODY_BYTES } from "./guard.mjs";

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

/** Starts a guard for "github" in front of upstreamPort; answers the dialog with answer and records prompts and log records. */
async function startGuard(t, upstreamPort, answer) {
	const prompts = [];
	const logged = [];
	const guard = createGuard({
		server: "github",
		upstreamPort,
		authorization: AUTH,
		policy: { owners: ["matlockx"] },
		confirm: async (text) => {
			prompts.push(text);
			return answer;
		},
		log: (record) => logged.push(record),
	});
	guard.listen(0, "127.0.0.1");
	await once(guard, "listening");
	t.after(() => guard.close());
	return { port: guard.address().port, prompts, logged };
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
	const g = await startGuard(t, up.port, true);

	const res = await post(g.port, JSON.stringify(DELETE));

	assert.equal(res.text, '{"ok":true}');
	assert.equal(up.seen.length, 1);
	assert.match(g.prompts[0], /^github: delete_file\n• destructive tool delete_file\n\n\{"owner":"matlockx"/);
	assert.equal(g.logged[0].decision, "approved");
});

test("a denied call never reaches the server and returns a tool error for its id", async (t) => {
	const up = await startUpstream(t);
	const g = await startGuard(t, up.port, false);

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
	const g = await startGuard(t, up.port, false);
	const batch = [{ jsonrpc: "2.0", id: 1, method: "ping" }, COMMENT, DELETE, { jsonrpc: "2.0", method: "notifications/x" }];

	const res = await post(g.port, JSON.stringify(batch));

	assert.equal(up.seen.length, 0);
	const answers = JSON.parse(res.text);
	assert.deepEqual(answers.map((a) => a.id), [1, 8, 7]);
	assert.equal(answers[0].error.code, -32001);
	assert.deepEqual(g.logged.map((r) => r.decision), ["allow", "denied"]);
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
