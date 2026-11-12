import test from "node:test";
import assert from "node:assert/strict";

import { classifyKube, kubeKind } from "./policy.mjs";

const TOOLS = new Map([
	["pods_list", { readOnlyHint: true }],
	["resources_get", { readOnlyHint: true }],
	["resources_scale", { readOnlyHint: false, destructiveHint: false }],
	["resources_delete", { readOnlyHint: false, destructiveHint: true }],
	["pods_exec", {}],
]);
const POLICY = {
	tools: TOOLS,
	tiers: { kube: { dev: ["dev"], ppd: ["ppd"], prd: ["prd"], skip: ["old"] } },
};
// Built at runtime so no token-shaped literal sits in the repository.
const FAKE_TOKEN = `ghp_${"a1B2".repeat(9)}`;
const decide = (tool, args) => classifyKube("kube", tool, args, POLICY);

test("kubeKind follows the annotations and the MCP default destructiveHint=true", () => {
	assert.equal(kubeKind({ readOnlyHint: true }, {}), "read");
	assert.equal(kubeKind({ readOnlyHint: true }, { kind: "Secret" }), "secret");
	assert.equal(kubeKind({ readOnlyHint: true }, { kind: "secrets" }), "secret");
	assert.equal(kubeKind({ readOnlyHint: true }, { kind: "SecretStore" }), "read", "only the Secret kind");
	assert.equal(kubeKind({ destructiveHint: false }, {}), "write");
	assert.equal(kubeKind({}, {}), "destructive", "no hints: destructive by default");
	assert.equal(kubeKind(undefined, {}), "destructive", "tool not listed by the server");
});

test("reads pass on every tier; Secret reads ask outside vclusters", () => {
	assert.equal(decide("pods_list", { context: "prd" }).decision, "allow");
	assert.equal(decide("resources_get", { context: "vcluster_martin", kind: "Secret" }).decision, "allow");
	const secret = decide("resources_get", { context: "dev", kind: "Secret", name: "db" });
	assert.equal(secret.decision, "confirm");
	assert.deepEqual(secret.reasons, ["reads a secret or credentials on dev context dev"]);
});

test("writes ask on ppd and prd only; destructive calls ask everywhere but vclusters", () => {
	assert.equal(decide("resources_scale", { context: "dev" }).decision, "allow");
	assert.equal(decide("resources_scale", { context: "ppd" }).decision, "confirm");
	assert.equal(decide("resources_delete", { context: "dev" }).decision, "confirm");
	assert.equal(decide("pods_exec", { context: "vcluster_martin" }).decision, "allow");
	assert.equal(decide("unlisted_tool", { context: "dev" }).decision, "confirm");
});

test("a missing or unlisted context counts as prd; a skipped context is refused", () => {
	const noContext = decide("resources_scale", {});
	assert.equal(noContext.decision, "confirm");
	assert.deepEqual(noContext.reasons, ["writes on prd the current context (no context argument)"]);
	assert.equal(decide("resources_scale", { context: "someone-elses" }).decision, "confirm");
	const skipped = decide("pods_list", { context: "old" });
	assert.equal(skipped.decision, "deny");
	assert.deepEqual(skipped.reasons, ["context old is skipped in tiers.json"]);
});

test("the base secret scan still applies in a vcluster", () => {
	const res = decide("pods_exec", { context: "vcluster_martin", command: ["sh", "-c", `echo ${FAKE_TOKEN}`] });
	assert.equal(res.decision, "confirm");
	assert.match(res.reasons[0], /^secret in the arguments/);
});
