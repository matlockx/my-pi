/**
 * Token and cost totals for the lean-footer line, kept free of pi APIs so it is testable.
 */

/**
 * @typedef {{input: number, output: number, cacheRead: number, cacheWrite: number, cost: number}} Totals
 */

const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

/**
 * Usage recorded on one session entry: assistant and tool-result messages, side requests
 * (`model_usage`, e.g. job captions), and summaries (`compaction`, `branch_summary`).
 *
 * @param {any} entry A session entry.
 * @returns {any} The entry's `Usage`, or undefined when it carries none.
 */
function usageOf(entry) {
	if (entry.type === "message") return entry.message?.role === "user" ? undefined : entry.message?.usage;
	return entry.usage;
}

/**
 * Sums the usage of a session, and separately of the part after the last handoff.
 *
 * A handoff (`/handoff`) compacts the session in place, so the session keeps its id and its
 * running totals; `sinceHandoff` restarts at each handoff. The handoff entry's own usage (the
 * request that wrote the handoff document) belongs to the part before it.
 *
 * @param {any[]} entries Session entries in file order, from `sessionManager.getEntries()`.
 * @returns {{session: Totals, sinceHandoff: Totals, handoffs: number, cacheHit: number | undefined}}
 *   `cacheHit` is the cache-read share in percent of the last assistant request's prompt.
 */
export function usageTotals(entries) {
	const session = empty();
	let sinceHandoff = empty();
	let handoffs = 0;
	let cacheHit;
	for (const entry of entries) {
		const usage = usageOf(entry);
		if (usage) {
			for (const totals of [session, sinceHandoff]) {
				totals.input += usage.input ?? 0;
				totals.output += usage.output ?? 0;
				totals.cacheRead += usage.cacheRead ?? 0;
				totals.cacheWrite += usage.cacheWrite ?? 0;
				totals.cost += usage.cost?.total ?? 0;
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
				cacheHit = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
			}
		}
		if (entry.type === "compaction" && entry.method === "handoff") {
			handoffs += 1;
			sinceHandoff = empty();
		}
	}
	return { session, sinceHandoff, handoffs, cacheHit };
}
