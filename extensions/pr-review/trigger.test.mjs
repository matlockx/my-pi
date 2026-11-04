import test from "node:test";
import assert from "node:assert/strict";

import { prReviewUrls, reviewInstruction } from "./trigger.mjs";

test("prReviewUrls normalises a linked PR of a review request", () => {
	assert.deepEqual(
		prReviewUrls("please review https://github.com/acme/shop-api/pull/30/changes"),
		["https://github.com/acme/shop-api/pull/30"],
	);
});

test("prReviewUrls keeps every distinct PR once", () => {
	const prompt =
		"Review https://github.com/a/b/pull/1 and https://github.com/a/b/pull/1/files, then http://github.com/a/c.d/pull/2";
	assert.deepEqual(prReviewUrls(prompt), ["https://github.com/a/b/pull/1", "https://github.com/a/c.d/pull/2"]);
});

test("prReviewUrls needs a review request", () => {
	assert.deepEqual(prReviewUrls("describe https://github.com/a/b/pull/1"), []);
	assert.deepEqual(prReviewUrls("the reviewer of https://github.com/a/b/pull/1 left"), []);
});

test("prReviewUrls ignores links that are not pull requests", () => {
	assert.deepEqual(prReviewUrls("review https://github.com/a/b/issues/1 and https://gitlab.com/a/b/pull/2"), []);
});

test("reviewInstruction names the PRs and embeds the skill without its front matter", () => {
	const text = reviewInstruction(
		["https://github.com/a/b/pull/1"],
		"---\nname: pr-review\ndescription: x\n---\n\n# Review a GitHub pull request\n",
	);
	assert.match(text, /review of https:\/\/github\.com\/a\/b\/pull\/1\./);
	assert.match(text, /# Review a GitHub pull request$/);
	assert.doesNotMatch(text, /name: pr-review/);
});
