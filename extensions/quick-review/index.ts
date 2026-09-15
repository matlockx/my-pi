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
import { Container, Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
	fixDecision,
	lastAssistantText,
	MAX_AUTO_REVIEWS,
	messageText,
	parseFindings,
	parseVerdict,
	promptBody,
	shouldAutoReview,
	trackedStatus,
} from "./gate.mjs";

/**
 * Theme tones for the report card. Raw ANSI is avoided: the TUI renders through the
 * active theme, and a hard-coded colour is unreadable on a light one.
 */
const VERDICT_TONE = {
	PASS: "success",
	CONCERNS: "warning",
	FAIL: "error",
} as const;
const SEVERITY_TONE = {
	HIGH: "error",
	MED: "warning",
	LOW: "muted",
} as const;
const STATUS_KEY = "quick-review";
const REPORT_TYPE = "quick-review-report";
const MAX_CARD_FINDINGS = 6;

type Finding = ReturnType<typeof parseFindings>[number];
type ReportDetails = { verdict: string; findings: Finding[] };

/**
 * Stands in for the review prompt in the transcript. The chat shows this one line; the
 * full checklist is swapped in for the model on the way to the provider.
 */
const REVIEW_MARKER = "Quick review of the uncommitted changes.";

/**
 * Instructs the fix turn and hands it the summary of the original task.
 *
 * The fix turn ends on that summary rather than the extension replaying it, because a
 * fix can contradict it: a finding may remove a file the summary lists, change a
 * decision it records, or add a test it does not mention.
 *
 * @param summary The summary the reviewed turn ended on; "" when it produced none.
 */
const followUpPrompt = (summary: string) =>
	"Address the quick-review findings above. Fix the HIGH and MED items first, " +
	"skip anything you judge a false positive and say why in one line, and add or " +
	"update the tests the findings call for. Do not commit. Keep the fix notes to " +
	"one line per finding.\n\n" +
	(summary
		? "Then close with the task summary below, restated in full and amended " +
			"wherever a fix changed it — files, decisions, test counts, open questions. " +
			"It is the last thing the user reads, so it must describe the tree as it " +
			`stands after the fixes, not before.\n\n---\n${summary}\n---`
		: "Then close with a short summary of the task as it now stands.");

const PROMPT_PATH = fileURLToPath(
	new URL("../../prompts/quick-review.md", import.meta.url),
);

export default function (pi: ExtensionAPI) {
	const reviewed = new Set<string>();
	let count = 0;
	let disabled = false;
	/** "idle" outside the cycle, then the loop the next agent_end belongs to. */
	let phase: "idle" | "reviewing" | "fixing" = "idle";
	let baseline = "";
	let reviewBody = "";
	let taskSummary = "";
	/** Rule that decided the last agent_end, reported by /quick-review-auto status. */
	let lastReason = "none yet";

	/** Renders the on/off state and the remaining budget in the status line. */
	function status(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			disabled ? "review: off" : `review: ${count}/${MAX_AUTO_REVIEWS}`,
		);
	}

	/** Fingerprints the tracked uncommitted changes; "" for a clean tree or a non-git directory. */
	async function diffFingerprint(cwd: string): Promise<string> {
		const status = await pi.exec("git", ["status", "--porcelain"], { cwd });
		if (status.code !== 0) return "";
		const tracked = trackedStatus(status.stdout);
		if (!tracked) return "";

		const diff = await pi.exec("git", ["diff", "HEAD"], { cwd });
		return createHash("sha1")
			.update(tracked)
			.update(diff.stdout ?? "")
			.digest("hex");
	}

	/**
	 * Re-renders the summary of the original task, so the review does not leave it
	 * buried above itself. Not sent to the model.
	 *
	 * Only valid when no fix turn ran: after a fix the held text can be out of date,
	 * and the fix turn restates it instead.
	 */
	function restoreSummary() {
		if (!taskSummary) return;
		pi.sendMessage({
			customType: "quick-review-summary",
			content: `## Task summary\n\n${taskSummary}`,
			display: true,
		});
		taskSummary = "";
	}

	async function runReview(ctx: ExtensionContext, hash: string) {
		reviewBody = promptBody(await readFile(PROMPT_PATH, "utf8"));
		reviewed.add(hash);
		count += 1;
		if (ctx.hasUI)
			ctx.ui.notify("Auto quick-review of uncommitted changes", "info");
		// DEV-NOTE: agent_end fires while the runner still counts as processing, so an
		// unqueued sendUserMessage is rejected with "Agent is already processing".
		pi.sendUserMessage(REVIEW_MARKER, { deliverAs: "followUp" });
	}

	// DEV-NOTE: sendUserMessage renders whatever it sends, so the 20-line checklist would
	// sit in the transcript above every review. The marker is expanded here instead, which
	// is the last point before the provider sees the messages.
	pi.on("context", async (event) => {
		if (!reviewBody) return;
		const messages = event.messages.map((message) =>
			message.role === "user" && messageText(message) === REVIEW_MARKER
				? { ...message, content: reviewBody }
				: message,
		);
		return { messages };
	});

	// DEV-NOTE: the report the model writes is plain text in a fenced block, which no
	// renderer colours. The card below carries the same verdict and findings as a custom
	// message, so it is themed, stays in the transcript, and survives the next turn — a
	// widget above the editor is cleared as soon as work continues.
	pi.registerMessageRenderer<ReportDetails>(
		REPORT_TYPE,
		(message, _options, theme) => {
			const details = message.details;
			if (!details) return undefined;
			const { verdict, findings } = details;

			const tone = VERDICT_TONE[verdict as keyof typeof VERDICT_TONE] ?? "muted";
			const counts = (["HIGH", "MED", "LOW"] as const)
				.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
				.filter(([, n]) => n > 0)
				.map(([s, n]) => theme.fg(SEVERITY_TONE[s], `${n} ${s}`))
				.join(theme.fg("dim", " · "));

			const container = new Container();
			container.addChild(
				new Text(
					`${theme.fg(tone, theme.bold(`quick review: ${verdict}`))}${
						counts ? `  ${counts}` : ""
					}`,
				),
			);
			for (const f of findings.slice(0, MAX_CARD_FINDINGS)) {
				container.addChild(
					new Text(
						`${theme.fg(SEVERITY_TONE[f.severity], f.severity.padEnd(4))} ` +
							`${theme.fg("accent", f.location)} ${theme.fg("dim", "—")} ${f.finding}`,
					),
				);
			}
			const rest = findings.length - MAX_CARD_FINDINGS;
			if (rest > 0)
				container.addChild(
					new Text(theme.fg("dim", `+${rest} more in the report above`)),
				);
			return container;
		},
	);

	/** Posts the verdict and the top findings as a themed card in the transcript. */
	function renderReport(verdict: string, findings: Finding[]) {
		pi.sendMessage<ReportDetails>({
			customType: REPORT_TYPE,
			content: `quick review: ${verdict}`,
			display: true,
			details: { verdict, findings },
		});
	}

	/**
	 * Asks whether the agent should keep working on the findings, and hands the
	 * review output back as the context for that work.
	 */
	async function offerFollowUp(messages: unknown[], ctx: ExtensionContext) {
		const text = lastAssistantText(messages as never[]);
		const verdict = parseVerdict(text);
		if (!verdict || !ctx.hasUI) return false;

		const findings = parseFindings(text);
		renderReport(verdict, findings);

		const { action, actionable } = fixDecision(findings);
		if (action === "none") return false;
		if (action === "ask") {
			const ok = await ctx.ui.confirm(
				`Quick review: ${verdict}`,
				actionable === 0
					? "Only LOW findings. Work on them now?"
					: `${actionable} HIGH/MED findings — more than a quick fix. Work on them now?`,
			);
			if (!ok) return false;
		} else {
			ctx.ui.notify(
				`Quick review: fixing ${actionable} finding${actionable === 1 ? "" : "s"}`,
				"info",
			);
		}

		pi.sendUserMessage(followUpPrompt(taskSummary), { deliverAs: "followUp" });
		taskSummary = "";
		return true;
	}

	// DEV-NOTE: the baseline is taken here rather than counting write tool calls, so a turn
	// that changed files through bash (sed, heredoc, git apply) is reviewed like any other.
	// The auto-review's own follow-up message also starts a turn, which rebaselines before
	// the fix turn runs — exactly what the next review needs.
	// DEV-NOTE: the budget bounds one review/fix ping-pong, not the session. A turn that
	// starts outside the cycle came from the user, and their next request earns a fresh
	// budget — a long session is more worth reviewing, not less.
	pi.on("turn_start", async (_event, ctx) => {
		if (phase === "idle") count = 0;
		baseline = await diffFingerprint(ctx.cwd);
		status(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		// DEV-NOTE: sendUserMessage starts another agent loop, which ends in this same
		// handler. `phase` routes those echoes; the fingerprint set and the budget in
		// gate.mjs stop a review/fix ping-pong from looping indefinitely.
		if (phase === "reviewing") {
			const fixing = await offerFollowUp(event.messages, ctx);
			phase = fixing ? "fixing" : "idle";
			if (!fixing) restoreSummary();
			return;
		}
		// DEV-NOTE: nothing is replayed after a fix turn — that turn was handed the summary
		// and ends on its amended version, which is the only one that still matches the tree.
		if (phase === "fixing") {
			phase = "idle";
			return;
		}

		const hash = await diffFingerprint(ctx.cwd);
		const { review, ask, reason } = shouldAutoReview({
			hash,
			reviewed,
			count,
			edited: hash !== baseline,
			disabled,
		});
		lastReason = reason;
		if (!review) return;

		if (ask) {
			if (!ctx.hasUI) return;
			const ok = await ctx.ui.confirm(
				"Quick review",
				`${count} auto-reviews already ran for this request. Review the changes again?`,
			);
			if (!ok) return;
		}

		// DEV-NOTE: the turn that is ending carries the summary of the real task. The
		// review and the fix turn push it out of sight, so it is held here and replayed
		// once the cycle closes — the transcript ends on the task, not on the review.
		taskSummary = lastAssistantText(event.messages as never[]);
		phase = "reviewing";
		await runReview(ctx, hash);
	});

	pi.on("session_start", async (_event, ctx) => status(ctx));

	pi.registerCommand("quick-review-auto", {
		description:
			"Toggle the automatic quick review at the end of an agent turn (on|off|status)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Auto quick-review ${disabled ? "disabled" : "enabled"} · ` +
							`${count}/${MAX_AUTO_REVIEWS} used · phase ${phase} · last decision: ${lastReason}`,
						"info",
					);
				}
				return;
			}
			if (arg === "on") {
				disabled = false;
				// DEV-NOTE: an explicit "on" is also the way out of a stuck phase, which would
				// otherwise swallow the next agent_end as a review echo.
				count = 0;
				phase = "idle";
			} else if (arg === "off") disabled = true;
			else disabled = !disabled;

			status(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Auto quick-review ${disabled ? "disabled" : "enabled"} for this session`,
					"info",
				);
			}
		},
	});
}
