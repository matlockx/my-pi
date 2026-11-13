import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { accountOf, groupByTier, guessTier, isExecutable, parseTierAnswer, readJson, withDisabled, writeJson } from "./wizard.mjs";

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

test("groupByTier always returns every list, skip included", () => {
	assert.deepEqual(groupByTier({ a: "dev", b: "prd", c: "dev", d: "skip" }), { dev: ["a", "c"], ppd: [], prd: ["b"], skip: ["d"] });
	assert.deepEqual(groupByTier({}), { dev: [], ppd: [], prd: [], skip: [] });
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

test("accountOf prefers sso_account_id, falls back to the role ARN, and rejects other shapes", () => {
	assert.equal(accountOf("757149606988", "arn:aws:iam::430896782353:role/x"), "757149606988");
	assert.equal(accountOf(undefined, "arn:aws:iam::430896782353:role/admin"), "430896782353");
	assert.equal(accountOf("", "arn:aws-us-gov:iam::123456789012:role/r"), "123456789012");
	assert.equal(accountOf("not-an-id", "arn:aws:sts::430896782353:assumed-role/x"), undefined, "no iam ARN");
	assert.equal(accountOf(undefined, undefined), undefined, "static or MFA session keys name no account");
});

test("parseTierAnswer: tiers, skip words, default on Enter, undefined for anything else", () => {
	assert.equal(parseTierAnswer(" PRD ", "dev"), "prd");
	for (const word of ["skip", "s", "none", "-", "x", "Skip"]) assert.equal(parseTierAnswer(word, "dev"), "skip", word);
	assert.equal(parseTierAnswer("", "ppd"), "ppd");
	assert.equal(parseTierAnswer("test", "ppd"), undefined, "a profile name is no tier");
	assert.equal(parseTierAnswer("n", "ppd"), undefined, "n is not taken as skip");
});

test("isExecutable matches test -x: missing and non-executable files are false", (t) => {
	const dir = fs.mkdtempSync(join(os.tmpdir(), "wizard-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "prod-sql.sh");
	assert.equal(isExecutable(file), false, "missing");
	fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o644 });
	assert.equal(isExecutable(file), false, "not executable");
	fs.chmodSync(file, 0o755);
	assert.equal(isExecutable(file), true);
});
