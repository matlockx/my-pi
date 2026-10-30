/**
 * Base-setup checks for a machine running my-pi.
 *
 * runChecks() creates missing symlinks it can write and returns, for every
 * other gap, one line with the host-shell command that closes it. It never
 * replaces or deletes an existing file, never starts a process that holds a
 * credential, and never edits a config file.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";

/** Lowest node version the GitHub MCP proxy runs on (import.meta.main). */
export const MIN_NODE = [24, 2];
export const GITHUB_MCP_PORT = 8082;
export const GO_MODULE_PROXY_PORT = 8083;

/**
 * Symlinks the repo owns. `optional` links are skipped when their parent
 * directory is absent (the tool is not installed on this machine).
 */
export function linkSpecs(repo, home) {
	const agents = join(repo, "agents/AGENTS.md");
	return [
		{ source: agents, link: join(home, ".omp/agent/AGENTS.md"), optional: false },
		{ source: agents, link: join(home, ".pi/agent/AGENTS.md"), optional: true },
		{
			source: join(repo, "fish/conf.d/my-pi.fish"),
			link: join(home, ".config/fish/conf.d/my-pi.fish"),
			optional: false,
		},
	];
}

/** Quotes s for a POSIX or fish command line when it holds anything beyond safe path characters. */
export function q(s) {
	return /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

function realpath(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

function lexists(p) {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/** Returns "ok", "fixed" or an action line for one link spec. */
function checkLink({ source, link, optional }) {
	const parent = dirname(link);
	if (lexists(link)) {
		const target = realpath(link);
		if (target !== null && target === realpath(source)) return "ok";
		if (fs.lstatSync(link).isSymbolicLink())
			return `${link} points elsewhere: ln -sfn ${q(source)} ${q(link)}`;
		return `${link} is a regular file: mv ${q(link)} ${q(`${link}.bak`)} && ln -s ${q(source)} ${q(link)}`;
	}
	if (!fs.existsSync(parent)) {
		if (optional) return "ok";
		return `${link} missing: mkdir -p ${q(parent)} && ln -s ${q(source)} ${q(link)}`;
	}
	try {
		fs.symlinkSync(source, link);
		return "fixed";
	} catch {
		// DEV-NOTE: EPERM is the normal case inside `nono --profile pi`, which
		// mounts ~/.config read-only; the user runs the command in a host shell.
		return `${link} missing: ln -s ${q(source)} ${q(link)}`;
	}
}

/** Action lines for copies in ~/.config/fish/functions of functions the repo provides. */
function checkFishCopies(repo, home) {
	const dir = join(repo, "fish/functions");
	let names = [];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".fish"));
	} catch {
		return [];
	}
	const out = [];
	for (const name of names.sort()) {
		const copy = join(home, ".config/fish/functions", name);
		if (!lexists(copy)) continue;
		if (realpath(copy) === realpath(join(dir, name))) continue;
		out.push(`${copy} is an obsolete copy (the repo version takes precedence): rm ${q(copy)}`);
	}
	return out;
}

/** Parses "v24.2.1" into [24, 2]; null when the text is not a version. */
export function parseNodeVersion(text) {
	const m = /^v?(\d+)\.(\d+)/.exec((text ?? "").trim());
	return m ? [Number(m[1]), Number(m[2])] : null;
}

function atLeast(version, min) {
	return version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);
}

/** Server names in the user-level omp mcp.json; empty when the file is absent or not JSON. */
function userMcpServers(home) {
	try {
		const parsed = JSON.parse(fs.readFileSync(join(home, ".omp/agent/mcp.json"), "utf8"));
		return Object.keys(parsed?.mcpServers ?? {});
	} catch {
		return [];
	}
}

/** Resolves to trimmed stdout of cmd, or null when it cannot run or exits non-zero. */
export function runCommand(cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 5_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
	});
}

/** Resolves true when something accepts TCP connections on 127.0.0.1:port within 1 s. */
export function isListening(port) {
	return new Promise((resolve) => {
		const sock = net.connect(port, "127.0.0.1");
		const done = (ok) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(1_000, () => done(false));
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
	});
}

/**
 * Runs every check. Returns `fixed` (links created) and `actions` (one line
 * per remaining gap, each ending in the command that closes it).
 */
export async function runChecks({ repo, home, run = runCommand, portOpen = isListening }) {
	const fixed = [];
	const actions = [];
	for (const spec of linkSpecs(repo, home)) {
		const result = checkLink(spec);
		if (result === "fixed") fixed.push(`linked ${spec.link} -> ${spec.source}`);
		else if (result !== "ok") actions.push(result);
	}
	actions.push(...checkFishCopies(repo, home));

	const [mcpVersion, nodeVersion, proxyUp, goProxyUp] = await Promise.all([
		run("github-mcp-server", ["--version"]),
		run("node", ["--version"]),
		portOpen(GITHUB_MCP_PORT),
		portOpen(GO_MODULE_PROXY_PORT),
	]);
	if (mcpVersion === null) actions.push("github-mcp-server not on PATH: brew install github-mcp-server");
	const node = parseNodeVersion(nodeVersion);
	if (node === null || !atLeast(node, MIN_NODE))
		actions.push(
			`node ${nodeVersion ?? "not on PATH"} is older than ${MIN_NODE.join(".")} (GitHub MCP proxy): brew install node`,
		);
	if (userMcpServers(home).includes("github")) {
		const file = join(home, ".omp/agent/mcp.json");
		// DEV-NOTE: chmod before mv keeps the file private; it holds other servers' credentials.
		actions.push(
			`${file} defines "github", which outranks my-pi/mcp.json: ` +
				`jq 'del(.mcpServers.github)' ${q(file)} > ${q(`${file}.tmp`)} && chmod 600 ${q(`${file}.tmp`)} && mv ${q(`${file}.tmp`)} ${q(file)}`,
		);
	}
	if (!proxyUp)
		actions.push(
			`GitHub MCP proxy not listening on 127.0.0.1:${GITHUB_MCP_PORT}: run ghmcp in a host terminal, then /mcp reconnect github`,
		);
	if (!goProxyUp)
		actions.push(
			`Go module proxy not listening on 127.0.0.1:${GO_MODULE_PROXY_PORT} (go get/build in the sandbox fails): run gomodproxy in a host terminal`,
		);
	return { fixed, actions };
}

/** Renders a check result for display; null when there is nothing to report. */
export function formatReport({ fixed, actions }) {
	if (!fixed.length && !actions.length) return null;
	const lines = ["my-pi setup:"];
	for (const f of fixed) lines.push(`  fixed: ${f}`);
	for (const a of actions) lines.push(`  todo:  ${a}`);
	return lines.join("\n");
}
