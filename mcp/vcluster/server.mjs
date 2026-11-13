/**
 * vcluster MCP server (stdio, newline-delimited JSON-RPC), run by
 * mcp/vcluster/guard.mjs behind the MCP guard.
 *
 * Tools:
 *   vcluster_list     the vclusters on the host cluster with status (Running,
 *                     Paused, ...), namespace, version and creation time.
 *   vcluster_connect  writes context vcluster_<name> for one vcluster into
 *                     ~/.kube/configs/vclusters.yaml, where the kube MCP finds
 *                     it. Returns only the context name, never the kubeconfig
 *                     (it holds a client key).
 *
 * The host cluster (kubeconfig file and context) is the vcluster section of
 * ~/.config/mcpguard/tiers.json, written by the MCP setup wizard. A vcluster's
 * API server is reached at api.<name>.dev.internal (VPN), as in dev-infra's
 * vcluster-claim action.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { serveStdin } from "../guard/toolserver.mjs";
import { KUBE_DIR, VCLUSTER_FILE } from "../kube/guard.mjs";
import { loadTiers } from "../guard/tiers.mjs";

const SERVER_INFO = { name: "vcluster", version: "1" };
const RUN_TIMEOUT_MS = 60_000;
/** Kubernetes DNS label: the shape of a vcluster name. */
const NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
export const CONTEXT_PREFIX = "vcluster_";

export const TOOLS = [
	{
		name: "vcluster_list",
		description:
			"List the vclusters on the dev host cluster with their status (Running, Paused, ...), namespace, version and creation time. A vcluster missing from the list does not exist (not created, or already destroyed).",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	{
		name: "vcluster_connect",
		description:
			"Make a running vcluster reachable for the Kubernetes MCP: writes the kube context vcluster_<name>. Then pass context=vcluster_<name> to the kube tools. Needs the VPN.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string", description: "vcluster name as shown by vcluster_list" } },
			required: ["name"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	},
];

/** Runs command with args and env; resolves stdout, rejects with stderr (or the error message) as the message. */
export function runCommand(command, args, env) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { env, timeout: RUN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(String(stderr).trim() || err.message));
			else resolve(String(stdout));
		});
	});
}

/** The fields of `vcluster list --output json` entries the agent needs. */
export function listEntries(json) {
	const parsed = JSON.parse(json || "[]");
	return (Array.isArray(parsed) ? parsed : []).map(({ Name, Namespace, Status, Version, Created }) => ({
		name: Name,
		namespace: Namespace,
		status: Status,
		version: Version,
		created: Created,
	}));
}

/**
 * Tool handlers over run(command, args, env) → stdout. host is the vcluster
 * section of the tier file ({ kubeconfig, context }); kubeDir and workdir are
 * where vclusters.yaml and temporary kubeconfigs live.
 */
export function createTools({ run = runCommand, host, kubeDir = KUBE_DIR, workdir }) {
	const hostEnv = () => {
		if (!host?.kubeconfig || !host?.context)
			throw new Error("no vcluster host cluster in ~/.config/mcpguard/tiers.json; the user runs the MCP setup wizard (fish setup.fish)");
		return { ...process.env, KUBECONFIG: host.kubeconfig };
	};
	const list = async () => {
		const env = hostEnv();
		return listEntries(await run("vcluster", ["list", "--output", "json", "--context", host.context], env));
	};

	/** Merges kubeconfig file tmp (one context, renamed to context) into vclusters.yaml; tmp's entries win. */
	const merge = async (tmp, context) => {
		const own = { ...process.env, KUBECONFIG: tmp };
		const original = (await run("kubectl", ["config", "current-context"], own)).trim();
		if (original !== context) await run("kubectl", ["config", "rename-context", original, context], own);
		const target = join(kubeDir, VCLUSTER_FILE);
		const merged = await run("kubectl", ["config", "view", "--flatten", "--raw"], { ...process.env, KUBECONFIG: `${tmp}:${target}` });
		const next = join(workdir, `merged.${process.pid}.yaml`);
		fs.writeFileSync(next, merged, { mode: 0o600 });
		// The kube MCP passes context explicitly; a current-context here would only shadow the host's.
		await run("kubectl", ["config", "unset", "current-context"], { ...process.env, KUBECONFIG: next });
		fs.renameSync(next, target);
	};

	return {
		vcluster_list: async () => ({ vclusters: await list() }),
		vcluster_connect: async ({ name } = {}) => {
			if (typeof name !== "string" || !NAME.test(name)) throw new Error(`invalid vcluster name ${JSON.stringify(name)}`);
			const found = (await list()).find((v) => v.name === name);
			if (!found) throw new Error(`vcluster ${name} does not exist; vcluster_list shows the existing ones`);
			if (found.status !== "Running") throw new Error(`vcluster ${name} is ${found.status}, not Running`);
			const printed = await run(
				"vcluster",
				[
					"connect",
					name,
					"--namespace",
					found.namespace,
					"--context",
					host.context,
					"--print",
					"--background-proxy=false",
					"--server",
					`https://api.${name}.dev.internal`,
				],
				hostEnv(),
			);
			fs.mkdirSync(workdir, { recursive: true });
			const tmp = join(workdir, `connect.${process.pid}.yaml`);
			fs.writeFileSync(tmp, printed, { mode: 0o600 });
			const context = `${CONTEXT_PREFIX}${name}`;
			try {
				await merge(tmp, context);
			} finally {
				fs.rmSync(tmp, { force: true });
			}
			return { context, next: `pass context=${context} to the Kubernetes MCP tools` };
		},
	};
}

function main() {
	const handlers = createTools({ host: loadTiers().vcluster, workdir: join(os.homedir(), ".local/state/vclustermcp") });
	serveStdin({ tools: TOOLS, handlers, serverInfo: SERVER_INFO });
}

if (import.meta.main) main();
