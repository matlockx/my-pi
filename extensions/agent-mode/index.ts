/**
 * Agent Mode Extension
 *
 * Tracks "plan" vs "build" agent modes and auto-switches models
 * when toggling between them via /plan and /build prompt templates.
 *
 * AIDEV-NOTE: Model memory is per-mode. When you switch from build→plan,
 * the plan mode's last model is restored. When you switch back to build,
 * the build mode's model is restored. First activation uses defaults
 * from config files or hardcoded fallbacks.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// AIDEV-NOTE: Per-repo config files (.pi/plan-config.json, .pi/build-config.json)
// override hardcoded defaults. Format: { "model": "anthropic/claude-opus-4-0", "thinking": "high" }
function loadModeConfig(cwd: string, mode: AgentMode): ModeConfig | null {
	try {
		const configPath = join(cwd, ".pi", `${mode}-config.json`);
		const raw = readFileSync(configPath, "utf-8");
		return JSON.parse(raw) as ModeConfig;
	} catch {
		return null;
	}
}

// AIDEV-NOTE: Hardcoded defaults — used when no per-repo config exists.
// These search available models by substring match, so they work across
// provider naming variations.
const DEFAULT_MODEL_HINTS: Record<AgentMode, { hints: string[]; thinking: string }> = {
	plan: {
		hints: ["claude-opus-4", "opus-4", "o3", "deepseek-r1"],
		thinking: "high",
	},
	build: {
		hints: ["claude-sonnet-4", "sonnet-4", "gpt-4.1", "claude-3-5-sonnet"],
		thinking: "medium",
	},
};

// ── Model resolution ──────────────────────────────────────────────────

function parseModelSpec(spec: string): { provider?: string; modelId: string } {
	const parts = spec.split("/");
	if (parts.length >= 2) {
		return { provider: parts[0], modelId: parts.slice(1).join("/") };
	}
	return { modelId: spec };
}

function findModel(ctx: ExtensionContext, config: ModeConfig | null, mode: AgentMode) {
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) return null;

	// Try explicit config first
	if (config?.model) {
		const { provider, modelId } = parseModelSpec(config.model);
		if (provider) {
			const exact = ctx.modelRegistry.find(provider, modelId);
			if (exact) return exact;
		}
		// Fuzzy match on model id
		const match = available.find(
			(m) => m.id.includes(modelId) || m.name.toLowerCase().includes(modelId.toLowerCase()),
		);
		if (match) return match;
	}

	// Fall back to hints
	const { hints } = DEFAULT_MODEL_HINTS[mode];
	for (const hint of hints) {
		const match = available.find(
			(m) => m.id.includes(hint) || m.name.toLowerCase().includes(hint.toLowerCase()),
		);
		if (match) return match;
	}

	return null;
}

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

	// AIDEV-NOTE: When user manually switches model (via /model, Ctrl+P, leader-key),
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

	// AIDEV-NOTE: We intercept input events that start with /plan or /build.
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
					return { action: "continue" as const };
				}
			}
		}

		// No memory — find a default model for this mode
		const config = loadModeConfig(ctx.cwd, targetMode);
		const defaultModel = findModel(ctx, config, targetMode);

		if (defaultModel) {
			const ok = await pi.setModel(defaultModel);
			if (ok) {
				const thinkingLevel = config?.thinking ?? DEFAULT_MODEL_HINTS[targetMode].thinking;
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
		return { action: "continue" as const };
	});

	// ── Status display ────────────────────────────────────────────────

	// Show current mode in footer when active
	pi.on("session_start", async (_event, ctx) => {
		if (state.currentMode) {
			ctx.ui.setStatus("agent-mode", `mode: ${state.currentMode}`);
		}
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();
		if (text.startsWith("/plan") || text.startsWith("/build")) {
			const mode = text.startsWith("/plan") ? "plan" : "build";
			ctx.ui.setStatus("agent-mode", `mode: ${mode}`);
		}
	});
}
