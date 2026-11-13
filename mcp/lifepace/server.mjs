/**
 * lifepace MCP server (stdio), run by mcp/lifepace/guard.mjs behind the MCP
 * guard. It is the only way an omp session reaches the lifepace server: the
 * nono sandbox denies the ssh-agent socket, so the scripts below run here, on
 * the host, with the owner's ssh.
 *
 * Tools:
 *   plan_diag       copies one plan version into a case folder under
 *                   /tmp/lifepace-diag (deploy/plan-diag.sh); read-only.
 *   prod_sql        one SQL text as the read-only role diag
 *                   (deploy/prod-sql.sh); Postgres refuses any write.
 *   prod_sql_write  one SQL text as the database owner
 *                   (deploy/prod-sql.sh --write).
 *
 * The lifepace checkout is LIFEPACE_REPO, default ~/projects/lifepace; the
 * scripts read LIFEPACE_HOST and the other ssh settings of
 * deploy/server.sh from this process's environment.
 *
 * DEV-NOTE: see my-pi notes/specs/2026-11-13-lifepace-ops-mcp.md.
 */

import { execFile } from "node:child_process";
import os from "node:os";
import { join } from "node:path";

import { serveStdin } from "../guard/toolserver.mjs";

const SERVER_INFO = { name: "lifepace", version: "1" };
const RUN_TIMEOUT_MS = 120_000;
/** Most characters of a script's output returned to the agent. */
export const MAX_OUTPUT_CHARS = 100_000;
/** Most characters of one SQL text (deploy/prod-sql.sh refuses more bytes). */
export const MAX_QUERY_CHARS = 20_000;
/** A case name as deploy/plan-diag.sh accepts it. */
const CASE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const NOTE_CHARS = 500;

const QUERY_SCHEMA = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "SQL text, at most 20 000 characters, no backslash (write chr(92)); several statements run in one transaction. Answers come back as CSV.",
		},
	},
	required: ["query"],
	additionalProperties: false,
};

export const TOOLS = [
	{
		name: "plan_diag",
		description:
			"Copy one plan version of a lifepace subject (request, plan, decision trace, manifest) from the production server into /tmp/lifepace-diag/<case>/<time>-s<subject>-v<version>/ and print its weeks. Then read <dir>/manifest.json and run `go run . trace text --request <dir>/request.json --week N <dir>/trace.json` in the lifepace checkout.",
		inputSchema: {
			type: "object",
			properties: {
				subject: { type: "integer", minimum: 1, description: "lk.subjects.id; the owner's is 1" },
				case: { type: "string", description: "case folder: lower-case letters, digits and dashes, up to 48" },
				version: { type: "integer", minimum: 1, description: "lk.plan_versions.version; default the latest" },
				note: { type: "string", description: "free text kept in the manifest, up to 500 characters" },
			},
			required: ["subject", "case"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	{
		name: "prod_sql",
		description:
			"Run a read-only SQL query on the lifepace production database (role diag: reads every table, Postgres refuses any write, 30 s statement timeout). The owner is asked first, once or for the rest of this session.",
		inputSchema: QUERY_SCHEMA,
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	{
		name: "prod_sql_write",
		description:
			"Run SQL that writes on the lifepace production database as the database owner. The owner is asked for every call. Use prod_sql for reads.",
		inputSchema: QUERY_SCHEMA,
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
	},
];

/** Runs file with args and stdin text in cwd; resolves stdout, rejects with stderr (or the error message). */
export function runScript(file, args, { cwd, input, env }) {
	return new Promise((resolve, reject) => {
		const child = execFile(file, args, { cwd, env, timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(String(stderr).trim() || err.message));
			else resolve(String(stdout));
		});
		child.stdin.end(input ?? "");
	});
}

/** text cut to MAX_OUTPUT_CHARS, saying so where it was cut. */
export function capped(text) {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… cut at ${MAX_OUTPUT_CHARS} of ${text.length} characters; narrow the query.`;
}

/** The query argument, checked; throws with the reason. */
function queryOf(args) {
	const query = args?.query;
	if (typeof query !== "string" || query.trim() === "") throw new Error("query is a non-empty string");
	if (query.length > MAX_QUERY_CHARS) throw new Error(`query is longer than ${MAX_QUERY_CHARS} characters`);
	return query;
}

/** Tool handlers over run(file, args, { cwd, input, env }) → stdout, with the lifepace checkout at repo. */
export function createHandlers({ run = runScript, repo, env = process.env }) {
	const script = (name) => join(repo, "deploy", name);
	return {
		plan_diag: async (args = {}) => {
			const { subject, version, note } = args;
			if (!Number.isInteger(subject) || subject < 1) throw new Error("subject is a whole number from 1");
			if (typeof args.case !== "string" || !CASE.test(args.case)) throw new Error("case is lower-case letters, digits and dashes, up to 48");
			if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error("version is a whole number from 1");
			if (note !== undefined && (typeof note !== "string" || note.length > NOTE_CHARS)) throw new Error(`note is text of up to ${NOTE_CHARS} characters`);
			const argv = [String(subject), ...(version === undefined ? [] : [String(version)])];
			const out = await run(script("plan-diag.sh"), argv, { cwd: repo, env: { ...env, CASE: args.case, NOTE: note ?? "" } });
			return { output: capped(out) };
		},
		prod_sql: async (args) => ({ csv: capped(await run(script("prod-sql.sh"), [], { cwd: repo, input: queryOf(args), env })) }),
		prod_sql_write: async (args) => ({
			csv: capped(await run(script("prod-sql.sh"), ["--write"], { cwd: repo, input: queryOf(args), env })),
		}),
	};
}

function main() {
	const repo = process.env.LIFEPACE_REPO || join(os.homedir(), "projects/lifepace");
	serveStdin({ tools: TOOLS, handlers: createHandlers({ repo }), serverInfo: SERVER_INFO });
}

if (import.meta.main) main();
