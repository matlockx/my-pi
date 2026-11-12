import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { ASSET_MAX_BYTES, ASSET_MAX_REDIRECTS, assetUrl, createProxy } from "./proxy.mjs";

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

async function startProxy(upstreamPort, fetch) {
	const proxy = createProxy({ token: TOKEN, upstreamPort, fetch });
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

const ASSET = "https://github.com/user-attachments/assets/4cbd035a-f2a8-4abb-bcb8-deb87e9411d4";
const SIGNED = "https://private-user-images.githubusercontent.com/1/x.png?jwt=signed";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** Returns a fetch stand-in that answers from responses in order and records each call. */
function fakeFetch(...responses) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({ url: String(url), authorization: init.headers?.authorization });
		const next = responses.shift();
		if (!next) throw new Error("unexpected fetch");
		return next();
	};
	return { fetch, calls };
}

const redirect = (location) => () => new Response(null, { status: 302, headers: { location } });
const image = (type = "image/png", body = PNG) => () => new Response(body, { status: 200, headers: { "content-type": type } });

/** Sends one request for /asset with url as query value and returns status, headers and body bytes. */
function getAsset(port, url, method = "GET") {
	const path = url === undefined ? "/asset" : `/asset?url=${encodeURIComponent(url)}`;
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

/** Starts a proxy whose attachment downloads go to fake, with a live MCP upstream that must stay untouched. */
async function startAssetProxy(t, fake) {
	const up = await startUpstream();
	const { proxy, port } = await startProxy(up.port, fake.fetch);
	t.after(() => {
		proxy.close();
		up.server.close();
	});
	return { port, up };
}

test("assetUrl accepts only GitHub attachment URLs on https://github.com", () => {
	assert.equal(String(assetUrl(ASSET)), ASSET);
	const legacy = "https://github.com/owner/repo/assets/12345/4cbd035a-f2a8-4abb-bcb8-deb87e9411d4";
	assert.equal(String(assetUrl(legacy)), legacy);
	for (const raw of [
		ASSET.replace("https:", "http:"),
		ASSET.replace("github.com", "evil.example"),
		ASSET.replace("github.com", "github.com:8443"),
		ASSET.replace("https://", "https://user:pw@"),
		`${ASSET}?x=1`,
		`${ASSET}#frag`,
		"https://github.com/owner/repo/issues/1",
		"https://github.com/user-attachments/assets/not-a-uuid",
		"https://github.com/user-attachments/assets/%2e%2e/4cbd035a-f2a8-4abb-bcb8-deb87e9411d4",
		"not a url",
		null,
	]) {
		assert.equal(assetUrl(raw), null, String(raw));
	}
});

test("asset route sends the token only to github.com and returns the image", async (t) => {
	const fake = fakeFetch(redirect(SIGNED), image());
	const { port, up } = await startAssetProxy(t, fake);

	const res = await getAsset(port, ASSET);

	assert.equal(res.status, 200);
	assert.deepEqual(res.body, PNG);
	assert.equal(res.headers["content-type"], "image/png");
	assert.equal(res.headers["x-content-type-options"], "nosniff");
	assert.deepEqual(fake.calls, [
		{ url: ASSET, authorization: `Bearer ${TOKEN}` },
		{ url: SIGNED, authorization: undefined },
	]);
	assert.equal(up.seen.length, 0);
});

test("asset route refuses a URL outside GitHub attachments without fetching", async (t) => {
	const fake = fakeFetch();
	const { port } = await startAssetProxy(t, fake);

	assert.equal((await getAsset(port, "https://evil.example/x.png")).status, 400);
	assert.equal((await getAsset(port, undefined)).status, 400);
	assert.equal((await getAsset(port, ASSET, "POST")).status, 405);
	assert.equal(fake.calls.length, 0);
});

test("asset route refuses a redirect off https", async (t) => {
	const fake = fakeFetch(redirect("http://private-user-images.githubusercontent.com/x.png"));
	const { port } = await startAssetProxy(t, fake);

	assert.equal((await getAsset(port, ASSET)).status, 502);
	assert.equal(fake.calls.length, 1);
});

test("asset route stops after the redirect limit", async (t) => {
	const hops = Array.from({ length: ASSET_MAX_REDIRECTS + 1 }, () => redirect(SIGNED));
	const fake = fakeFetch(...hops);
	const { port } = await startAssetProxy(t, fake);

	assert.equal((await getAsset(port, ASSET)).status, 502);
	assert.equal(fake.calls.length, ASSET_MAX_REDIRECTS + 1);
});

test("asset route maps GitHub's 404 to 404 and other failures to 502", async (t) => {
	const fake = fakeFetch(
		() => new Response("Not Found", { status: 404 }),
		() => new Response("boom", { status: 500 }),
		() => Promise.reject(new TypeError("fetch failed")),
	);
	const { port } = await startAssetProxy(t, fake);

	assert.equal((await getAsset(port, ASSET)).status, 404);
	assert.equal((await getAsset(port, ASSET)).status, 502);
	assert.equal((await getAsset(port, ASSET)).status, 502);
});

test("asset route refuses SVG and other non-raster types", async (t) => {
	const fake = fakeFetch(image("image/svg+xml", "<svg/>"), image("text/html", "<html>"));
	const { port } = await startAssetProxy(t, fake);

	assert.equal((await getAsset(port, ASSET)).status, 415);
	assert.equal((await getAsset(port, ASSET)).status, 415);
});

test("asset route refuses an image larger than the cap", async (t) => {
	const chunk = new Uint8Array(1024 * 1024);
	let sent = 0;
	const huge = new ReadableStream({
		pull(controller) {
			if (sent > ASSET_MAX_BYTES) controller.close();
			else controller.enqueue(chunk);
			sent += chunk.byteLength;
		},
	});
	const fake = fakeFetch(image("image/png", huge));
	const { port } = await startAssetProxy(t, fake);

	assert.equal((await getAsset(port, ASSET)).status, 502);
});
