/**
 * lean-footer — high-contrast, color-coded replacement for pi's built-in
 * footer stats line. Replaces the uniformly-dim line via ctx.ui.setFooter().
 *
 * Color families (truecolor ANSI, tuned for dark terminals):
 *   IN side  (blue/cyan family) — tokens that feed the model:
 *     ↑ input     bright cyan BOLD  — fresh, billable, stands out
 *     R cacheRead muted steel blue — cheap (~10% in), recedes
 *     W cacheWrite azure           — premium write (~1.25x in)
 *   OUT side (green family):
 *     ↓ output    bright green BOLD — priciest per-token, stands out
 *   Highlights:
 *     CH cache-hit teal
 *     $cost        gold BOLD — most important, biggest standout
 *     context %    green / amber / red by fill threshold
 *   Chrome (pwd, branch, model, statuses): dim gray
 *
 * Commands:
 *   /footer-colors            toggle on/off for this session
 *   /footer-colors default on|off   persist startup default
 *
 * Default persisted to ~/.pi/agent/lean-footer.json
 *
 * AIDEV-NOTE: pi's real footer lives in core dist/modes/interactive/
 * components/footer.js and dims everything uniformly. A theme can't split
 * in/out families because the footer hardcodes the dim wrap — so we override
 * the whole footer here instead. Field semantics mirror that file exactly:
 *   ↑ usage.input · ↓ usage.output · R usage.cacheRead · W usage.cacheWrite
 *   CH = cacheRead/(input+cacheRead+cacheWrite) of the LAST assistant msg.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "lean-footer.json");

function loadDefault(): boolean {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
			enabled?: boolean;
		};
		if (typeof raw.enabled === "boolean") return raw.enabled;
	} catch {
		// no config yet
	}
	return true;
}

function saveDefault(enabled: boolean): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ enabled }, null, 2), "utf8");
	} catch {
		// best-effort
	}
}

// --- truecolor helpers -----------------------------------------------------
const RESET = "\x1b[0m";
const c = (rgb: string, s: string, bold = false): string =>
	`\x1b[${bold ? "1;" : ""}38;2;${rgb}m${s}${RESET}`;

// Color families
const COL = {
	inFresh: "80;200;255", // ↑ input — fresh billable
	cacheR: "110;130;165", // R cacheRead — cheap, recede
	cacheW: "95;165;215", // W cacheWrite — premium
	out: "120;230;140", // ↓ output — priciest
	ch: "90;200;190", // CH cache-hit
	cost: "255;195;90", // $ cost — top standout
	ctxOk: "120;200;140",
	ctxWarn: "240;190;90",
	ctxCrit: "240;110;110",
	dim: "125;125;138", // chrome
};

const fmt = (n: number): string =>
	n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;

export default function leanFooter(pi: ExtensionAPI) {
	let enabled = loadDefault();

	// AIDEV-NOTE: rebuilds the footer with per-field color families. Layout/
	// padding computed on PLAIN strings, colors applied after, so ANSI never
	// corrupts width math or gets cut mid-escape.
	function install(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}
		ctx.ui.setFooter((tui, _theme, footerData) => {
			const unsub = footerData.onBranchChange?.(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let input = 0,
						output = 0,
						cacheRead = 0,
						cacheWrite = 0,
						cost = 0;
					let ch: number | undefined;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const u = (e.message as AssistantMessage).usage;
							input += u.input;
							output += u.output;
							cacheRead += u.cacheRead;
							cacheWrite += u.cacheWrite;
							cost += u.cost.total;
							const prompt = u.input + u.cacheRead + u.cacheWrite;
							ch = prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
						}
					}

					// stats parts: [plain, colored]
					const parts: Array<[string, string]> = [];
					if (input)
						parts.push([
							`↑${fmt(input)}`,
							c(COL.inFresh, `↑${fmt(input)}`, true),
						]);
					if (output)
						parts.push([
							`↓${fmt(output)}`,
							c(COL.out, `↓${fmt(output)}`, true),
						]);
					if (cacheRead)
						parts.push([
							`R${fmt(cacheRead)}`,
							c(COL.cacheR, `R${fmt(cacheRead)}`),
						]);
					if (cacheWrite)
						parts.push([
							`W${fmt(cacheWrite)}`,
							c(COL.cacheW, `W${fmt(cacheWrite)}`),
						]);
					if ((cacheRead > 0 || cacheWrite > 0) && ch !== undefined) {
						parts.push([
							`CH${ch.toFixed(1)}%`,
							c(COL.ch, `CH${ch.toFixed(1)}%`),
						]);
					}

					const usingSub = ctx.model
						? ctx.modelRegistry?.isUsingOAuth?.(ctx.model)
						: false;
					if (cost || usingSub) {
						const s = `$${cost.toFixed(3)}${usingSub ? " (sub)" : ""}`;
						parts.push([s, c(COL.cost, s, true)]);
					}

					// context fill
					const cu = ctx.getContextUsage?.();
					const win = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const pct = cu?.percent ?? 0;
					const pctStr = cu?.percent != null ? pct.toFixed(1) : "?";
					const auto = "";
					const ctxPlain =
						pctStr === "?"
							? `?/${fmt(win)}${auto}`
							: `${pctStr}%/${fmt(win)}${auto}`;
					const ctxColor =
						pct > 90 ? COL.ctxCrit : pct > 70 ? COL.ctxWarn : COL.ctxOk;
					parts.push([ctxPlain, c(ctxColor, ctxPlain, pct > 90)]);

					const leftPlain = parts.map((p) => p[0]).join(" ");
					const leftColored = parts.map((p) => p[1]).join(" ");

					// right: model • thinking
					const modelName = ctx.model?.id || "no-model";
					const rightPlain = modelName;
					const rightColored = c(COL.dim, rightPlain);

					const leftW = visibleWidth(leftPlain);
					const rightW = visibleWidth(rightPlain);
					let statsLine: string;
					if (leftW + 2 + rightW <= width) {
						const pad = " ".repeat(Math.max(2, width - leftW - rightW));
						statsLine = leftColored + pad + rightColored;
					} else {
						statsLine = leftColored;
					}

					// line 1: pwd (+branch +session)
					let pwd = formatCwd(ctx.sessionManager.getCwd());
					const branch = footerData.getGitBranch?.();
					if (branch) pwd = `${pwd} (${branch})`;
					const sname = ctx.sessionManager.getSessionName?.();
					if (sname) pwd = `${pwd} • ${sname}`;
					const pwdLine = truncateToWidth(
						c(COL.dim, pwd),
						width,
						c(COL.dim, "..."),
					);

					const lines = [pwdLine, statsLine];

					// line 3: extension statuses (caveman/lean/etc.) — keep dim chrome
					const statuses = footerData.getExtensionStatuses?.();
					if (statuses && statuses.size > 0) {
						const txt = Array.from(statuses.entries())
							.sort((a: [string, string], b: [string, string]) =>
								a[0].localeCompare(b[0]),
							)
							.map((e: [string, string]) => e[1])
							.join(" ");
						lines.push(truncateToWidth(txt, width, c(COL.dim, "...")));
					}
					return lines;
				},
			};
		});
	}

	function formatCwd(cwd: string): string {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		return home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
	}

	pi.on("session_start", async (_event, ctx) => {
		install(ctx);
	});

	pi.registerCommand("footer-colors", {
		description: "Toggle high-contrast colored footer (or: default on|off)",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim().split(/\s+/);
			if (a[0] === "default" && (a[1] === "on" || a[1] === "off")) {
				saveDefault(a[1] === "on");
				ctx.ui.notify(`lean-footer default: ${a[1]}`, "info");
				return;
			}
			enabled = !enabled;
			install(ctx);
			ctx.ui.notify(
				`Colored footer ${enabled ? "enabled" : "disabled"}`,
				"info",
			);
		},
	});
}
