import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { formatReport, parseNodeVersion, q, runChecks } from "./checks.mjs";

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

/** Command and port probes of a fully set-up machine. */
const healthy = {
	run: async (cmd) => (cmd === "node" ? "v26.7.0" : "GitHub MCP Server 2.0.3"),
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

test("reports missing github-mcp-server, old or missing node, stale user github entry and stopped proxies", async (t) => {
	const { repo, home } = fixture(t);
	fs.writeFileSync(
		join(home, ".omp/agent/mcp.json"),
		JSON.stringify({ mcpServers: { github: { type: "http", url: "http://127.0.0.1:8082/mcp" }, other: {} } }),
	);

	const { actions } = await runChecks({
		repo,
		home,
		run: async (cmd) => (cmd === "node" ? "v24.1.9" : null),
		portOpen: async () => false,
	});

	assert.equal(actions.length, 5);
	assert.equal(actions[0], "github-mcp-server not on PATH: brew install github-mcp-server");
	assert.match(actions[1], /^node v24\.1\.9 is older than 24\.2 /);
	assert.match(actions[2], /defines "github", which outranks my-pi\/mcp\.json: jq 'del\(\.mcpServers\.github\)' .* && chmod 600 .* && mv /);
	assert.match(actions[3], /^GitHub MCP proxy not listening on 127\.0\.0\.1:8082: run ghmcp in a host terminal/);
	assert.match(actions[4], /^Go module proxy not listening on 127\.0\.0\.1:8083 .*: run gomodproxy in a host terminal$/);

	const onlyGoDown = await runChecks({ repo, home, ...healthy, portOpen: async (port) => port !== 8083 });
	assert.equal(onlyGoDown.actions.length, 2, "github entry in user mcp.json plus the Go proxy");
	assert.match(onlyGoDown.actions[1], /^Go module proxy not listening/);

	const missingNode = await runChecks({ repo, home, run: async () => null, portOpen: async () => true });
	assert.match(missingNode.actions[1], /^node not on PATH is older than 24\.2/);
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
