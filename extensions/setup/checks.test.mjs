import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { formatReport, notification, parseNodeVersion, q, runChecks } from "./checks.mjs";

/** Builds a fake repo and home; the home has the directories a set-up Mac has. */
function fixture(t) {
	const root = fs.mkdtempSync(join(os.tmpdir(), "setup-checks-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const home = join(root, "home");
	for (const d of ["agents", "fish/conf.d", "fish/functions"]) fs.mkdirSync(join(repo, d), { recursive: true });
	fs.writeFileSync(join(repo, "agents/AGENTS.md"), "# rules\n");
	fs.writeFileSync(join(repo, "fish/conf.d/my-pi.fish"), "# loader\n");
	fs.writeFileSync(join(repo, "fish/functions/ghmcp.fish"), "function ghmcp; end\n");
	for (const d of [".omp/agent", ".config/fish/conf.d", ".config/fish/functions"])
		fs.mkdirSync(join(home, d), { recursive: true });
	return { repo, home };
}

/** `go env GOPROXY` of a session routed through the host Go module proxy. */
const SANDBOX_GOPROXY = "http://127.0.0.1:8083,off";

/** Command and port probes of a fully set-up machine. */
const healthy = {
	run: async (cmd) => ({ node: "v26.7.0", go: SANDBOX_GOPROXY })[cmd] ?? "GitHub MCP Server 2.0.3",
	portOpen: async () => true,
};

test("creates missing links and reports nothing else on a healthy machine", async (t) => {
	const { repo, home } = fixture(t);

	const result = await runChecks({ repo, home, ...healthy });

	assert.deepEqual(result.actions, []);
	assert.equal(result.fixed.length, 2);
	assert.equal(fs.realpathSync(join(home, ".omp/agent/AGENTS.md")), fs.realpathSync(join(repo, "agents/AGENTS.md")));
	assert.equal(
		fs.realpathSync(join(home, ".config/fish/conf.d/my-pi.fish")),
		fs.realpathSync(join(repo, "fish/conf.d/my-pi.fish")),
	);
	assert.equal(fs.existsSync(join(home, ".pi")), false, "optional pi link skipped when ~/.pi/agent is absent");

	const second = await runChecks({ repo, home, ...healthy });
	assert.deepEqual(second, { fixed: [], actions: [] });
	assert.equal(formatReport(second), null);
});

test("links the pi AGENTS.md only when ~/.pi/agent exists", async (t) => {
	const { repo, home } = fixture(t);
	fs.mkdirSync(join(home, ".pi/agent"), { recursive: true });

	const result = await runChecks({ repo, home, ...healthy });

	assert.equal(result.fixed.length, 3);
	assert.equal(fs.lstatSync(join(home, ".pi/agent/AGENTS.md")).isSymbolicLink(), true);
});

test("never replaces an existing file or foreign link; prints the command instead", async (t) => {
	const { repo, home } = fixture(t);
	const regular = join(home, ".omp/agent/AGENTS.md");
	fs.writeFileSync(regular, "hand-written\n");
	const foreign = join(home, ".config/fish/conf.d/my-pi.fish");
	fs.symlinkSync(join(home, "elsewhere.fish"), foreign);

	const { fixed, actions } = await runChecks({ repo, home, ...healthy });

	assert.deepEqual(fixed, []);
	assert.equal(fs.readFileSync(regular, "utf8"), "hand-written\n");
	assert.equal(fs.readlinkSync(foreign), join(home, "elsewhere.fish"));
	assert.equal(actions.length, 2);
	assert.match(actions[0], new RegExp(`is a regular file: mv ${regular} ${regular}\\.bak && ln -s `));
	assert.match(actions[1], new RegExp(`points elsewhere: ln -sfn ${join(repo, "fish/conf.d/my-pi.fish")} ${foreign}$`));
});

test("prints mkdir and ln when a required parent directory is missing", async (t) => {
	const { repo, home } = fixture(t);
	fs.rmSync(join(home, ".config/fish"), { recursive: true });

	const { actions } = await runChecks({ repo, home, ...healthy });

	assert.deepEqual(actions, [
		`${join(home, ".config/fish/conf.d/my-pi.fish")} missing: mkdir -p ${join(home, ".config/fish/conf.d")} && ln -s ${join(repo, "fish/conf.d/my-pi.fish")} ${join(home, ".config/fish/conf.d/my-pi.fish")}`,
	]);
});

test("prints ln when the link cannot be created (read-only directory, as in the nono sandbox)", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
	const { repo, home } = fixture(t);
	const confd = join(home, ".config/fish/conf.d");
	fs.chmodSync(confd, 0o555);
	// The fixture cleanup (registered first) already removed the empty directory when this runs.
	t.after(() => fs.existsSync(confd) && fs.chmodSync(confd, 0o755));

	const { fixed, actions } = await runChecks({ repo, home, ...healthy });

	assert.equal(fixed.length, 1, "AGENTS.md link still created");
	assert.deepEqual(actions, [
		`${join(confd, "my-pi.fish")} missing: ln -s ${join(repo, "fish/conf.d/my-pi.fish")} ${join(confd, "my-pi.fish")}`,
	]);
});

test("reports a user copy of a repo fish function, but not a link to the repo file", async (t) => {
	const { repo, home } = fixture(t);
	const copy = join(home, ".config/fish/functions/ghmcp.fish");
	fs.writeFileSync(copy, "function ghmcp; echo old; end\n");

	let { actions } = await runChecks({ repo, home, ...healthy });
	assert.deepEqual(actions, [`${copy} is an obsolete copy (the repo version takes precedence): rm ${copy}`]);

	fs.rmSync(copy);
	fs.symlinkSync(join(repo, "fish/functions/ghmcp.fish"), copy);
	({ actions } = await runChecks({ repo, home, ...healthy }));
	assert.deepEqual(actions, []);
});

test("reports missing github-mcp-server, old or missing node, stale user github entry and stopped proxies and Jira MCP", async (t) => {
	const { repo, home } = fixture(t);
	fs.writeFileSync(
		join(home, ".omp/agent/mcp.json"),
		JSON.stringify({ mcpServers: { github: { type: "http", url: "http://127.0.0.1:8082/mcp" }, other: {} } }),
	);

	const { actions } = await runChecks({
		repo,
		home,
		run: async (cmd) => ({ node: "v24.1.9", go: SANDBOX_GOPROXY })[cmd] ?? null,
		portOpen: async () => false,
	});

	assert.equal(actions.length, 10);
	assert.equal(actions[0], "github-mcp-server not on PATH: brew install github-mcp-server");
	assert.match(actions[1], /^node v24\.1\.9 is older than 24\.2 /);
	assert.match(actions[2], /defines "github", which outranks my-pi\/mcp\.json: jq 'del\(\.mcpServers\.github\)' .* && chmod 600 .* && mv /);
	assert.match(actions[3], /^GitHub MCP proxy not listening on 127\.0\.0\.1:8082: run my-pi-start in a host terminal, then \/mcp reconnect github$/);
	assert.match(actions[4], /^Go module proxy not listening on 127\.0\.0\.1:8083 .*: run my-pi-start in a host terminal$/);
	assert.match(actions[5], /^Jira MCP not listening on 127\.0\.0\.1:8084: run my-pi-start in a host terminal, then \/mcp reconnect jira$/);
	assert.deepEqual(
		actions.slice(6).map((a) => a.split(":")[0]),
		[
			"Kubernetes MCP not listening on 127.0.0.1",
			"AWS MCP not listening on 127.0.0.1",
			"vcluster MCP not listening on 127.0.0.1",
			"lifepace production MCP not listening on 127.0.0.1",
		],
	);
	assert.match(actions[8], /:8087: run my-pi-start in a host terminal, then \/mcp reconnect vcluster \(or turn it off in the setup wizard\)$/);
	assert.match(actions[9], /:8088: run my-pi-start in a host terminal, then \/mcp reconnect lifepace /);

	const onlyJiraDown = await runChecks({ repo, home, ...healthy, portOpen: async (port) => port !== 8084 });
	assert.equal(onlyJiraDown.actions.length, 2, "github entry in user mcp.json plus the Jira MCP");
	assert.match(onlyJiraDown.actions[1], /^Jira MCP not listening/);

	const onlyGoDown = await runChecks({ repo, home, ...healthy, portOpen: async (port) => port !== 8083 });
	assert.equal(onlyGoDown.actions.length, 2, "github entry in user mcp.json plus the Go proxy");
	assert.match(onlyGoDown.actions[1], /^Go module proxy not listening/);

	const missingNode = await runChecks({ repo, home, run: async () => null, portOpen: async () => true });
	assert.match(missingNode.actions[1], /^node not on PATH is older than 24\.2/);
});

test("skips the checks of every MCP server in disabledServers", async (t) => {
	const { repo, home } = fixture(t);
	fs.writeFileSync(join(home, ".omp/agent/mcp.json"), JSON.stringify({ disabledServers: ["github", "jira", "kube", "aws", "vcluster", "lifepace"] }));
	const allDown = { run: async (cmd) => ({ node: "v26.7.0", go: SANDBOX_GOPROXY })[cmd] ?? null, portOpen: async () => false };

	const { actions } = await runChecks({ repo, home, ...allDown });

	assert.equal(actions.length, 1, "only the Go module proxy, which is no MCP server");
	assert.match(actions[0], /^Go module proxy not listening/);
});

test("reports a stopped Go module proxy only when GOPROXY points at it", async (t) => {
	const { repo, home } = fixture(t);
	const goDown = async (port) => port !== 8083;
	const goProxyActions = async (goProxy) =>
		(await runChecks({ repo, home, run: async (cmd) => (cmd === "go" ? goProxy : healthy.run(cmd)), portOpen: goDown }))
			.actions;

	assert.equal((await goProxyActions("http://localhost:8083")).length, 1);
	assert.equal((await goProxyActions("https://proxy.golang.org|http://127.0.0.1:8083/")).length, 1);
	assert.deepEqual(await goProxyActions("https://proxy.golang.org,direct"), [], "default GOPROXY");
	assert.deepEqual(await goProxyActions("http://127.0.0.1:80830"), [], "other port");
	assert.deepEqual(await goProxyActions(null), [], "go not on PATH");
});

test("ignores a user mcp.json that is not JSON or has no github entry", async (t) => {
	const { repo, home } = fixture(t);
	const file = join(home, ".omp/agent/mcp.json");

	fs.writeFileSync(file, "{ not json");
	assert.deepEqual((await runChecks({ repo, home, ...healthy })).actions, []);

	fs.writeFileSync(file, JSON.stringify({ mcpServers: { paperless: {} } }));
	assert.deepEqual((await runChecks({ repo, home, ...healthy })).actions, []);
});

test("parseNodeVersion handles the 24.2 boundary inputs", () => {
	assert.deepEqual(parseNodeVersion("v24.2.0\n"), [24, 2]);
	assert.deepEqual(parseNodeVersion("25.0.1"), [25, 0]);
	assert.equal(parseNodeVersion("bun 1.3"), null);
	assert.equal(parseNodeVersion(null), null);
});

test("node exactly 24.2 passes, 23.9 fails", async (t) => {
	const { repo, home } = fixture(t);
	const at = async (v) => (await runChecks({ repo, home, run: async (c) => (c === "node" ? v : "x"), portOpen: async () => true })).actions;
	assert.deepEqual(await at("v24.2.0"), []);
	assert.equal((await at("v23.9.0")).length, 1);
});

test("q leaves plain paths alone and single-quotes the rest", () => {
	assert.equal(q("/Users/a/.omp/agent/mcp.json"), "/Users/a/.omp/agent/mcp.json");
	assert.equal(q("/Users/a b/x"), "'/Users/a b/x'");
	assert.equal(q("it's"), "'it'\\''s'");
});

test("formatReport lists fixes before todos", () => {
	assert.equal(
		formatReport({ fixed: ["linked a -> b"], actions: ["c missing: ln -s d c"] }),
		"my-pi setup:\n  fixed: linked a -> b\n  todo:  c missing: ln -s d c",
	);
});

test("formatReport ends a todo list with the setup script, but not a fixes-only report", () => {
	const setup = "/Users/me/my pi/setup.fish";
	assert.equal(
		formatReport({ fixed: [], actions: ["c missing: ln -s d c"] }, setup),
		"my-pi setup:\n  todo:  c missing: ln -s d c\n  all at once, from a host terminal: fish '/Users/me/my pi/setup.fish' && my-pi-start",
	);
	assert.equal(formatReport({ fixed: ["linked a -> b"], actions: [] }, setup), "my-pi setup:\n  fixed: linked a -> b");
});

test("notification: warning while todos remain, info for fixes only, complete or silent when clean", () => {
	const clean = { fixed: [], actions: [] };
	assert.equal(notification(clean, "s.fish", true), null);
	assert.deepEqual(notification(clean, "s.fish", false), { text: "my-pi setup: complete", level: "info" });
	assert.deepEqual(notification({ fixed: ["linked a -> b"], actions: [] }, "s.fish", true), {
		text: "my-pi setup:\n  fixed: linked a -> b",
		level: "info",
	});
	const todo = notification({ fixed: ["linked a -> b"], actions: ["c missing"] }, "s.fish", true);
	assert.equal(todo.level, "warning");
	assert.match(todo.text, /todo: {2}c missing\n {2}all at once, from a host terminal: fish s\.fish && my-pi-start$/);
});
