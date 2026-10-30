import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { allowedHost, createProxy } from "./proxy.mjs";

const TOKEN = "test-token-value";

/** Starts a fake upstream that records request headers and answers with a two-chunk SSE body. */
async function startUpstream() {
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push(req.headers);
		res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
		res.write("data: one\n\n");
		setTimeout(() => res.end("data: two\n\n"), 20);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return { server, seen, port: server.address().port };
}

async function startProxy(upstreamPort) {
	const proxy = createProxy({ token: TOKEN, upstreamPort });
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	return { proxy, port: proxy.address().port };
}

/** Sends one POST to the proxy and returns status, headers and full body. */
function post(port, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { "content-type": "application/json", ...headers } },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
			},
		);
		req.on("error", reject);
		req.end('{"jsonrpc":"2.0","id":1,"method":"ping"}');
	});
}

test("allowedHost accepts only loopback names on the bound port", () => {
	assert.equal(allowedHost("127.0.0.1:8082", 8082), true);
	assert.equal(allowedHost("localhost:8082", 8082), true);
	assert.equal(allowedHost("evil.example:8082", 8082), false);
	assert.equal(allowedHost("127.0.0.1:9999", 8082), false);
	assert.equal(allowedHost("127.0.0.1", 8082), false);
	assert.equal(allowedHost(undefined, 8082), false);
});

test("proxy replaces client Authorization with the token and streams the response", async (t) => {
	const up = await startUpstream();
	const { proxy, port } = await startProxy(up.port);
	t.after(() => {
		proxy.close();
		up.server.close();
	});

	const res = await post(port, { authorization: "Bearer client-supplied", "mcp-session-id": "s1" });

	assert.equal(res.status, 200);
	assert.equal(res.body, "data: one\n\ndata: two\n\n");
	assert.equal(res.headers["mcp-session-id"], "s1");
	assert.equal(up.seen.length, 1);
	assert.equal(up.seen[0].authorization, `Bearer ${TOKEN}`);
	assert.equal(up.seen[0].host, `127.0.0.1:${up.port}`);
	assert.equal(up.seen[0]["mcp-session-id"], "s1");
});

test("proxy rejects a foreign Host header without contacting upstream", async (t) => {
	const up = await startUpstream();
	const { proxy, port } = await startProxy(up.port);
	t.after(() => {
		proxy.close();
		up.server.close();
	});

	const res = await post(port, { host: `rebind.example:${port}` });

	assert.equal(res.status, 403);
	assert.equal(up.seen.length, 0);
});

test("proxy answers 502 when upstream is down", async (t) => {
	const up = await startUpstream();
	const deadPort = up.port;
	up.server.close();
	await once(up.server, "close");
	const { proxy, port } = await startProxy(deadPort);
	t.after(() => proxy.close());

	const res = await post(port);

	assert.equal(res.status, 502);
});
