/**
 * Meter of one agent session: API-equivalent cost, waste signals and the loop breaker.
 *
 * Costs are `usage.cost.total` of each assistant message, as reported by the provider through
 * omp. The loop breaker counts tool calls identical in name, arguments and result: a call whose
 * result changed (a re-read after an edit) starts a new count.
 */

import { createHash } from "node:crypto";

export const LOOP_NOTE_AT = 3;
export const LOOP_BLOCK_AT = 5;
/** Tools whose repetition is expected (polling, bookkeeping, user dialogs). */
export const LOOP_EXEMPT = new Set(["wait", "todo", "ask"]);
const EDIT_TOOLS = new Set(["edit", "ast_edit", "write"]);
// Lines that differ between otherwise identical bash results.
const VOLATILE_LINE = /^(Wall time: .*|Backgrounded as job .*)$/gm;
const READ_REPEAT_AT = 3;

/** A fresh meter. */
export function newMeter() {
	return {
		costUsd: 0,
		requests: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		waste: { repeatedReads: 0, repeatedCommands: 0, failedTools: 0, editRetries: 0, waitMs: 0 },
		loopBreaks: [],
		reads: new Map(),
		commands: new Map(),
		calls: new Map(),
		started: new Map(),
	};
}

function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function digest(text) {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Key of a tool call: tool name plus its arguments, independent of key order. */
export function callKey(toolName, input) {
	return digest(`${toolName}\u001f${stable(input ?? {})}`);
}

/** Fingerprint of a tool result, ignoring wall-time lines. */
export function resultKey(content, isError) {
	const text = (content ?? [])
		.map((block) => (block?.type === "text" ? block.text : stable(block)))
		.join("\n")
		.replace(VOLATILE_LINE, "");
	return digest(`${isError ? "error" : "ok"}\u001f${text}`);
}

/** Adds an assistant message's usage; other roles are ignored. */
export function onMessage(meter, message) {
	if (message?.role !== "assistant" || !message.usage) return;
	const usage = message.usage;
	meter.requests += 1;
	meter.costUsd += Number(usage.cost?.total) || 0;
	for (const kind of Object.keys(meter.tokens)) meter.tokens[kind] += Number(usage[kind]) || 0;
}

/**
 * Called before a tool runs. Returns `{ block, reason }` when the same call already returned the
 * same result LOOP_BLOCK_AT - 1 times in a row, otherwise undefined.
 */
export function onToolCall(meter, { toolCallId, toolName, input }, now) {
	if (LOOP_EXEMPT.has(toolName)) {
		meter.started.set(toolCallId, now);
		return undefined;
	}
	const key = callKey(toolName, input);
	const seen = meter.calls.get(key);
	if (!seen || seen.count < LOOP_BLOCK_AT - 1) {
		meter.started.set(toolCallId, now);
		return undefined;
	}
	if (!seen.broken) {
		seen.broken = true;
		meter.loopBreaks.push({ level: "agent", tool: toolName, reason: "identical call and result", count: seen.count, at: now });
	}
	return {
		block: true,
		reason:
			`Blocked by the guardian loop breaker: this ${toolName} call returned the same result ${seen.count} times in a row. ` +
			"Repeating it will not change the outcome. Change the approach, or stop and report what is blocking you.",
	};
}

function countRepeat(map, key) {
	const n = (map.get(key) ?? 0) + 1;
	map.set(key, n);
	return n;
}

function recordWaste(meter, { toolName, input, isError }, elapsed) {
	if (isError) {
		meter.waste.failedTools += 1;
		if (EDIT_TOOLS.has(toolName)) meter.waste.editRetries += 1;
		return;
	}
	if (toolName === "read" && countRepeat(meter.reads, String(input?.path)) >= READ_REPEAT_AT) meter.waste.repeatedReads += 1;
	if (toolName === "bash" && countRepeat(meter.commands, String(input?.command)) >= 2) meter.waste.repeatedCommands += 1;
	if (toolName === "wait") meter.waste.waitMs += elapsed;
}

/**
 * Called after a tool ran. Updates waste signals and the loop count; returns a note for the agent
 * from the LOOP_NOTE_AT-th identical call and result on, otherwise undefined.
 */
export function onToolResult(meter, event, now) {
	const started = meter.started.get(event.toolCallId);
	meter.started.delete(event.toolCallId);
	recordWaste(meter, event, started === undefined ? 0 : now - started);
	if (LOOP_EXEMPT.has(event.toolName)) return undefined;

	const key = callKey(event.toolName, event.input);
	const result = resultKey(event.content, event.isError);
	const seen = meter.calls.get(key);
	const count = seen?.result === result ? seen.count + 1 : 1;
	meter.calls.set(key, { result, count, broken: false });
	if (count < LOOP_NOTE_AT) return undefined;
	return (
		`Guardian: this ${event.toolName} call returned the same result ${count} times in a row. ` +
		`It will be blocked at ${LOOP_BLOCK_AT}. Use the result you have or change the approach.`
	);
}

/** Plain, serialisable figures of a meter. */
export function snapshot(meter) {
	return {
		costUsd: Math.round(meter.costUsd * 1e6) / 1e6,
		requests: meter.requests,
		tokens: { ...meter.tokens },
		waste: { ...meter.waste },
		loopBreaks: meter.loopBreaks.map((b) => ({ ...b })),
	};
}

/** Sums snapshots: costs, requests, tokens and waste add up, loop breaks concatenate. */
export function sumSnapshots(snapshots) {
	const total = snapshot(newMeter());
	for (const s of snapshots) {
		total.costUsd += s.costUsd;
		total.requests += s.requests;
		for (const k of Object.keys(total.tokens)) total.tokens[k] += s.tokens[k];
		for (const k of Object.keys(total.waste)) total.waste[k] += s.waste[k];
		total.loopBreaks.push(...s.loopBreaks);
	}
	total.costUsd = Math.round(total.costUsd * 1e6) / 1e6;
	return total;
}
