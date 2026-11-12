/**
 * MCP guard policy for kubernetes-mcp-server: the base checks of
 * mcp/guard/policy.mjs (secrets and personal data in the arguments) plus the
 * tier of the call's Kubernetes context (mcp/guard/tiers.mjs).
 *
 * The kind of a call comes from the tool's annotations as listed by the
 * server: readOnlyHint is a read (a read of kind Secret counts as a secret
 * read); otherwise destructiveHint, which the MCP specification defaults to
 * true, decides between destructive and write. A tool the server did not list
 * counts as destructive.
 *
 * DEV-NOTE: see my-pi notes/specs/2026-11-12-kube-aws-vcluster-mcp.md (Policy).
 */

import { classify } from "../guard/policy.mjs";
import { kubeTier, tierFinding, withTierFindings } from "../guard/tiers.mjs";

/** Kind of a call ("read", "secret", "write", "destructive") from the tool's annotations and its arguments. */
export function kubeKind(annotations, input) {
	if (!annotations) return "destructive";
	if (annotations.readOnlyHint === true) return /^secrets?$/i.test(String(input.kind ?? "")) ? "secret" : "read";
	return annotations.destructiveHint === false ? "write" : "destructive";
}

/**
 * Classifies one tools/call of the kube server. policy.tools maps tool names
 * to annotations, policy.tiers is the tier file. A call without a context
 * argument counts as prd: the server then uses the kubeconfig's
 * current-context, which can change on the host after the guard started.
 */
export function classifyKube(server, tool, args, policy = {}) {
	const base = classify(server, tool, args, policy);
	const input = args && typeof args === "object" ? args : {};
	const context = typeof input.context === "string" && input.context !== "" ? input.context : undefined;
	const target = context ? `context ${context}` : "the current context (no context argument)";
	const kind = kubeKind(policy.tools?.get(tool), input);
	return withTierFindings(base, [tierFinding(kubeTier(policy.tiers, context), kind, target)]);
}
