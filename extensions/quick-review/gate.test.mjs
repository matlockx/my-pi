import test from "node:test";
import assert from "node:assert/strict";

import { MAX_AUTO_REVIEWS, promptBody, shouldAutoReview } from "./gate.mjs";

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
