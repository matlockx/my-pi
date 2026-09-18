import test from "node:test";
import assert from "node:assert/strict";

import {
	AUTO_FIX_LIMIT,
	commandDirs,
	fixDecision,
	lastAssistantText,
	MAX_AUTO_REVIEWS,
	messageText,
	parseFindings,
	parseVerdict,
	promptBody,
	shouldAutoReview,
	shouldSelfReview,
	trackedStatus,
	turnVerdict,
} from "./gate.mjs";

const assistant = (text) => ({ role: "assistant", content: text });

test("turnVerdict reports a review turn, which ends on its verdict", () => {
	const result = turnVerdict([
		{ role: "user", content: "review" },
		assistant("VERDICT: CONCERNS\n\n## Findings\n\n**MED** `a.go:1` — x → y"),
	]);
	assert.equal(result.verdict, "CONCERNS");
	assert.equal(result.placement, "last");
});

test("turnVerdict reports a self-review, whose verdict sits above the summary", () => {
	const result = turnVerdict([
		assistant("VERDICT: PASS\n\n## Findings\n\nnone"),
		assistant("Done. Changed lib/history/items.go."),
	]);
	assert.equal(result.verdict, "PASS");
	assert.equal(result.placement, "inline");
	assert.match(result.text, /VERDICT: PASS/);
});

test("turnVerdict reports no verdict for an ordinary working turn", () => {
	assert.deepEqual(turnVerdict([assistant("Done.")]), {
		verdict: null,
		placement: "none",
		text: "",
	});
});

test("commandDirs reads cd and git -C targets", () => {
	assert.deepEqual(
		commandDirs("cd /Users/me/projects/draw-service && go build ./..."),
		["/Users/me/projects/draw-service"],
	);
	assert.deepEqual(commandDirs("git -C ../order-service fetch origin"), [
		"../order-service",
	]);
	assert.deepEqual(commandDirs("cd '../a b'; cd \"../a b\""), ["../a b"]);
});

test("commandDirs ignores flags, variables, and commands without a directory", () => {
	assert.deepEqual(commandDirs("cd -"), []);
	assert.deepEqual(commandDirs("cd $REPO && ls"), []);
	assert.deepEqual(commandDirs("rg -n 'cd' README.md"), []);
});

test("shouldSelfReview appends the directive for an ordinary turn", () => {
	assert.equal(shouldSelfReview({ disabled: false, phase: "idle" }), true);
	assert.equal(shouldSelfReview(), true);
});

test("shouldSelfReview withholds the directive inside the cycle and when off", () => {
	assert.equal(shouldSelfReview({ phase: "reviewing" }), false);
	assert.equal(shouldSelfReview({ phase: "fixing" }), false);
	assert.equal(shouldSelfReview({ disabled: true, phase: "idle" }), false);
});

test("shouldAutoReview triggers for an unseen dirty tree", () => {
	const result = shouldAutoReview({
		hash: "abc",
		reviewed: new Set(),
		count: 0,
		edited: true,
	});
	assert.deepEqual(result, { review: true, ask: false, reason: "changed" });
});

test("shouldAutoReview stays silent on a clean tree", () => {
	assert.equal(
		shouldAutoReview({ hash: "", reviewed: new Set(), count: 0, edited: true })
			.review,
		false,
	);
});

test("shouldAutoReview reviews each diff fingerprint only once", () => {
	const reviewed = new Set(["abc"]);
	assert.deepEqual(
		shouldAutoReview({ hash: "abc", reviewed, count: 1, edited: true }),
		{
			review: false,
			ask: false,
			reason: "already-reviewed",
		},
	);
	assert.equal(
		shouldAutoReview({ hash: "def", reviewed, count: 1, edited: true }).review,
		true,
	);
});

test("shouldAutoReview asks instead of skipping past the budget", () => {
	const result = shouldAutoReview({
		hash: "new",
		reviewed: new Set(),
		count: MAX_AUTO_REVIEWS,
		edited: true,
	});
	assert.deepEqual(result, {
		review: true,
		ask: true,
		reason: "budget-exhausted",
	});
});

test("shouldAutoReview honours the opt-out", () => {
	const result = shouldAutoReview({
		hash: "abc",
		reviewed: new Set(),
		count: 0,
		disabled: true,
		edited: true,
	});
	assert.deepEqual(result, { review: false, ask: false, reason: "disabled" });
});

test("promptBody strips frontmatter and keeps the body", () => {
	const body = promptBody("---\ndescription: x\n---\nDo a review.\n");
	assert.equal(body, "Do a review.");
});

test("promptBody passes through a file without frontmatter", () => {
	assert.equal(promptBody("Do a review.\n"), "Do a review.");
});

test("parseVerdict reads each verdict, bold or plain", () => {
	assert.equal(parseVerdict("VERDICT: PASS\n"), "PASS");
	assert.equal(parseVerdict("**VERDICT**: CONCERNS\n"), "CONCERNS");
	assert.equal(parseVerdict("intro\n\nVERDICT: FAIL\n\nHIGH x"), "FAIL");
});

test("parseVerdict returns null without a verdict line", () => {
	assert.equal(parseVerdict("no verdict here"), null);
	assert.equal(parseVerdict(undefined), null);
});

test("lastAssistantText joins the text blocks of the final assistant message", () => {
	const text = lastAssistantText([
		{ role: "assistant", content: "older" },
		{ role: "user", content: "prompt" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "VERDICT: FAIL" },
				{ type: "text", text: "HIGH main.go:1" },
			],
		},
	]);
	assert.equal(text, "VERDICT: FAIL\nHIGH main.go:1");
});

test("lastAssistantText returns empty string when no assistant message exists", () => {
	assert.equal(lastAssistantText([{ role: "user", content: "x" }]), "");
	assert.equal(lastAssistantText(undefined), "");
});

test("parseFindings reads severity, location, finding and fix from report lines", () => {
	const findings = parseFindings(
		[
			"VERDICT: CONCERNS",
			"## Findings",
			"MED cmd/pr_context.go:217-221 — doc comment orphaned → move it back down",
			"  - **LOW** `cmd/pr_context.go:165` — prefix too broad -> drop it",
			"LOW cmd/pr_context.go:173 — no arrow here",
			"not a finding line",
			"## Summary",
			"LOW risk overall — nothing to do here → ignore",
		].join("\n"),
	);
	assert.deepEqual(findings, [
		{
			severity: "MED",
			location: "cmd/pr_context.go:217-221",
			finding: "doc comment orphaned",
			fix: "move it back down",
		},
		{
			severity: "LOW",
			location: "cmd/pr_context.go:165",
			finding: "prefix too broad",
			fix: "drop it",
		},
		{
			severity: "LOW",
			location: "cmd/pr_context.go:173",
			finding: "no arrow here",
			fix: "",
		},
	]);
});

test("parseFindings returns an empty list for a clean report", () => {
	assert.deepEqual(parseFindings("VERDICT: PASS\n## Findings\n\nnone"), []);
	assert.deepEqual(parseFindings(undefined), []);
});

test("shouldAutoReview skips a turn that changed no file", () => {
	const decision = shouldAutoReview({
		hash: "abc",
		reviewed: new Set(),
		count: 0,
		edited: false,
	});
	assert.deepEqual(decision, { review: false, ask: false, reason: "no-edits" });
});

test("trackedStatus drops untracked entries", () => {
	assert.equal(trackedStatus("?? Logs.json\n M main.go"), " M main.go");
	assert.equal(trackedStatus("?? Logs.json\n"), "");
	assert.equal(trackedStatus(undefined), "");
});

test("messageText joins text blocks and ignores non-text content", () => {
	assert.equal(messageText({ content: "plain" }), "plain");
	assert.equal(
		messageText({
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
		}),
		"a\nb",
	);
	assert.equal(messageText(undefined), "");
});

test("fixDecision fixes a small batch of defects without asking", () => {
	const decision = fixDecision([
		{ severity: "HIGH" },
		{ severity: "MED" },
		{ severity: "LOW" },
	]);
	assert.deepEqual(decision, {
		action: "auto",
		actionable: 2,
		reason: "defects",
	});
});

test("fixDecision asks when the defect batch exceeds the limit", () => {
	const findings = Array.from({ length: AUTO_FIX_LIMIT + 1 }, () => ({
		severity: "MED",
	}));
	assert.deepEqual(fixDecision(findings), {
		action: "ask",
		actionable: AUTO_FIX_LIMIT + 1,
		reason: "over-limit",
	});
});

test("fixDecision asks for a LOW-only report", () => {
	assert.equal(fixDecision([{ severity: "LOW" }]).action, "ask");
});

test("fixDecision stays silent when there is nothing to fix", () => {
	assert.equal(fixDecision([]).action, "none");
});

test("parseFindings reads the markdown report shape", () => {
	const report = [
		"**VERDICT: CONCERNS**",
		"",
		"## Findings",
		"",
		"**HIGH** `internal/a.go:12` — thing broken → fix it",
		"**LOW** `b.ts:3` — minor → note it",
		"",
		"## Commit message",
	].join("\n");

	assert.equal(parseVerdict(report), "CONCERNS");
	assert.deepEqual(parseFindings(report), [
		{
			severity: "HIGH",
			location: "internal/a.go:12",
			finding: "thing broken",
			fix: "fix it",
		},
		{ severity: "LOW", location: "b.ts:3", finding: "minor", fix: "note it" },
	]);
});
