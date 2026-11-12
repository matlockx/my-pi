/**
 * Kubernetes MCP behind the MCP guard.
 *
 * Runs kubernetes-mcp-server (brew install kubernetes-mcp-server) as a stdio
 * child and the guard on 127.0.0.1:8085. The server sees every context of
 * ~/.kube/configs/*.yaml plus ~/.kube/configs/vclusters.yaml (written by the
 * vcluster MCP; created empty here so the server watches it from the start).
 * Each call is classified by mcp/kube/policy.mjs with the tier map
 * ~/.config/mcpguard/tiers.json, read at start: a changed map needs a restart.
 *
 * Run with `node guard.mjs` from a host shell (bin/my-pi-start).
 */

import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { gitEmails } from "../guard/guard.mjs";
import { serveStdio } from "../guard/stdio.mjs";
import { loadTiers } from "../guard/tiers.mjs";
import { classifyKube } from "./policy.mjs";

const LISTEN_PORT = 8085;
export const KUBE_DIR = join(os.homedir(), ".kube/configs");
/** Kubeconfig of the vcluster contexts, inside KUBE_DIR. */
export const VCLUSTER_FILE = "vclusters.yaml";
const WORKDIR = join(os.homedir(), ".local/state/kubemcp");
const EMPTY_KUBECONFIG = "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n";

// DEV-NOTE: configuration_view prints the kubeconfig, tokens and client keys included.
export const CONFIG_TOML = `toolsets = ["core", "config"]
disabled_tools = ["configuration_view"]
cluster_provider_strategy = "kubeconfig"
log_file = "stderr"
server_instructions = """
Always pass the context argument: a call without it is treated as production by the MCP guard.
configuration_contexts_list lists the contexts. vcluster_<name> contexts appear after vcluster_connect of the vcluster MCP.
"""
`;

/** Kubeconfig files of dir (*.yaml and *.yml, sorted) without VCLUSTER_FILE; empty when dir is missing. */
export function kubeconfigFiles(dir) {
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => /\.ya?ml$/.test(f) && f !== VCLUSTER_FILE)
			.sort()
			.map((f) => join(dir, f));
	} catch {
		return [];
	}
}

/** KUBECONFIG value for the server: the files of dir, then its VCLUSTER_FILE. */
export function kubeconfigPath(dir) {
	return [...kubeconfigFiles(dir), join(dir, VCLUSTER_FILE)].join(":");
}

/** Creates the vcluster kubeconfig (mode 600) when it is missing. */
export function ensureVclusterFile(dir) {
	fs.mkdirSync(dir, { recursive: true });
	try {
		fs.writeFileSync(join(dir, VCLUSTER_FILE), EMPTY_KUBECONFIG, { flag: "wx", mode: 0o600 });
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
	}
}

async function main() {
	ensureVclusterFile(KUBE_DIR);
	fs.mkdirSync(WORKDIR, { recursive: true });
	const config = join(WORKDIR, "config.toml");
	fs.writeFileSync(config, CONFIG_TOML);
	await serveStdio({
		name: "kubemcp",
		command: "kubernetes-mcp-server",
		args: ["--config", config],
		env: { ...process.env, KUBECONFIG: kubeconfigPath(KUBE_DIR) },
		listenPort: LISTEN_PORT,
		guard: { server: "kube", policy: { tiers: loadTiers(), ownEmails: gitEmails() }, classifyCall: classifyKube },
	});
}

if (import.meta.main) await main();
