import test from "node:test";
import assert from "node:assert/strict";

import { appendSystemPrompt } from "./system-prompt.mjs";

test("appendSystemPrompt keeps omp's block array intact and joins pi's string with a blank line", () => {
	const omp = ["</critical>", "<project-context>"];
	assert.deepEqual(appendSystemPrompt(omp, "EXTRA"), ["</critical>", "<project-context>", "EXTRA"]);
	assert.deepEqual(omp, ["</critical>", "<project-context>"], "the input array is not mutated");
	assert.equal(appendSystemPrompt("base", "EXTRA"), "base\n\nEXTRA");
	assert.equal(appendSystemPrompt(undefined, "EXTRA"), "EXTRA");
});
