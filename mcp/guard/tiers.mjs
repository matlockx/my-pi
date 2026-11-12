/**
 * Tier map of the MCP guard: which Kubernetes contexts and AWS profiles are
 * dev, ppd or prd, and which are skipped (the agent must not use them).
 *
 * The file ~/.config/mcpguard/tiers.json is written by the MCP setup wizard
 * (mcp/setup/wizard.mjs) and read by the kube and aws guards at start. Shape:
 * { kube: { dev, ppd, prd, skip }, aws: { default, dev, ppd, prd, skip },
 * vcluster: { kubeconfig, context } }, each tier an array of exact names.
 * A name in no list is prd; a Kubernetes context named vcluster_* is the
 * vcluster tier unless a list names it.
 *
 * DEV-NOTE: see my-pi notes/specs/2026-11-12-kube-aws-vcluster-mcp.md (Tiers, Policy).
 */

import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

export const TIERS_FILE = join(os.homedir(), ".config/mcpguard/tiers.json");
export const TIERS = ["dev", "ppd", "prd"];
/** List of names the guard refuses without asking. */
export const SKIP = "skip";
const VCLUSTER_PREFIX = "vcluster_";

/** Kinds of call for which a tier asks the user; vcluster asks for nothing. */
const CONFIRM = {
	dev: new Set(["secret", "destructive"]),
	ppd: new Set(["secret", "write", "destructive"]),
	prd: new Set(["secret", "write", "destructive"]),
};
const KIND_TEXT = {
	secret: "reads a secret or credentials",
	write: "writes",
	destructive: "destructive change",
};

/** Tier or SKIP that a list of section ({ dev, ppd, prd, skip }) names name in; undefined when none does. */
export function knownTier(section, name) {
	return [...TIERS, SKIP].find((tier) => Array.isArray(section?.[tier]) && section[tier].includes(name));
}

/** Parsed tier file; {} when it is missing. A file that is not JSON throws, so a broken map never counts as empty. */
export function loadTiers(file = TIERS_FILE) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
	} catch (err) {
		if (err.code === "ENOENT") return {};
		throw new Error(`${file}: ${err.message}`);
	}
}

/** Tier of a Kubernetes context: listed tier or SKIP, else vcluster for vcluster_* names, else prd (also for no context). */
export function kubeTier(tiers, context) {
	if (!context) return "prd";
	return knownTier(tiers?.kube, context) ?? (context.startsWith(VCLUSTER_PREFIX) ? "vcluster" : "prd");
}

/** Tier of an AWS profile (the tier file's default when absent): listed tier or SKIP, else prd. */
export function awsTier(tiers, profile) {
	const name = profile ?? tiers?.aws?.default;
	return (name && knownTier(tiers?.aws, name)) || "prd";
}

/**
 * Finding for a call of kind ("read", "secret", "write", "destructive") on
 * target (for example `context x`) in tier: { decision: "deny" } for SKIP,
 * { decision: "confirm" } when the tier asks for that kind, null otherwise.
 */
export function tierFinding(tier, kind, target) {
	if (tier === SKIP) return { decision: "deny", reason: `${target} is skipped in tiers.json` };
	if (CONFIRM[tier]?.has(kind)) return { decision: "confirm", reason: `${KIND_TEXT[kind]} on ${tier} ${target}` };
	return null;
}

/**
 * Merges tier findings (null entries ignored) into base, a classify() verdict:
 * any deny refuses the call with the deny reasons only; otherwise confirm
 * reasons are added to base's reasons.
 */
export function withTierFindings(base, findings) {
	const found = findings.filter(Boolean);
	const deny = found.filter((f) => f.decision === "deny");
	if (deny.length > 0) return { decision: "deny", reasons: deny.map((f) => f.reason), allowlist: {} };
	const reasons = [...base.reasons, ...found.map((f) => f.reason)];
	return { decision: reasons.length > 0 ? "confirm" : "allow", reasons, allowlist: base.allowlist };
}
