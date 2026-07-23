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
 * DEV-NOTE: detection rules live in patterns.ts; pure redaction in redact.ts.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanSecrets } from "./gitleaks.ts";
import {
	collectStrings,
	redactDeep,
	redactDeepWith,
	redactStringWith,
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

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let totalRedacted = 0;
	const loggedEgress = new Set<string>(); // dedupe repeated egress-net hits (same context secret every turn)

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
		const r = redactDeep(event.payload);
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

	// --- Ingestion: tool output (bash/read/grep/...) — the `cat .env` vector ---
	// Union: in-process regex + gitleaks (graceful fallback when binary absent).
	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		const hits = await scanSecrets(collectStrings(event.content).join("\n"));
		const r = redactDeepWith(event.content, hits);
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
		const r = redactStringWith(event.text, hits);
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
						const r = redactStringWith(result.output, hits);
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
