import test from "node:test";
import assert from "node:assert/strict";

import {
	lastAssistantText,
	MAX_AUTO_REVIEWS,
	parseFindings,
	parseVerdict,
	promptBody,
	shouldAutoReview,
} from "./gate.mjs";

test("shouldAutoReview triggers for an unseen dirty tree", () => {
	const result = shouldAutoReview({
		hash: "abc",
		reviewed: new Set(),
		count: 0,
	});
	assert.deepEqual(result, { review: true, reason: "changed" });
});

test("shouldAutoReview stays silent on a clean tree", () => {
	assert.equal(
		shouldAutoReview({ hash: "", reviewed: new Set(), count: 0 }).review,
		false,
	);
});

test("shouldAutoReview reviews each diff fingerprint only once", () => {
	const reviewed = new Set(["abc"]);
	assert.deepEqual(shouldAutoReview({ hash: "abc", reviewed, count: 1 }), {
		review: false,
		reason: "already-reviewed",
	});
	assert.equal(
		shouldAutoReview({ hash: "def", reviewed, count: 1 }).review,
		true,
	);
});

test("shouldAutoReview stops at the session budget", () => {
	const result = shouldAutoReview({
		hash: "new",
		reviewed: new Set(),
		count: MAX_AUTO_REVIEWS,
	});
	assert.deepEqual(result, { review: false, reason: "budget-exhausted" });
});

test("shouldAutoReview honours the opt-out", () => {
	const result = shouldAutoReview({
		hash: "abc",
		reviewed: new Set(),
		count: 0,
		disabled: true,
	});
	assert.deepEqual(result, { review: false, reason: "disabled" });
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
