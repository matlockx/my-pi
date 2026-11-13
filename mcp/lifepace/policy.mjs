/**
 * MCP guard policy for the lifepace server (mcp/lifepace/server.mjs): the
 * base checks of mcp/guard/policy.mjs (secrets and personal data in the
 * arguments) plus
 *   plan_diag       allowed (a fixed read-only script), logged;
 *   prod_sql        confirmed, and the user may allow it for the rest of the
 *                   client's session (session: true);
 *   prod_sql_write  confirmed on every call;
 *   any other tool  refused.
 *
 * DEV-NOTE: see my-pi notes/specs/2026-11-13-lifepace-ops-mcp.md (owner
 * decision 2026-11-13: every production query asks; "for this session",
 * never longer).
 */

import { classify } from "../guard/policy.mjs";

/** Classifies one tools/call of the lifepace server. */
export function classifyLifepace(server, tool, args, policy = {}) {
	const base = classify(server, tool, args, policy);
	switch (tool) {
		case "plan_diag":
			return base;
		case "prod_sql": {
			const reasons = ["query on the lifepace production database (read-only role diag)", ...base.reasons];
			// A secret or personal-data finding in the query keeps the question per call.
			return { decision: "confirm", reasons, allowlist: {}, session: base.reasons.length === 0 };
		}
		case "prod_sql_write":
			return { decision: "confirm", reasons: ["write on the lifepace production database as its owner", ...base.reasons], allowlist: {} };
		default:
			return { decision: "deny", reasons: [`unknown lifepace tool ${tool}`], allowlist: {} };
	}
}
