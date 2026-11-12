import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { awsTier, knownTier, kubeTier, loadTiers, tierFinding, withTierFindings } from "./tiers.mjs";

const TIERS = {
	kube: { dev: ["dev-ctx"], ppd: ["ppd-ctx"], prd: [], skip: ["old-ctx", "vcluster_gone"] },
	aws: { default: "test", dev: ["test"], ppd: ["stage"], prd: [], skip: ["stage-mfa"] },
};

test("knownTier finds the stored tier and ignores malformed sections", () => {
	const section = { dev: ["a"], prd: ["b"], ppd: "not-a-list", skip: ["c"] };
	assert.equal(knownTier(section, "a"), "dev");
	assert.equal(knownTier(section, "c"), "skip", "a skipped name stays skipped on the next run");
	assert.equal(knownTier(section, "b"), "prd");
	assert.equal(knownTier(section, "not-a-list"), undefined);
	assert.equal(knownTier(undefined, "a"), undefined);
});

test("kubeTier: listed names first, then the vcluster_ prefix, everything else prd", () => {
	assert.equal(kubeTier(TIERS, "dev-ctx"), "dev");
	assert.equal(kubeTier(TIERS, "old-ctx"), "skip");
	assert.equal(kubeTier(TIERS, "vcluster_martin"), "vcluster");
	assert.equal(kubeTier(TIERS, "vcluster_gone"), "skip", "a skip entry beats the prefix");
	assert.equal(kubeTier(TIERS, "unknown"), "prd");
	assert.equal(kubeTier(TIERS, undefined), "prd");
	assert.equal(kubeTier({}, "dev-ctx"), "prd", "no tier file");
});

test("awsTier: explicit profile, else the default; unlisted and missing default are prd", () => {
	assert.equal(awsTier(TIERS, "stage"), "ppd");
	assert.equal(awsTier(TIERS, "stage-mfa"), "skip");
	assert.equal(awsTier(TIERS, undefined), "dev", "default profile test");
	assert.equal(awsTier(TIERS, "other"), "prd");
	assert.equal(awsTier({}, undefined), "prd");
	assert.equal(awsTier(TIERS, "default"), "prd", "the key 'default' is no tier list");
});

test("tierFinding follows the policy table", () => {
	const decisions = (tier) =>
		["read", "secret", "write", "destructive"].map((kind) => tierFinding(tier, kind, "context c")?.decision ?? "allow");
	assert.deepEqual(decisions("vcluster"), ["allow", "allow", "allow", "allow"]);
	assert.deepEqual(decisions("dev"), ["allow", "confirm", "allow", "confirm"]);
	assert.deepEqual(decisions("ppd"), ["allow", "confirm", "confirm", "confirm"]);
	assert.deepEqual(decisions("prd"), ["allow", "confirm", "confirm", "confirm"]);
	assert.deepEqual(decisions("skip"), ["deny", "deny", "deny", "deny"]);
	assert.equal(tierFinding("prd", "write", "context c").reason, "writes on prd context c");
	assert.equal(tierFinding("skip", "read", "profile p").reason, "profile p is skipped in tiers.json");
});

test("withTierFindings: deny wins and drops other reasons; confirm adds to the base reasons", () => {
	const base = { decision: "confirm", reasons: ["secret in the arguments (x)"], allowlist: {} };
	assert.deepEqual(withTierFindings(base, [null, { decision: "deny", reason: "skipped" }, { decision: "confirm", reason: "w" }]), {
		decision: "deny",
		reasons: ["skipped"],
		allowlist: {},
	});
	assert.deepEqual(withTierFindings(base, [{ decision: "confirm", reason: "w" }]).reasons, ["secret in the arguments (x)", "w"]);
	assert.equal(withTierFindings({ decision: "allow", reasons: [], allowlist: {} }, [null]).decision, "allow");
});

test("loadTiers: missing file is empty, broken JSON throws", (t) => {
	const dir = fs.mkdtempSync(join(os.tmpdir(), "tiers-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	assert.deepEqual(loadTiers(join(dir, "none.json")), {});
	fs.writeFileSync(join(dir, "t.json"), "{ broken");
	assert.throws(() => loadTiers(join(dir, "t.json")), /t\.json/);
});
