/**
 * secret-redactor — detect and redact secrets before context leaves the machine.
 *
 * Two layers:
 *  1. Ingestion (destructive): tool_result / input / user_bash scrub secrets
 *     BEFORE they enter stored context, so the compaction/branch summarizer —
 *     which bypasses the egress hooks — can never read a raw secret. Ingestion
 *     unions the in-process regex with gitleaks (when the binary is present).
 *  2. Egress net: before_provider_request deep-scrubs the full outgoing payload
 *     (messages + system prompt) on normal turns. Regex-only (no subprocess on
 *     the per-turn hot path).
 *
 * Toggle per session with /redact-secrets. Default: on. State resets to on for
 * every new/resumed session (module re-binds), matching "default on".
 *
 * Each secret value gets its own placeholder (`[REDACTED:rule#id]`), kept in an
 * in-memory vault for the session. A tool call carrying a placeholder asks the
 * user first: write the plain values, write the placeholders, or block.
 *
 * DEV-NOTE: detection rules live in patterns.ts; pure redaction in redact.ts.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkToolCall } from "./fileguard.ts";
import { scanSecrets } from "./gitleaks.ts";
import {
	collectStrings,
	placeholdersIn,
	redactDeep,
	redactDeepWith,
	redactStringWith,
	restoreDeep,
	type Vault,
} from "./redact.ts";

// Audit log. METADATA ONLY — never the secret value, or we relocate the leak to disk.
// Env override keeps tests off the real log.
const LOG_PATH =
	process.env.PI_SECRET_REDACTOR_LOG ??
	join(homedir(), ".pi", "agent", "secret-redactor.log");

function logHit(
	sessionId: string | undefined,
	where: string,
	count: number,
	rules: string[],
) {
	try {
		appendFileSync(
			LOG_PATH,
			`${JSON.stringify({ ts: new Date().toISOString(), session: sessionId, where, count, rules: [...new Set(rules)] })}\n`,
		);
	} catch {
		// logging must never break redaction
	}
}

const WRITE_PLAIN = "Write the plain secret values";
const WRITE_PLACEHOLDERS = "Write the placeholder text as-is";
const BLOCK = "Block the tool call";

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let totalRedacted = 0;
	const loggedEgress = new Set<string>(); // dedupe repeated egress-net hits (same context secret every turn)
	const vault: Vault = new Map(); // secret value -> placeholder; memory only

	const setStatus = (ctx: {
		ui: { setStatus: (id: string, text: string) => void };
	}) => {
		ctx.ui.setStatus(
			"secret-redactor",
			enabled
				? `secrets: on${totalRedacted ? ` (${totalRedacted} redacted)` : ""}`
				: "secrets: OFF",
		);
	};

	// biome-ignore lint/suspicious/noExplicitAny: ctx UI shape is stable across hooks
	const notify = (ctx: any, count: number, where: string, rules: string[]) => {
		if (count <= 0) return;
		totalRedacted += count;
		const uniq = [...new Set(rules)].join(", ");
		ctx.ui.notify(
			`Redacted ${count} secret${count > 1 ? "s" : ""} in ${where} (${uniq})`,
			"warning",
		);
		logHit(ctx.sessionManager?.getSessionId?.(), where, count, rules);
		setStatus(ctx);
	};

	pi.on("session_start", async (_e, ctx) => setStatus(ctx));

	// --- Egress net: full outgoing payload (messages + system prompt) ---
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled) return;
		const r = redactDeep(event.payload, vault);
		if (r.count > 0) {
			totalRedacted += r.count;
			// Egress net fires every turn on the same secret; log only when it catches
			// something ingestion missed (system prompt / context files, e.g. AGENTS.md),
			// and only once per distinct rule-set per session to avoid per-turn spam.
			const sig = [...new Set(r.rules)].sort().join(",");
			if (!loggedEgress.has(sig)) {
				loggedEgress.add(sig);
				logHit(
					ctx.sessionManager?.getSessionId?.(),
					"egress-net (system prompt / context)",
					r.count,
					r.rules,
				);
			}
			setStatus(ctx);
			return r.value;
		}
		return undefined;
	});

	// --- Wall: block reads of secret-bearing files outright (.env, *.tfvars, keys) ---
	// --- Gate: ask before a placeholder lands in a file or command as literal text ---
	// Both run even when redaction is toggled off: a wall is not a net. The agent
	// only sees placeholders, so copying context text into a write (edit, write,
	// bash heredoc) would replace the secret with its placeholder.
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const reason = checkToolCall(event.toolName, input);
		if (reason) return { block: true, reason };

		const found = placeholdersIn(input);
		if (found.length === 0) return undefined;
		const known = new Set(vault.values());
		const unknown = found.filter((p) => !known.has(p));
		const declined =
			`Blocked: the input carries redacted placeholders (${found.join(", ")}). ` +
			"Each stands for a secret value hidden from you; it would land as literal text. " +
			"Ask the user how to proceed, or use an obvious dummy value instead.";
		if (!ctx.hasUI) return { block: true, reason: declined };

		// Plain is offered only when every placeholder can be restored: a partial
		// restore would still write placeholder text under the "plain" label.
		const choice = await ctx.ui.select(
			`${event.toolName} input contains redacted secrets: ${found.join(", ")}` +
				(unknown.length
					? `. Value unknown for ${unknown.join(", ")} (not redacted in this session).`
					: ""),
			unknown.length ? [WRITE_PLACEHOLDERS, BLOCK] : [WRITE_PLAIN, WRITE_PLACEHOLDERS, BLOCK],
		);
		if (choice === WRITE_PLACEHOLDERS) return undefined;
		if (choice !== WRITE_PLAIN) return { block: true, reason: declined };

		const restored = restoreDeep(input, vault) as Record<string, unknown>;
		// pi reads the mutated event.input; omp reads the returned input.
		Object.assign(input, restored);
		logHit(
			ctx.sessionManager?.getSessionId?.(),
			`restored into ${event.toolName} input`,
			found.length,
			found.map((p) => p.slice("[REDACTED:".length).split(/[#\]]/)[0]),
		);
		ctx.ui.notify(
			`Restored ${found.length} plain secret value${found.length > 1 ? "s" : ""} into ${event.toolName} input`,
			"warning",
		);
		return { input: restored };
	});

	// --- Ingestion: tool output (bash/read/grep/...) — the `cat .env` vector ---
	// Union: in-process regex + gitleaks (graceful fallback when binary absent).
	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		const hits = await scanSecrets(collectStrings(event.content).join("\n"));
		const r = redactDeepWith(event.content, hits, vault);
		if (r.count > 0) {
			notify(ctx, r.count, `${event.toolName} result`, r.rules);
			return { content: r.value as typeof event.content };
		}
		return undefined;
	});

	// --- Ingestion: user-typed / pasted input ---
	pi.on("input", async (event, ctx) => {
		if (!enabled || event.source === "extension") return { action: "continue" };
		const hits = await scanSecrets(event.text);
		const r = redactStringWith(event.text, hits, vault);
		if (r.count > 0) {
			notify(ctx, r.count, "your input", r.rules);
			return { action: "transform", text: r.text };
		}
		return { action: "continue" };
	});

	// --- Ingestion: `!` user bash output added to context ---
	pi.on("user_bash", (event, ctx) => {
		if (!enabled) return;
		return {
			operations: {
				async exec(command: string, cwd: string, options: unknown) {
					// Dynamic import so this file loads standalone (tests) without the pi package.
					const { createLocalBashOperations } = await import(
						"@earendil-works/pi-coding-agent"
					);
					const local = createLocalBashOperations();
					// biome-ignore lint/suspicious/noExplicitAny: passthrough to built-in backend
					const result: any = await (local.exec as any)(command, cwd, options);
					if (typeof result?.output === "string") {
						const hits = await scanSecrets(result.output);
						const r = redactStringWith(result.output, hits, vault);
						if (r.count > 0) {
							notify(ctx, r.count, "shell output", r.rules);
							return { ...result, output: r.text };
						}
					}
					return result;
				},
			},
		};
	});

	// --- Toggle ---
	pi.registerCommand("redact-secrets", {
		description: "Toggle secret redaction for this session (default: on)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else enabled = !enabled;
			setStatus(ctx);
			ctx.ui.notify(
				`Secret redaction ${enabled ? "enabled" : "DISABLED"} for this session`,
				enabled ? "info" : "warning",
			);
		},
	});
}
