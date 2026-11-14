/**
 * Facts about the agent a handler runs in, shared by the guardian and orchestrator extensions.
 * omp sets `ctx.agent` (`{ kind: "sub", id, name }` in a subagent session); pi does not, so a pi
 * session counts as the main agent.
 */

const MAIN = { kind: "main", id: "Main", name: "main" };

/** Kind, agent id and definition name of the session a handler context belongs to. */
export function agentOf(ctx) {
	const agent = ctx?.agent;
	if (!agent || typeof agent !== "object" || agent.kind !== "sub") return MAIN;
	return { kind: "sub", id: String(agent.id ?? "sub"), name: String(agent.name ?? "sub") };
}

/**
 * The object a `yield` call submitted as `data`: the object itself, or the same object passed as a
 * JSON string (models do both). Undefined for anything else.
 */
export function yieldObject(data) {
	let value = data;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
