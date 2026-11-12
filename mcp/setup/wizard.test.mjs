import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { groupByTier, guessTier, knownTier, readJson, withDisabled, writeJson } from "./wizard.mjs";

test("guessTier: prod markers win, preprod is ppd, unknown names fail closed to prd", () => {
	assert.equal(guessTier("arn:aws:eks:eu-central-1:430896782353:cluster/intl-dev-stardust-cluster"), "dev");
	assert.equal(guessTier("test"), "dev");
	assert.equal(guessTier("stardust-stage-session"), "ppd");
	assert.equal(guessTier("intl-preprod"), "ppd");
	assert.equal(guessTier("ppd-admin"), "ppd");
	assert.equal(guessTier("stage-prod"), "prd", "a prod marker beats a lower one");
	assert.equal(guessTier("PRD-ReadOnly"), "prd");
	assert.equal(guessTier("default"), "prd");
});

test("knownTier finds the stored tier and ignores malformed sections", () => {
	const section = { dev: ["a"], prd: ["b"], ppd: "not-a-list" };
	assert.equal(knownTier(section, "a"), "dev");
	assert.equal(knownTier(section, "b"), "prd");
	assert.equal(knownTier(section, "not-a-list"), undefined);
	assert.equal(knownTier(undefined, "a"), undefined);
});

test("groupByTier always returns all three lists", () => {
	assert.deepEqual(groupByTier({ a: "dev", b: "prd", c: "dev" }), { dev: ["a", "c"], ppd: [], prd: ["b"] });
	assert.deepEqual(groupByTier({}), { dev: [], ppd: [], prd: [] });
});

test("withDisabled adds and removes a server, keeps other keys, drops an empty list", () => {
	const mcp = { mcpServers: { other: {} }, disabledServers: ["zeta"] };
	const off = withDisabled(mcp, "jira", true);
	assert.deepEqual(off, { mcpServers: { other: {} }, disabledServers: ["jira", "zeta"] });
	assert.deepEqual(mcp.disabledServers, ["zeta"], "input untouched");
	assert.deepEqual(withDisabled(off, "jira", true), off, "idempotent");
	assert.deepEqual(withDisabled(withDisabled(off, "jira", false), "zeta", false), { mcpServers: { other: {} } });
});

test("readJson returns the fallback only for a missing file and refuses broken JSON", (t) => {
	const dir = fs.mkdtempSync(join(os.tmpdir(), "wizard-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "sub/x.json");
	assert.deepEqual(readJson(file, { none: true }), { none: true });

	writeJson(file, { a: 1 }, 0o600);
	assert.deepEqual(readJson(file, null), { a: 1 });
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(join(dir, "sub")), ["x.json"], "no temporary file left");

	fs.writeFileSync(file, "{ broken");
	assert.throws(() => readJson(file, {}), /x\.json/);
});
