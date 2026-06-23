/**
 * lean-output — reduce assistant OUTPUT tokens without quality loss.
 *
 * Mechanism: append output-style directives to the system prompt via
 * `before_agent_start`. Shrinks final-answer prose (preamble, narration,
 * unrequested justification, full-file dumps) while leaving reasoning,
 * correctness caveats, errors, and clarifying questions intact.
 *
 * Modes:
 *   off        — no injection
 *   lite       — drop fluff/preamble/narration, keep normal structure
 *   aggressive — diffs-only, near-zero narration, terse by default
 *
 * Commands:
 *   /lean              show status
 *   /lean off|lite|aggressive   set mode for this session
 *   /lean default <mode>        persist the startup default (global)
 *   /lean reset                 reset measured stats
 *
 * Default state is persisted to ~/.pi/agent/lean-output.json
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "off" | "lite" | "aggressive";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "lean-output.json");

interface Persisted {
	defaultMode: Mode;
}

function loadDefault(): Mode {
	try {
		const raw = JSON.parse(
			readFileSync(CONFIG_PATH, "utf8"),
		) as Partial<Persisted>;
		if (
			raw.defaultMode === "off" ||
			raw.defaultMode === "lite" ||
			raw.defaultMode === "aggressive"
		) {
			return raw.defaultMode;
		}
	} catch {
		// no config yet — fall through to default
	}
	return "aggressive";
}

function saveDefault(mode: Mode): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(
			CONFIG_PATH,
			JSON.stringify({ defaultMode: mode } satisfies Persisted, null, 2),
			"utf8",
		);
	} catch {
		// non-fatal: persistence best-effort
	}
}

// DEV-NOTE: lean-output rules — the high-leverage payload. Tuned to cut
// OUTPUT prose, never reasoning/correctness. Edit here to retune behavior.
const SHARED_GUARDRAILS = `
Never sacrifice correctness for brevity. The following ALWAYS keep full detail:
- Security warnings, destructive/irreversible operations, data-loss risks.
- Error messages: quote verbatim, do not paraphrase.
- Caveats or edge cases that change whether the answer is correct.
- Clarifying questions when the request is ambiguous — ask, do not guess.
- Plans, specs, and deliverable documents (.md/README/PR/commit bodies): write normal prose.
Brevity applies to chat answers, not to deliverable documents.`;

const LITE_RULES = `
## Output Style: LEAN (lite)

Reduce output tokens. Reasoning depth unchanged; only trim the prose you emit:
- Lead with the answer/result. No preamble ("Here's what I found", "Sure, I can help").
- No postamble ("Let me know if...", "Hope this helps").
- Do not narrate routine steps before doing them. Report results, not intentions.
- Do not re-explain code you just wrote unless asked.
- Do not restate the question or summarize what you just did.
- Justify decisions only when non-obvious, risky, or requested.
- Prefer lists/tables over paragraphs when they compress.
${SHARED_GUARDRAILS}`;

const AGGRESSIVE_RULES = `
## Output Style: LEAN (aggressive)

Minimize output tokens hard. Reasoning depth unchanged; emit only essential prose:
- Answer first, in the fewest words that stay correct and unambiguous.
- Zero preamble, zero postamble, zero pleasantries, zero self-narration.
- Show CHANGES as diffs/hunks with path:line refs — never reprint whole files
  or large unchanged regions. Quote only the lines that matter.
- After edits, state what changed in one line; do not re-explain the code.
- No progress updates for routine multi-step work; act, then report outcome.
- Never justify decisions unless asked or correctness/safety depends on it.
- No restating the request, no recap of completed steps.
- Prefer terse lists/tables over prose. Fragments are fine.
${SHARED_GUARDRAILS}`;

function rulesFor(mode: Mode): string | null {
	if (mode === "lite") return LITE_RULES;
	if (mode === "aggressive") return AGGRESSIVE_RULES;
	return null;
}

export default function leanOutput(pi: ExtensionAPI) {
	let mode: Mode = loadDefault();

	// Rolling output-token measurement, per mode, to prove savings in /lean status.
	const stats: Record<Mode, { turns: number; tokens: number }> = {
		off: { turns: 0, tokens: 0 },
		lite: { turns: 0, tokens: 0 },
		aggressive: { turns: 0, tokens: 0 },
	};

	const label = (m: Mode) => (m === "off" ? "off" : `lean:${m}`);

	function refreshFooter(ctx: {
		ui: { setStatus: (k: string, v?: string) => void };
	}) {
		ctx.ui.setStatus("lean", mode === "off" ? undefined : `${label(mode)} ✓`);
	}

	function avg(m: Mode): string {
		const s = stats[m];
		return s.turns ? Math.round(s.tokens / s.turns).toString() : "—";
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshFooter(ctx);
	});

	// Skip lean injection when the turn is about planning — plans need full
	// reasoning/prose, not compressed output.
	const PLAN_RE = /\bplan(s|ning|ned)?\b/i;

	pi.on("before_agent_start", async (event) => {
		const rules = rulesFor(mode);
		if (!rules) return;
		if (PLAN_RE.test(event.prompt)) return; // planning turn → keep rich output
		return { systemPrompt: `${event.systemPrompt}\n\n${rules}` };
	});

	// Measure realized output tokens per active mode.
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const out = (event.message as { usage?: { output?: number } }).usage
			?.output;
		if (typeof out === "number" && out > 0) {
			stats[mode].turns += 1;
			stats[mode].tokens += out;
		}
	});

	pi.registerCommand("lean", {
		description: "Control lean-output mode (off|lite|aggressive|default|reset)",
		getArgumentCompletions: (prefix) => {
			const opts = ["off", "lite", "aggressive", "default", "reset", "status"];
			const filtered = opts.filter((o) => o.startsWith(prefix));
			return filtered.length
				? filtered.map((v) => ({ value: v, label: v }))
				: null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0] ?? "status";

			const showStatus = () => {
				const lines = [
					`lean-output: ${label(mode)}  (default: ${loadDefault()})`,
					`avg output tok/turn — aggressive: ${avg("aggressive")}  lite: ${avg("lite")}  off: ${avg("off")}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
			};

			if (cmd === "status") {
				showStatus();
				return;
			}
			if (cmd === "off" || cmd === "lite" || cmd === "aggressive") {
				mode = cmd;
				refreshFooter(ctx);
				ctx.ui.notify(`lean-output → ${label(mode)}`, "info");
				return;
			}
			if (cmd === "default") {
				const m = parts[1];
				if (m === "off" || m === "lite" || m === "aggressive") {
					saveDefault(m);
					ctx.ui.notify(`lean-output default → ${m} (persisted)`, "info");
				} else {
					ctx.ui.notify(`usage: /lean default off|lite|aggressive`, "warning");
				}
				return;
			}
			if (cmd === "reset") {
				for (const k of Object.keys(stats) as Mode[])
					stats[k] = { turns: 0, tokens: 0 };
				ctx.ui.notify("lean-output stats reset", "info");
				return;
			}
			ctx.ui.notify(
				`unknown: /lean ${cmd}\nuse: off | lite | aggressive | default <mode> | reset | status`,
				"warning",
			);
		},
	});
}
