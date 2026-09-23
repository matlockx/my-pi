import test from "node:test";
import assert from "node:assert/strict";

import { inputApprovesJflow, statusText } from "./intent.mjs";

test("typed prompt naming jflow approves", () => {
	for (const text of ["create pr with jflow now", "JFlow: commit this", "use jflow."]) {
		assert.equal(inputApprovesJflow({ source: "interactive", text }), true, text);
	}
	assert.equal(inputApprovesJflow({ source: "rpc", text: "jflow pr" }), true);
});

test("prompts without the word jflow do not approve", () => {
	for (const text of ["create a pr", "update jflowish docs", "", undefined]) {
		assert.equal(inputApprovesJflow({ source: "interactive", text }), false, String(text));
	}
});

test("extension-injected prompts never approve", () => {
	assert.equal(inputApprovesJflow({ source: "extension", text: "create pr with jflow" }), false);
});

test("status text shows transport, reachability and auto-approve", () => {
	assert.equal(statusText({ mode: "stdio", up: undefined, auto: false }), undefined);
	assert.equal(statusText({ mode: "http", up: false, auto: true }), "jflow: http down");
	assert.equal(statusText({ mode: "http", up: true, auto: false }), "jflow: http ✓");
	assert.equal(statusText({ mode: "stdio", up: true, auto: true }), "jflow: stdio auto ✓");
});
