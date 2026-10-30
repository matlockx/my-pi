import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { once } from "node:events";
import { join } from "node:path";

import { createProxy, matchesPatterns, parsePath, unescape } from "./proxy.mjs";

const PATTERNS = "github.com/BauerMediaGroup-Stardust/*";
const MOD = "github.com/BauerMediaGroup-Stardust/timejump-service";
const ESCAPED = "github.com/!bauer!media!group-!stardust/timejump-service";

/** Starts a fake public proxy that records request paths and headers. */
async function startUpstream() {
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push({ url: req.url, headers: req.headers });
		res.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes" }).end(`upstream ${req.url}`);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

/** Starts the proxy with a fake go runner; calls records every go invocation. */
async function startProxy(t, { upstream, runGo }) {
	const calls = [];
	const proxy = createProxy({
		patterns: PATTERNS,
		upstream,
		runGo: async (args) => {
			calls.push(args);
			return runGo(args);
		},
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	t.after(() => proxy.close());
	return { port: proxy.address().port, calls };
}

function get(port, path, { method = "GET", host } = {}) {
	return new Promise((resolve, reject) => {
		const headers = host ? { host } : {};
		const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.end();
	});
}

test("matchesPatterns follows Go's prefix-element glob semantics", () => {
	assert.equal(matchesPatterns(PATTERNS, MOD), true);
	assert.equal(matchesPatterns(PATTERNS, `${MOD}/v2`), true, "deeper paths match the leading elements");
	assert.equal(matchesPatterns(PATTERNS, "github.com/BauerMediaGroup-Stardust"), false, "fewer elements than the pattern");
	assert.equal(matchesPatterns(PATTERNS, "github.com/google/uuid"), false);
	assert.equal(matchesPatterns("github.com/Bauer*", "github.com/BauerX/repo"), true);
	assert.equal(matchesPatterns("github.com/*", "github.com"), false);
	assert.equal(matchesPatterns("example.com/a.b", "example.com/aXb"), false, "dot is literal");
	assert.equal(matchesPatterns(" , gitlab.com/acme/ ,", "gitlab.com/acme/x"), true, "blank entries and trailing slash ignored");
	assert.equal(matchesPatterns("", MOD), false);
});

test("unescape decodes !x and rejects invalid escaping", () => {
	assert.equal(unescape(ESCAPED), MOD);
	assert.equal(unescape("v1.0.0"), "v1.0.0");
	assert.equal(unescape("github.com/Bauer/x"), null, "raw uppercase is not valid escaping");
	assert.equal(unescape("a!1"), null);
	assert.equal(unescape("a!"), null);
});

test("parsePath recognises every GOPROXY endpoint", () => {
	assert.deepEqual(parsePath(`/${ESCAPED}/@v/list`), { module: MOD, kind: "list", version: null });
	assert.deepEqual(parsePath(`/${ESCAPED}/@latest`), { module: MOD, kind: "latest", version: null });
	assert.deepEqual(parsePath(`/${ESCAPED}/@v/v1.2.3.info`), { module: MOD, kind: "info", version: "v1.2.3" });
	assert.deepEqual(parsePath(`/${ESCAPED}/@v/v1.2.3-!r!c1.mod`), { module: MOD, kind: "mod", version: "v1.2.3-RC1" });
	assert.deepEqual(parsePath(`/${ESCAPED}/@v/main.zip`), { module: MOD, kind: "zip", version: "main" });
	assert.deepEqual(parsePath(`/${ESCAPED}/@v/other`), { module: MOD, kind: null, version: null });
	assert.equal(parsePath("/sumdb/sum.golang.org/supported"), null);
	assert.equal(parsePath("/@v/list"), null);
	assert.equal(parsePath("/github.com/Bad/x/@v/list").module, null);
});

test("private module files come from go on the host and never reach upstream", async (t) => {
	const up = await startUpstream();
	t.after(() => up.server.close());
	const dir = fs.mkdtempSync(join(os.tmpdir(), "gomodproxy-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const files = { Info: join(dir, "v.info"), GoMod: join(dir, "v.mod"), Zip: join(dir, "v.zip") };
	fs.writeFileSync(files.Info, '{"Version":"v0.0.0-1-abc"}');
	fs.writeFileSync(files.GoMod, `module ${MOD}\n`);
	fs.writeFileSync(files.Zip, "PK-zip");
	const { port, calls } = await startProxy(t, {
		upstream: up.url,
		runGo: async (args) => (args[0] === "list" ? { Versions: ["v1.0.0", "v1.1.0"] } : { ...files }),
	});

	const list = await get(port, `/${ESCAPED}/@v/list`);
	const latest = await get(port, `/${ESCAPED}/@latest`);
	const info = await get(port, `/${ESCAPED}/@v/main.info`);
	const mod = await get(port, `/${ESCAPED}/@v/v1.1.0.mod`);
	const zip = await get(port, `/${ESCAPED}/@v/v1.1.0.zip`);
	const head = await get(port, `/${ESCAPED}/@v/v1.1.0.zip`, { method: "HEAD" });

	assert.equal(list.body, "v1.0.0\nv1.1.0\n");
	assert.equal(latest.body, '{"Version":"v0.0.0-1-abc"}');
	assert.equal(info.body, '{"Version":"v0.0.0-1-abc"}');
	assert.equal(mod.body, `module ${MOD}\n`);
	assert.equal(zip.headers["content-type"], "application/zip");
	assert.equal(zip.body, "PK-zip");
	assert.equal(head.status, 200);
	assert.equal(head.headers["content-length"], "6");
	assert.equal(head.body, "");
	assert.deepEqual(calls.slice(0, 5), [
		["list", "-m", "-versions", "-json", `${MOD}@latest`],
		["mod", "download", "-json", `${MOD}@latest`],
		["mod", "download", "-json", `${MOD}@main`],
		["mod", "download", "-json", `${MOD}@v1.1.0`],
		["mod", "download", "-json", `${MOD}@v1.1.0`],
	]);
	assert.equal(up.seen.length, 0);
});

test("a go failure on a private path is a 404 with go's message, never forwarded", async (t) => {
	const up = await startUpstream();
	t.after(() => up.server.close());
	const { port } = await startProxy(t, {
		upstream: up.url,
		runGo: async () => ({ Error: "module x/internal: no matching versions for query \"latest\"" }),
	});

	const res = await get(port, `/${ESCAPED}/internal/@latest`);
	const missingFile = await startProxy(t, { upstream: up.url, runGo: async () => ({ Zip: "/nonexistent/v.zip" }) });
	const noFile = await get(missingFile.port, `/${ESCAPED}/@v/v1.0.0.zip`);
	const unknown = await get(port, `/${ESCAPED}/@v/other`);

	assert.equal(res.status, 404);
	assert.match(res.body, /no matching versions/);
	assert.equal(noFile.status, 404);
	assert.equal(unknown.status, 400);
	assert.equal(up.seen.length, 0);
});

test("public modules and sumdb are forwarded to upstream without running go", async (t) => {
	const up = await startUpstream();
	t.after(() => up.server.close());
	const { port, calls } = await startProxy(t, { upstream: up.url, runGo: async () => assert.fail("go must not run") });

	const mod = await get(port, "/github.com/google/uuid/@v/list");
	const sumdb = await get(port, "/sumdb/sum.golang.org/supported");

	assert.equal(mod.body, "upstream /github.com/google/uuid/@v/list");
	assert.equal(mod.headers["x-upstream"], "yes");
	assert.equal(sumdb.body, "upstream /sumdb/sum.golang.org/supported");
	assert.equal(up.seen[0].headers.host, new URL(up.url).host);
	assert.equal(calls.length, 0);
});

test("a checksum lookup for a private module is refused; a public one is forwarded", async (t) => {
	const up = await startUpstream();
	t.after(() => up.server.close());
	const { port } = await startProxy(t, { upstream: up.url, runGo: async () => assert.fail("go must not run") });

	const priv = await get(port, `/sumdb/sum.golang.org/lookup/${ESCAPED}@v1.0.0`);
	const badEscape = await get(port, "/sumdb/sum.golang.org/lookup/github.com/Bad/x@v1.0.0");
	const pub = await get(port, "/sumdb/sum.golang.org/lookup/github.com/google/uuid@v1.6.0");

	assert.equal(priv.status, 404);
	assert.equal(badEscape.status, 404);
	assert.equal(pub.status, 200);
	assert.deepEqual(
		up.seen.map((s) => s.url),
		["/sumdb/sum.golang.org/lookup/github.com/google/uuid@v1.6.0"],
	);
});

test("rejects foreign Host, other methods, bad escaping and retargeting paths before any work", async (t) => {
	const up = await startUpstream();
	t.after(() => up.server.close());
	const { port, calls } = await startProxy(t, { upstream: up.url, runGo: async () => assert.fail("go must not run") });

	assert.equal((await get(port, `/${ESCAPED}/@v/list`, { host: `rebind.example:${port}` })).status, 403);
	assert.equal((await get(port, `/${ESCAPED}/@v/list`, { method: "POST" })).status, 405);
	assert.equal((await get(port, "/github.com/Bad/x/@v/list")).status, 400);
	assert.equal((await get(port, "//evil.example/x")).status, 400);
	assert.equal((await get(port, "/%E0%A4%A/@v/list")).status, 400);
	assert.equal(up.seen.length, 0);
	assert.equal(calls.length, 0);
});

test("answers 502 when upstream is down", async (t) => {
	const up = await startUpstream();
	up.server.close();
	await once(up.server, "close");
	const { port } = await startProxy(t, { upstream: up.url, runGo: async () => ({}) });

	assert.equal((await get(port, "/github.com/google/uuid/@v/list")).status, 502);
});
