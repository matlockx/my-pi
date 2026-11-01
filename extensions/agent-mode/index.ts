/**
 * Agent Mode Extension
 *
 * Tracks "plan" vs "build" agent modes and auto-switches models
 * when toggling between them via /plan and /build prompt templates.
 *
 * DEV-NOTE: Model memory is per-mode. When you switch from build→plan,
 * the plan mode's last model is restored. When you switch back to build,
 * the build mode's model is restored. First activation uses the per-repo
 * config file, else the newest model of the mode's family.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickModel } from "./models.mjs";

// ── Types ─────────────────────────────────────────────────────────────

type AgentMode = "plan" | "build";

interface ModeModelMemory {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}

interface ModeState {
	currentMode: AgentMode | null;
	models: Partial<Record<AgentMode, ModeModelMemory>>;
}

interface ModeConfig {
	model?: string; // "provider/model-id" or just "model-id"
	thinking?: string;
}

// ── Config loading ────────────────────────────────────────────────────

// DEV-NOTE: Per-repo config files (.pi/plan-config.json, .pi/build-config.json)
// override the family defaults. Format: { "model": "anthropic/claude-opus-5-5", "thinking": "high" }
function loadModeConfig(cwd: string, mode: AgentMode): ModeConfig | null {
	try {
		const configPath = join(cwd, ".pi", `${mode}-config.json`);
		const raw = readFileSync(configPath, "utf-8");
		return JSON.parse(raw) as ModeConfig;
	} catch {
		return null;
	}
}

// DEV-NOTE: Defaults when no per-repo config exists: the newest model of a family,
// so new releases are picked up without edits. Fixed id prefixes ("claude-opus-4")
// went stale and matched the oldest model of the line first (found 2026-11-01:
// /plan switched an Opus 5.5 session to claude-opus-4-0).
const MODE_DEFAULTS: Record<AgentMode, { family: string; thinking: string }> = {
	plan: { family: "opus", thinking: "high" },
	build: { family: "sonnet", thinking: "medium" },
};

// ── Extension ─────────────────────────────────────────────────────────

export default function agentModeExtension(pi: ExtensionAPI) {
	const state: ModeState = {
		currentMode: null,
		models: {},
	};

	// ── Session persistence ───────────────────────────────────────────

	// Restore state from session entries on start/reload
	pi.on("session_start", async (_event, ctx) => {
		state.currentMode = null;
		state.models = {};

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && (entry as any).customType === "agent-mode") {
				const data = (entry as any).data as ModeState;
				if (data) {
					state.currentMode = data.currentMode;
					state.models = data.models ?? {};
				}
			}
		}
	});

	function persistState() {
		pi.appendEntry("agent-mode", { ...state });
	}

	// ── Remember model changes while in a mode ────────────────────────

	// DEV-NOTE: When user manually switches model (via /model, Ctrl+P, leader-key),
	// we update the memory for the current mode so it's restored on next switch.
	pi.on("model_select", async (event, ctx) => {
		if (!state.currentMode) return;
		if (event.source === "restore") return; // Don't overwrite on session restore

		state.models[state.currentMode] = {
			provider: event.model.provider,
			modelId: event.model.id,
			thinkingLevel: pi.getThinkingLevel(),
		};
		persistState();
	});

	// Track thinking level changes too
	pi.on("thinking_level_select", async (event, _ctx) => {
		if (!state.currentMode) return;
		const mem = state.models[state.currentMode];
		if (mem) {
			mem.thinkingLevel = event.level;
			persistState();
		}
	});

	// ── Mode switching on /plan and /build ─────────────────────────────

	// DEV-NOTE: We intercept input events that start with /plan or /build.
	// We DON'T block the input — we let it pass through to prompt template
	// expansion. We just handle the model switch as a side effect.
	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();

		let targetMode: AgentMode | null = null;
		if (text.startsWith("/plan")) targetMode = "plan";
		else if (text.startsWith("/build")) targetMode = "build";

		if (!targetMode) return;

		const previousMode = state.currentMode;

		// Save current model for the mode we're leaving
		if (previousMode && previousMode !== targetMode && ctx.model) {
			state.models[previousMode] = {
				provider: ctx.model.provider,
				modelId: ctx.model.id,
				thinkingLevel: pi.getThinkingLevel(),
			};
		}

		state.currentMode = targetMode;

		// Try to restore remembered model for target mode
		const remembered = state.models[targetMode];
		if (remembered) {
			const model = ctx.modelRegistry.find(remembered.provider, remembered.modelId);
			if (model) {
				const ok = await pi.setModel(model);
				if (ok) {
					if (remembered.thinkingLevel) {
						pi.setThinkingLevel(remembered.thinkingLevel as any);
					}
					ctx.ui.notify(
						`${targetMode} mode → ${model.name} (thinking: ${remembered.thinkingLevel ?? pi.getThinkingLevel()})`,
						"info",
					);
					persistState();
					updateModeUI(ctx, targetMode);
					return { action: "continue" as const };
				}
			}
		}

		// No memory — find a default model for this mode
		const config = loadModeConfig(ctx.cwd, targetMode);
		// DEV-NOTE: find() searches the whole registry so a configured model without credentials
		// is still chosen and reported as "no API key" below instead of silently replaced.
		const defaultModel = pickModel(
			{ available: ctx.modelRegistry.getAvailable(), find: (p: string, id: string) => ctx.modelRegistry.find(p, id) },
			config?.model,
			MODE_DEFAULTS[targetMode].family,
			ctx.model?.provider,
		);

		if (defaultModel) {
			const ok = await pi.setModel(defaultModel);
			if (ok) {
				const thinkingLevel = config?.thinking ?? MODE_DEFAULTS[targetMode].thinking;
				pi.setThinkingLevel(thinkingLevel as any);

				state.models[targetMode] = {
					provider: defaultModel.provider,
					modelId: defaultModel.id,
					thinkingLevel,
				};

				ctx.ui.notify(
					`${targetMode} mode → ${defaultModel.name} (thinking: ${thinkingLevel})`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`${targetMode} mode — no API key for ${defaultModel.name}`,
					"warning",
				);
			}
		} else {
			ctx.ui.notify(
				`${targetMode} mode — no matching model found, keeping current`,
				"warning",
			);
		}

		persistState();
		updateModeUI(ctx, targetMode);
		return { action: "continue" as const };
	});

	// ── TUI indicators ────────────────────────────────────────────────

	// DEV-NOTE: Orange (ANSI 208) for plan, Blue (ANSI 33) for build — matches OpenCode.
	const MODE_COLORS: Record<AgentMode, number> = { plan: 208, build: 33 };
	const MODE_ICONS: Record<AgentMode, string> = { plan: "🧠", build: "⚡" };
	const ansi = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;

	function updateModeUI(ctx: ExtensionContext, mode: AgentMode | null) {
		if (!mode) {
			ctx.ui.setStatus("agent-mode", undefined);
			ctx.ui.setWidget("agent-mode", undefined);
			return;
		}

		const color = MODE_COLORS[mode];
		const icon = MODE_ICONS[mode];
		const mem = state.models[mode];
		const modelName = mem ? mem.modelId : "default";
		const thinking = mem?.thinkingLevel ?? "";

		// Footer status
		ctx.ui.setStatus("agent-mode", ansi(color, `${icon} ${mode}`));

		// Widget above editor
		const label = ansi(color, `${icon} ${mode.toUpperCase()}`);
		const detail = `\x1b[38;5;245m${modelName}${thinking ? " · thinking: " + thinking : ""}\x1b[0m`;
		ctx.ui.setWidget("agent-mode", [`${label}  ${detail}`]);
	}

	// Restore UI on session start
	pi.on("session_start", async (_event, ctx) => {
		// Runs after state restoration (earlier handler)
		setTimeout(() => updateModeUI(ctx, state.currentMode), 0);
	});
}
