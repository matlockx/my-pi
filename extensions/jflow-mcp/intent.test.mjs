import test from "node:test";
import assert from "node:assert/strict";

import { inputApprovesJflow, isAutoRemote, statusText } from "./intent.mjs";

test("Stardust org remotes get auto-approve", () => {
	for (const url of [
		"https://github.com/BauerMediaGroup-Stardust/jflow.git",
		"https://x-access-token@github.com/bauermediagroup-stardust/repo",
		"git@github.com:BauerMediaGroup-Stardust/repo.git\n",
		"ssh://git@github.com/BauerMediaGroup-Stardust/repo.git",
	]) {
		assert.equal(isAutoRemote(url), true, url);
	}
});

test("other remotes do not get auto-approve", () => {
	for (const url of [
		"https://github.com/BauerMediaGroup/repo.git",
		"https://github.com/BauerMediaGroup-Stardust-fork/repo",
		"https://github.com.evil.io/BauerMediaGroup-Stardust/repo",
		"https://evil.io/github.com/BauerMediaGroup-Stardust/repo",
		"git@gitlab.com:BauerMediaGroup-Stardust/repo.git",
		"",
		undefined,
	]) {
		assert.equal(isAutoRemote(url), false, String(url));
	}
});

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
