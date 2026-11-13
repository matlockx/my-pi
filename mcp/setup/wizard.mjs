/**
 * Interactive MCP setup for my-pi. Runs in a host terminal: setup.fish calls
 * it, and `node mcp/setup/wizard.mjs` runs it alone. Safe to run again.
 *
 * Asks for each MCP server whether it is wanted and creates what that server
 * needs: GitHub (github-mcp-server), Jira (acli login, API token in the login
 * keychain), jflow (binary on PATH), Kubernetes (kubernetes-mcp-server), AWS
 * (uvx, aws), vcluster (vcluster, kubectl) and lifepace production (the
 * lifepace checkout), and the tier map ~/.config/mcpguard/tiers.json for the
 * Kubernetes, AWS and vcluster servers. Unwanted
 * servers are listed in disabledServers of ~/.omp/agent/mcp.json: omp does not
 * connect to them, my-pi-start does not start them, and the omp setup check does
 * not report them.
 *
 * Refuses to run without a terminal or where ~/.config is not writable (the
 * nono sandbox): the agent must never write its own tiers or credentials.
 *
 * DEV-NOTE: see my-pi notes/specs/2026-11-12-kube-aws-vcluster-mcp.md (tiers).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline/promises";

import { knownTier, loadTiers, SKIP, TIERS, TIERS_FILE } from "../guard/tiers.mjs";

const SKIP_WORDS = new Set([SKIP, "s", "none", "-", "x"]);
const HOME = os.homedir();
const USER_MCP = join(HOME, ".omp/agent/mcp.json");
const KUBE_DIR = join(HOME, ".kube/configs");
// Written by the vcluster MCP; its contexts get their tier from the vcluster_ name prefix.
const VCLUSTER_KUBECONFIG = "vclusters.yaml";
const JIRA_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const ACLI_INSTALL_URL = "https://developer.atlassian.com/cloud/acli/guides/install-macos/";

/** Tier suggested by a context or profile name: prd unless the name marks a lower tier. */
export function guessTier(name) {
	const n = name.toLowerCase();
	// "preprod" names a pre-production tier, so it is no prod marker.
	if (/prod|prd|live/.test(n.replaceAll("preprod", ""))) return "prd";
	if (/ppd|preprod|stag|uat/.test(n)) return "ppd";
	if (/dev|test|sandbox/.test(n)) return "dev";
	return "prd";
}

/** Tier or SKIP for a typed answer (case-insensitive; skip, s, none, - and x mean SKIP); def for an empty answer; undefined otherwise. */
export function parseTierAnswer(answer, def) {
	const a = answer.trim().toLowerCase();
	if (a === "") return def;
	if (TIERS.includes(a)) return a;
	return SKIP_WORDS.has(a) ? SKIP : undefined;
}

/** { dev, ppd, prd, skip } name lists from a map of name to tier or SKIP. */
export function groupByTier(answers) {
	const out = { dev: [], ppd: [], prd: [], [SKIP]: [] };
	for (const [name, tier] of Object.entries(answers)) out[tier].push(name);
	return out;
}

/** Copy of mcp (a parsed omp mcp.json) with server added to or removed from disabledServers; an empty list is dropped. */
export function withDisabled(mcp, server, disabled) {
	const list = new Set(Array.isArray(mcp.disabledServers) ? mcp.disabledServers : []);
	if (disabled) list.add(server);
	else list.delete(server);
	const out = { ...mcp };
	if (list.size > 0) out.disabledServers = [...list].sort();
	else delete out.disabledServers;
	return out;
}

/** Parsed JSON of file, or fallback when it is missing. Unreadable JSON throws, so a file the wizard cannot read is never overwritten. */
export function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		if (err.code === "ENOENT") return fallback;
		throw new Error(`${file}: ${err.message}`);
	}
}

/** Writes value as JSON to file through a temporary file with mode, renamed into place. */
export function writeJson(file, value, mode) {
	fs.mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
	fs.renameSync(tmp, file);
}

/** Trimmed stdout of command, or null when it cannot run or exits non-zero. */
function output(command, args) {
	try {
		return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

/** Runs command attached to the terminal; true when it exits 0. */
function interactive(command, args) {
	return spawnSync(command, args, { stdio: "inherit" }).status === 0;
}

const onPath = (command) => output("which", [command]) !== null;

/** Asks a yes/no question; an empty answer is def. */
async function confirm(rl, question, def) {
	for (;;) {
		const answer = (await rl.question(`${question} [${def ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
		if (answer === "") return def;
		if (answer === "y" || answer === "yes") return true;
		if (answer === "n" || answer === "no") return false;
	}
}

/** Asks for a tier or SKIP; an empty answer is def. */
async function chooseTier(rl, question, def) {
	for (;;) {
		const tier = parseTierAnswer(await rl.question(`${question} [${TIERS.join("/")}/${SKIP}] (${def}) `), def);
		if (tier) return tier;
		console.log(`    answer one of ${TIERS.join(", ")}, ${SKIP} (the agent cannot use it), or Enter for ${def}`);
	}
}

/** Asks for one of options by number; an empty answer is def. */
async function select(rl, question, options, def) {
	console.log(question);
	options.forEach((option, i) => console.log(`    ${i + 1}) ${option}${option === def ? " (default)" : ""}`));
	for (;;) {
		const answer = (await rl.question("  number: ")).trim();
		if (answer === "") return def;
		const i = Number(answer);
		if (Number.isInteger(i) && i >= 1 && i <= options.length) return options[i - 1];
		console.log(`    answer 1 to ${options.length}, or Enter for the default`);
	}
}

/** Reads one line with terminal echo off. */
async function secret(rl, question) {
	spawnSync("stty", ["-echo"], { stdio: "inherit" });
	try {
		return (await rl.question(question)).trim();
	} finally {
		spawnSync("stty", ["echo"], { stdio: "inherit" });
		process.stdout.write("\n");
	}
}

async function githubStep(rl, enabled) {
	if (!(await confirm(rl, "Use the GitHub MCP (github, 127.0.0.1:8082)?", enabled))) return false;
	if (!onPath("github-mcp-server") && (await confirm(rl, "  github-mcp-server is missing. brew install github-mcp-server?", true)))
		interactive("brew", ["install", "github-mcp-server"]);
	return true;
}

const acliEmail = () => output("acli", ["jira", "auth", "status"])?.match(/^\s*Email:\s*(\S+)/m)?.[1];

async function jiraStep(rl, enabled) {
	if (!(await confirm(rl, "Use the Jira MCP (jira, 127.0.0.1:8084)?", enabled))) return false;
	if (!onPath("acli")) {
		console.log(`  todo: install acli (${ACLI_INSTALL_URL}), then run this again`);
		return true;
	}
	let email = acliEmail();
	if (!email && (await confirm(rl, "  acli is not logged in. Run acli jira auth login --web?", true))) {
		interactive("acli", ["jira", "auth", "login", "--web"]);
		email = acliEmail();
	}
	if (!email) {
		console.log("  todo: acli jira auth login, then run this again");
		return true;
	}
	// Without -w the command prints the item's attributes, never the password.
	const stored = output("security", ["find-generic-password", "-s", "jira-mcp", "-a", email]) !== null;
	if (stored && !(await confirm(rl, `  Replace the Jira API token stored for ${email}?`, false))) return true;
	console.log(`  Create an API token at ${JIRA_TOKEN_URL}`);
	const token = await secret(rl, "  Jira API token (input hidden): ");
	if (!token) {
		console.log("  no token entered; jiramcp does not start until one is stored");
		return true;
	}
	// DEV-NOTE: -w as an argument, not the interactive -w prompt: that prompt keeps only the
	// first 128 characters, shorter than an Atlassian API token (see jiramcp.fish).
	execFileSync("security", ["add-generic-password", "-U", "-s", "jira-mcp", "-a", email, "-w", token], { stdio: "ignore" });
	console.log(`  stored in the login keychain (service jira-mcp, account ${email})`);
	return true;
}

async function jflowStep(rl, enabled) {
	if (!(await confirm(rl, "Use the jflow MCP (jflow, 127.0.0.1:8765)?", enabled))) return false;
	if (!onPath("jflow")) console.log("  todo: install jflow (make install in the jflow repository), then run this again");
	return true;
}

/** Asks to use server; offers `brew install formula` when command is missing. */
async function brewToolStep(rl, enabled, question, command, formula) {
	if (!(await confirm(rl, question, enabled))) return false;
	if (!onPath(command) && (await confirm(rl, `  ${command} is missing. brew install ${formula}?`, true))) interactive("brew", ["install", formula]);
	return true;
}

const kubeStep = (rl, enabled) =>
	brewToolStep(rl, enabled, "Use the Kubernetes MCP (kube, 127.0.0.1:8085)?", "kubernetes-mcp-server", "kubernetes-mcp-server");

async function awsStep(rl, enabled) {
	if (!(await confirm(rl, "Use the AWS MCP (aws, 127.0.0.1:8086)?", enabled))) return false;
	for (const command of ["uvx", "aws"]) if (!onPath(command)) console.log(`  todo: ${command} is missing (brew install ${command === "uvx" ? "uv" : "awscli"})`);
	return true;
}

async function vclusterStep(rl, enabled) {
	if (!(await brewToolStep(rl, enabled, "Use the vcluster MCP (vcluster, 127.0.0.1:8087)?", "vcluster", "loft-sh/tap/vcluster"))) return false;
	if (!onPath("kubectl")) console.log("  todo: kubectl is missing (brew install kubectl)");
	return true;
}

async function lifepaceStep(rl, enabled) {
	if (!(await confirm(rl, "Use the lifepace production MCP (lifepace, 127.0.0.1:8088)?", enabled))) return false;
	// Same default and check as my-pi-start and mcp/lifepace/server.mjs.
	const repo = process.env.LIFEPACE_REPO || join(HOME, "projects/lifepace");
	if (!fs.existsSync(join(repo, "deploy/prod-sql.sh"))) console.log(`  todo: no ${repo}/deploy/prod-sql.sh; clone lifepace there or set LIFEPACE_REPO`);
	return true;
}

/** Contexts of the kubeconfig files in dir (vclusters.yaml excluded), first file wins per name as with KUBECONFIG. */
function kubeContexts(dir) {
	let files;
	try {
		files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && f !== VCLUSTER_KUBECONFIG).sort();
	} catch {
		return [];
	}
	const seen = new Map();
	for (const f of files) {
		const file = join(dir, f);
		for (const context of (output("kubectl", ["config", "get-contexts", "-o", "name", "--kubeconfig", file]) ?? "").split("\n")) {
			if (context && !seen.has(context)) seen.set(context, file);
		}
	}
	return [...seen].map(([context, file]) => ({ context, file }));
}

/** AWS account ID of a profile from its sso_account_id, else from the account field of its role_arn; undefined when neither names one. */
export function accountOf(ssoAccountId, roleArn) {
	if (/^\d{12}$/.test(ssoAccountId ?? "")) return ssoAccountId;
	return roleArn?.match(/^arn:aws[\w-]*:iam::(\d{12}):/)?.[1];
}

/** AWS account ID of profile as configured in ~/.aws/config; no AWS call, so no login or MFA prompt. */
function profileAccount(profile) {
	const get = (key) => output("aws", ["configure", "get", key, "--profile", profile]) ?? undefined;
	return accountOf(get("sso_account_id"), get("role_arn"));
}

/** Asks the tier of each name, shown with its label; the stored tier, else the guess, is the default. */
async function askTiers(rl, names, section, label = () => "") {
	const answers = {};
	for (const name of names)
		answers[name] = await chooseTier(rl, `    ${name}${label(name)}`, knownTier(section, name) ?? guessTier(name));
	return answers;
}

async function tiersStep(rl) {
	if (!(await confirm(rl, `Write the tier map for the Kubernetes, AWS and vcluster MCP servers (${TIERS_FILE})?`, true))) return;
	const existing = loadTiers(TIERS_FILE);
	console.log(
		`  Tiers: dev, ppd or prd; ${SKIP} means the agent cannot use it. Anything not listed counts as prd; vcluster_* contexts are the vcluster tier.`,
	);

	const contexts = kubeContexts(KUBE_DIR);
	if (contexts.length === 0) console.log(`  no contexts in ${KUBE_DIR}/*.yaml (or kubectl missing); Kubernetes tiers kept`);
	else console.log(`  Kubernetes contexts (${KUBE_DIR}/*.yaml):`);
	const kube = await askTiers(rl, contexts.map((c) => c.context), existing.kube);

	const profiles = (output("aws", ["configure", "list-profiles"]) ?? "").split("\n").filter(Boolean);
	if (profiles.length === 0) console.log("  no AWS profiles (or aws missing); AWS tiers kept");
	else console.log("  AWS profiles (aws configure list-profiles); the tier covers everything the profile can reach in its account:");
	const aws = await askTiers(rl, profiles, existing.aws, (profile) => {
		const account = profileAccount(profile);
		return account ? ` (account ${account})` : "";
	});
	let awsDefault = existing.aws?.default;
	const usable = profiles.filter((p) => aws[p] !== SKIP);
	if (usable.length > 0) {
		const fallback = usable.includes(awsDefault) ? awsDefault : (usable.find((p) => aws[p] === "dev") ?? usable[0]);
		awsDefault = await select(rl, "  Default AWS profile (commands without --profile):", usable, fallback);
	} else if (profiles.length > 0) awsDefault = undefined;

	let vcluster = existing.vcluster;
	const hosts = contexts.filter((c) => kube[c.context] === "dev");
	if (hosts.length > 0) {
		const names = hosts.map((c) => c.context);
		const context = await select(rl, "  Host cluster of your vclusters:", names, names.includes(vcluster?.context) ? vcluster.context : names[0]);
		vcluster = { kubeconfig: hosts.find((c) => c.context === context).file, context };
	}

	const tiers = {
		kube: contexts.length > 0 ? groupByTier(kube) : (existing.kube ?? groupByTier({})),
		aws: profiles.length > 0 ? { default: awsDefault, ...groupByTier(aws) } : (existing.aws ?? groupByTier({})),
		...(vcluster ? { vcluster } : {}),
	};
	writeJson(TIERS_FILE, tiers, 0o644);
	console.log(`  saved ${TIERS_FILE}`);
}

function fail(message) {
	console.error(`my-pi MCP setup: ${message}`);
	process.exit(1);
}

async function main() {
	if (!process.stdin.isTTY) fail("needs a terminal");
	try {
		fs.accessSync(join(HOME, ".config"), fs.constants.W_OK);
	} catch {
		fail("~/.config is not writable (omp sandbox?); run it from a host terminal");
	}
	const mcp = readJson(USER_MCP, {});
	const disabled = new Set(Array.isArray(mcp.disabledServers) ? mcp.disabledServers : []);
	// DEV-NOTE: terminal: false keeps the tty in cooked mode, so `stty -echo` hides the token;
	// readline's own terminal mode would echo it regardless.
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
	// Ctrl-D or a closed terminal leaves the pending question unanswered forever.
	let finished = false;
	rl.on("close", () => finished || fail("input closed; nothing more saved"));
	try {
		let next = mcp;
		// DEV-NOTE: jflow is no omp MCP server (the jflow-mcp extension connects to it), so omp
		// ignores that name; it sits in disabledServers so my-pi-start has one list to read.
		const steps = { github: githubStep, jira: jiraStep, jflow: jflowStep, kube: kubeStep, aws: awsStep, vcluster: vclusterStep, lifepace: lifepaceStep };
		for (const [server, step] of Object.entries(steps)) next = withDisabled(next, server, !(await step(rl, !disabled.has(server))));
		if (JSON.stringify(next) !== JSON.stringify(mcp)) {
			// Mode 600: the file can hold other servers' credentials.
			writeJson(USER_MCP, next, 0o600);
			console.log(`saved disabledServers (${next.disabledServers?.join(", ") ?? "none"}) in ${USER_MCP}`);
		}
		// The tier map serves the kube and aws policies and names the vcluster host.
		if (["kube", "aws", "vcluster"].some((s) => !next.disabledServers?.includes(s))) await tiersStep(rl);
	} finally {
		finished = true;
		rl.close();
	}
	console.log("MCP setup done. Run my-pi-start restart, then /mcp reconnect in omp.");
}

if (import.meta.main) await main();
