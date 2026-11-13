import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { createTools, listEntries, runCommand } from "./server.mjs";

const HOST = { kubeconfig: "/host/kubeconfig.yaml", context: "dev-host" };
const LIST = JSON.stringify([
	{ Name: "martin", Namespace: "vc-martin", Status: "Running", Version: "0.37.5", Created: "2026-11-12T07:00:00Z", AgeSeconds: 1, Connected: false },
	{ Name: "alex", Namespace: "vc-alex", Status: "Paused", Version: "0.37.5", Created: "2026-11-12T07:00:00Z", AgeSeconds: 1, Connected: false },
]);

/** Kubeconfig as `vcluster connect --print` writes it: one context with its own cluster and user. */
const printed = (ctx, key) => `apiVersion: v1
kind: Config
clusters:
- name: ${ctx}
  cluster: {server: "https://api.martin.dev.internal"}
users:
- name: ${ctx}
  user: {client-key-data: ${key}}
contexts:
- name: ${ctx}
  context: {cluster: ${ctx}, user: ${ctx}}
current-context: ${ctx}
`;

/** Tools over a temporary kube dir; vcluster is faked, kubectl is real. calls records the vcluster invocations. */
function fixture(t, { list = LIST, key = "a2V5MQ==" } = {}) {
	const root = fs.mkdtempSync(join(os.tmpdir(), "vcluster-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const kubeDir = join(root, "configs");
	fs.mkdirSync(kubeDir);
	const calls = [];
	const run = async (command, args, env) => {
		if (command !== "vcluster") return runCommand(command, args, env);
		calls.push({ args, kubeconfig: env.KUBECONFIG });
		return args[0] === "list" ? list : printed("vcluster_martin_vc-martin_dev-host", key);
	};
	return { tools: createTools({ run, host: HOST, kubeDir, workdir: join(root, "work") }), kubeDir, calls, root };
}

const kubectl = (file, ...args) => execFileSync("kubectl", ["--kubeconfig", file, ...args], { encoding: "utf8" }).trim();

test("listEntries keeps name, namespace, status, version and creation time", () => {
	assert.deepEqual(listEntries(LIST)[0], { name: "martin", namespace: "vc-martin", status: "Running", version: "0.37.5", created: "2026-11-12T07:00:00Z" });
	assert.deepEqual(listEntries("null"), []);
	assert.deepEqual(listEntries(""), []);
});

test("vcluster_list asks the host context with the host kubeconfig", async (t) => {
	const { tools, calls } = fixture(t);

	const { vclusters } = await tools.vcluster_list();

	assert.deepEqual(vclusters.map((v) => [v.name, v.status]), [["martin", "Running"], ["alex", "Paused"]]);
	assert.deepEqual(calls, [{ args: ["list", "--output", "json", "--context", "dev-host"], kubeconfig: HOST.kubeconfig }]);
});

test("vcluster_connect writes context vcluster_<name> without current-context and returns no kubeconfig", async (t) => {
	const { tools, kubeDir, calls, root } = fixture(t);

	const result = await tools.vcluster_connect({ name: "martin" });

	assert.deepEqual(result, { context: "vcluster_martin", next: "pass context=vcluster_martin to the Kubernetes MCP tools" });
	assert.deepEqual(calls[1].args, [
		"connect",
		"martin",
		"--namespace",
		"vc-martin",
		"--context",
		"dev-host",
		"--print",
		"--background-proxy=false",
		"--server",
		"https://api.martin.dev.internal",
	]);
	const file = join(kubeDir, "vclusters.yaml");
	assert.equal(kubectl(file, "config", "get-contexts", "-o", "name"), "vcluster_martin");
	assert.throws(() => kubectl(file, "config", "current-context"));
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(join(root, "work")), [], "temporary kubeconfigs removed");
});

test("connecting again replaces the credentials and keeps other vcluster contexts", async (t) => {
	const first = fixture(t, { key: "a2V5MQ==" });
	const file = join(first.kubeDir, "vclusters.yaml");
	fs.writeFileSync(file, printed("vcluster_alex", "YWxleA==").replace("current-context: vcluster_alex\n", ""));
	await first.tools.vcluster_connect({ name: "martin" });
	// A second connect with a new key, over the file the first one wrote.
	const second = fixture(t, { key: "a2V5Mg==" });
	fs.copyFileSync(file, join(second.kubeDir, "vclusters.yaml"));
	await second.tools.vcluster_connect({ name: "martin" });

	const merged = join(second.kubeDir, "vclusters.yaml");
	assert.deepEqual(kubectl(merged, "config", "get-contexts", "-o", "name").split("\n").sort(), ["vcluster_alex", "vcluster_martin"]);
	assert.match(kubectl(merged, "config", "view", "--raw", "-o", "jsonpath={.users[?(@.name==\"vcluster_martin_vc-martin_dev-host\")].user.client-key-data}"), /^a2V5Mg==$/);
});

test("vcluster_connect refuses bad names, missing and stopped vclusters, and a missing host", async (t) => {
	const { tools, calls } = fixture(t);
	await assert.rejects(tools.vcluster_connect({ name: "Martin;rm" }), /^Error: invalid vcluster name "Martin;rm"$/);
	assert.equal(calls.length, 0, "nothing run for a bad name");
	await assert.rejects(tools.vcluster_connect({ name: "oliver" }), /vcluster oliver does not exist/);
	await assert.rejects(tools.vcluster_connect({ name: "alex" }), /vcluster alex is Paused, not Running/);
	const noHost = createTools({ run: async () => "[]", host: undefined, workdir: "/nonexistent" });
	await assert.rejects(noHost.vcluster_list(), /no vcluster host cluster in ~\/\.config\/mcpguard\/tiers\.json/);
});
