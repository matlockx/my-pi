import test from "node:test";
import assert from "node:assert/strict";

import { classifyLifepace } from "./policy.mjs";
import { capped, createHandlers, MAX_OUTPUT_CHARS, MAX_QUERY_CHARS } from "./server.mjs";

/** Handlers over a fake runner that records each call and answers out. */
function fake(out = "a,b\n1,2\n") {
	const calls = [];
	const handlers = createHandlers({
		repo: "/repo",
		env: { HOME: "/h" },
		run: async (file, args, opts) => {
			calls.push({ file, args, ...opts });
			return out;
		},
	});
	return { handlers, calls };
}

test("prod_sql runs prod-sql.sh read-only with the query on stdin; prod_sql_write adds --write", async () => {
	const { handlers, calls } = fake();

	assert.deepEqual(await handlers.prod_sql({ query: "SELECT 1" }), { csv: "a,b\n1,2\n" });
	await handlers.prod_sql_write({ query: "UPDATE t SET a = 1" });

	assert.deepEqual(
		calls.map(({ file, args, input, cwd }) => ({ file, args, input, cwd })),
		[
			{ file: "/repo/deploy/prod-sql.sh", args: [], input: "SELECT 1", cwd: "/repo" },
			{ file: "/repo/deploy/prod-sql.sh", args: ["--write"], input: "UPDATE t SET a = 1", cwd: "/repo" },
		],
	);
});

test("prod_sql refuses an empty, missing or too long query without running anything", async () => {
	const { handlers, calls } = fake();

	await assert.rejects(handlers.prod_sql({ query: "  " }), /non-empty string/);
	await assert.rejects(handlers.prod_sql({}), /non-empty string/);
	await assert.rejects(handlers.prod_sql_write({ query: "x".repeat(MAX_QUERY_CHARS + 1) }), /longer than 20000/);
	assert.equal(calls.length, 0);
});

test("plan_diag passes subject and version as arguments and case and note in the environment", async () => {
	const { handlers, calls } = fake("plan-diag: done\n");

	assert.deepEqual(await handlers.plan_diag({ subject: 1, case: "calf-staging", version: 220, note: "why 50 km" }), {
		output: "plan-diag: done\n",
	});
	await handlers.plan_diag({ subject: 65, case: "x" });

	assert.deepEqual(calls[0].args, ["1", "220"]);
	assert.equal(calls[0].file, "/repo/deploy/plan-diag.sh");
	assert.deepEqual([calls[0].env.CASE, calls[0].env.NOTE, calls[0].env.HOME], ["calf-staging", "why 50 km", "/h"]);
	assert.deepEqual([calls[1].args, calls[1].env.NOTE], [["65"], ""]);
});

test("plan_diag refuses a bad subject, case, version or note without running anything", async () => {
	const { handlers, calls } = fake();

	for (const args of [
		{ subject: 0, case: "a" },
		{ subject: "1; id", case: "a" },
		{ subject: 1, case: "../etc" },
		{ subject: 1, case: "Upper" },
		{ subject: 1, case: "a", version: 1.5 },
		{ subject: 1, case: "a", note: "x".repeat(501) },
	]) {
		await assert.rejects(handlers.plan_diag(args), /is (a whole number|lower-case|text)/, JSON.stringify(args));
	}
	assert.equal(calls.length, 0);
});

test("capped keeps short output and says where it cut long output", () => {
	assert.equal(capped("short"), "short");
	const long = capped("x".repeat(MAX_OUTPUT_CHARS + 10));
	assert.match(long, /… cut at 100000 of 100010 characters; narrow the query\.$/);
	assert.equal(long.indexOf("…"), MAX_OUTPUT_CHARS + 1);
});

test("policy: plan_diag passes, prod_sql asks with a session offer, prod_sql_write asks without, others are refused", () => {
	assert.equal(classifyLifepace("lifepace", "plan_diag", { subject: 1, case: "a" }).decision, "allow");

	const read = classifyLifepace("lifepace", "prod_sql", { query: "SELECT 1" });
	assert.deepEqual([read.decision, read.session], ["confirm", true]);

	const write = classifyLifepace("lifepace", "prod_sql_write", { query: "UPDATE t SET a = 1" });
	assert.deepEqual([write.decision, write.session], ["confirm", undefined]);

	assert.equal(classifyLifepace("lifepace", "shell", {}).decision, "deny");
});

test("policy: a secret in a prod_sql query keeps the question per call", () => {
	const v = classifyLifepace("lifepace", "prod_sql", { query: `SELECT 'ghp_${"a1".repeat(18)}'` });

	assert.equal(v.decision, "confirm");
	assert.equal(v.session, false);
	assert.ok(v.reasons.length > 1, v.reasons.join("; "));
});
