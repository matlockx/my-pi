/**
 * Auto Quick-Review Extension
 *
 * DEV-NOTE: Runs the /quick-review prompt automatically when the agent loop ends
 * with uncommitted changes in the working tree — the point at which the agent
 * would normally propose a commit message. An extension enforces this where an
 * AGENTS.md instruction can be skipped.
 *
 * The prompt body is read from prompts/quick-review.md, so the manual command and
 * the automatic trigger share one source of truth.
 *
 * Opt out for the current session with /quick-review-auto off.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
	lastAssistantText,
	parseFindings,
	parseVerdict,
	promptBody,
	shouldAutoReview,
} from "./gate.mjs";

const RESET = "\x1b[0m";
const colour = (rgb: string, s: string, bold = false) =>
	`\x1b[${bold ? "1;" : ""}38;2;${rgb}m${s}${RESET}`;

const VERDICT_COLOUR: Record<string, string> = {
	PASS: "126;211;33",
	CONCERNS: "240;173;78",
	FAIL: "229;79;79",
};
const SEVERITY_COLOUR: Record<string, string> = {
	HIGH: "229;79;79",
	MED: "240;173;78",
	LOW: "130;150;170",
};
const DIM = "130;150;170";
const WIDGET_KEY = "quick-review";
const MAX_WIDGET_FINDINGS = 6;

const FOLLOW_UP_PROMPT =
	"Address the quick-review findings above. Fix the HIGH and MED items first, " +
	"skip anything you judge a false positive and say why in one line, and add or " +
	"update the tests the findings call for. Do not commit.";

const PROMPT_PATH = fileURLToPath(
	new URL("../../prompts/quick-review.md", import.meta.url),
);

export default function (pi: ExtensionAPI) {
	const reviewed = new Set<string>();
	let count = 0;
	let disabled = false;
	let running = false;

	/** Fingerprints the uncommitted changes; returns "" for a clean tree or a non-git directory. */
	async function diffFingerprint(cwd: string): Promise<string> {
		const status = await pi.exec("git", ["status", "--porcelain"], { cwd });
		if (status.code !== 0 || !status.stdout.trim()) return "";

		const diff = await pi.exec("git", ["diff", "HEAD"], { cwd });
		return createHash("sha1")
			.update(status.stdout)
			.update(diff.stdout ?? "")
			.digest("hex");
	}

	async function runReview(ctx: ExtensionContext, hash: string) {
		const body = promptBody(await readFile(PROMPT_PATH, "utf8"));
		reviewed.add(hash);
		count += 1;
		if (ctx.hasUI)
			ctx.ui.notify("Auto quick-review of uncommitted changes", "info");
		// DEV-NOTE: agent_end fires while the runner still counts as processing, so an
		// unqueued sendUserMessage is rejected with "Agent is already processing".
		pi.sendUserMessage(body, { deliverAs: "followUp" });
	}

	/** Renders the verdict and the top findings as a coloured widget above the editor. */
	function renderPanel(
		ctx: ExtensionContext,
		verdict: string,
		findings: ReturnType<typeof parseFindings>,
	) {
		const head = colour(
			VERDICT_COLOUR[verdict] ?? DIM,
			`  quick review: ${verdict}`,
			true,
		);
		const counts = ["HIGH", "MED", "LOW"]
			.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
			.filter(([, n]) => n > 0)
			.map(([s, n]) => colour(SEVERITY_COLOUR[s], `${n} ${s}`))
			.join(colour(DIM, " · "));

		const lines = [counts ? `${head}  ${counts}` : head];
		for (const f of findings.slice(0, MAX_WIDGET_FINDINGS)) {
			lines.push(
				`  ${colour(SEVERITY_COLOUR[f.severity], f.severity.padEnd(4))} ` +
					`${colour("110;180;230", f.location)} ${colour(DIM, "—")} ${f.finding}`,
			);
		}
		const rest = findings.length - MAX_WIDGET_FINDINGS;
		if (rest > 0) lines.push(colour(DIM, `  +${rest} more in the report above`));
		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
	}

	/**
	 * Asks whether the agent should keep working on the findings, and hands the
	 * review output back as the context for that work.
	 */
	async function offerFollowUp(messages: unknown[], ctx: ExtensionContext) {
		const text = lastAssistantText(messages as never[]);
		const verdict = parseVerdict(text);
		if (!verdict || !ctx.hasUI) return;

		renderPanel(ctx, verdict, parseFindings(text));
		if (verdict !== "CONCERNS" && verdict !== "FAIL") return;

		const ok = await ctx.ui.confirm(
			`Quick review: ${verdict}`,
			"The review found issues. Work on them now?",
		);
		if (ok) pi.sendUserMessage(FOLLOW_UP_PROMPT, { deliverAs: "followUp" });
	}

	// DEV-NOTE: the panel describes one specific review, so it is dropped as soon as
	// the next turn starts rather than lingering over unrelated work.
	pi.on("turn_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.on("agent_end", async (event, ctx) => {
		// DEV-NOTE: sendUserMessage starts another agent loop, which ends in this same
		// handler. `running` drops that echo; the fingerprint set and the budget in
		// gate.mjs stop a review/fix ping-pong from looping indefinitely.
		if (running) {
			running = false;
			await offerFollowUp(event.messages, ctx);
			return;
		}

		const hash = await diffFingerprint(ctx.cwd);
		const { review } = shouldAutoReview({ hash, reviewed, count, disabled });
		if (!review) return;

		running = true;
		await runReview(ctx, hash);
	});

	pi.registerCommand("quick-review-auto", {
		description: "Toggle the automatic quick review at the end of an agent turn",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") disabled = false;
			else if (arg === "off") disabled = true;
			else disabled = !disabled;

			if (ctx.hasUI) {
				ctx.ui.notify(
					`Auto quick-review ${disabled ? "disabled" : "enabled"} for this session`,
					"info",
				);
			}
		},
	});
}
