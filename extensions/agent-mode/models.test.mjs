import test from "node:test";
import assert from "node:assert/strict";

import { newestOfFamily, parseModelId, pickModel } from "./models.mjs";

// Model ids as reported by omp 18.11.1's registry on 2026-11-01, in its order.
const REGISTRY = [
	"claude-3-5-sonnet-20240620",
	"claude-3-5-sonnet-20241022",
	"claude-3-haiku-20240307",
	"claude-fable-5",
	"claude-haiku-4-5",
	"claude-haiku-4-5-20251001",
	"claude-haiku-5-5",
	"claude-opus-4-0",
	"claude-opus-4-1",
	"claude-opus-4-1-20250805",
	"claude-opus-4-20250514",
	"claude-opus-4-5",
	"claude-opus-4-5-20251101",
	"claude-opus-4-8",
	"claude-opus-5",
	"claude-opus-5-5",
	"claude-sonnet-4-0",
	"claude-sonnet-4-20250514",
	"claude-sonnet-4-5-20250929",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
	"claude-sonnet-5-5",
].map((id) => ({ provider: "anthropic", id }));

test("parseModelId reads versions on either side of the family and the release date", () => {
	assert.deepEqual(parseModelId("claude-opus-5-5", "opus"), { version: [5, 5], date: 0 });
	assert.deepEqual(parseModelId("claude-opus-4-1-20250805", "opus"), { version: [4, 1], date: 20250805 });
	assert.deepEqual(parseModelId("claude-3-5-sonnet-20241022", "sonnet"), { version: [3, 5], date: 20241022 });
	assert.equal(parseModelId("claude-opus-5-5", "sonnet"), null);
	assert.equal(parseModelId("claude-opusx-5", "opus"), null);
	assert.equal(parseModelId("claude-opus", "opus"), null);
});

test("newestOfFamily picks the newest Opus and Sonnet from the real registry, not the first prefix match", () => {
	assert.equal(newestOfFamily(REGISTRY, "opus").id, "claude-opus-5-5");
	assert.equal(newestOfFamily(REGISTRY, "sonnet").id, "claude-sonnet-5-5");
	assert.equal(newestOfFamily(REGISTRY, "haiku").id, "claude-haiku-5-5");
	assert.equal(newestOfFamily(REGISTRY, "gpt"), null);
	assert.equal(newestOfFamily([], "opus"), null);
});

test("newestOfFamily compares versions numerically and treats a missing minor as 0", () => {
	const ids = ["claude-opus-4-10", "claude-opus-4-9", "claude-opus-4"].map((id) => ({ provider: "a", id }));
	assert.equal(newestOfFamily(ids, "opus").id, "claude-opus-4-10");
	const major = ["claude-opus-5", "claude-opus-4-9"].map((id) => ({ provider: "a", id }));
	assert.equal(newestOfFamily(major, "opus").id, "claude-opus-5");
});

test("on equal versions the undated alias wins, then the preferred provider", () => {
	const dated = [
		{ provider: "anthropic", id: "claude-opus-4-5-20251101" },
		{ provider: "anthropic", id: "claude-opus-4-5" },
	];
	assert.equal(newestOfFamily(dated, "opus").id, "claude-opus-4-5");

	const providers = [
		{ provider: "openrouter", id: "claude-opus-5-5" },
		{ provider: "anthropic", id: "claude-opus-5-5" },
	];
	assert.equal(newestOfFamily(providers, "opus", "anthropic").provider, "anthropic");
	assert.equal(newestOfFamily(providers, "opus", "openrouter").provider, "openrouter");
	assert.equal(newestOfFamily(providers, "opus").provider, "openrouter");
});

test("pickModel takes an exact provider/id from the whole registry, even without credentials", () => {
	const keyless = { provider: "openai", id: "o3", name: "o3" };
	const find = (provider, id) => (provider === "openai" && id === "o3" ? keyless : null);

	assert.equal(pickModel({ available: REGISTRY, find }, "openai/o3", "opus"), keyless);
});

test("pickModel falls back from a configured id to the newest match, then to the family", () => {
	const registry = { available: REGISTRY, find: () => null };

	assert.equal(pickModel(registry, "anthropic/claude-sonnet-4-6", "opus").id, "claude-sonnet-4-6");
	assert.equal(pickModel(registry, "claude-opus-4", "opus").id, "claude-opus-4-8");
	assert.equal(pickModel(registry, "claude-opus-4-1", "opus").id, "claude-opus-4-1");
	assert.equal(pickModel(registry, "no-such-model", "sonnet").id, "claude-sonnet-5-5");
	assert.equal(pickModel(registry, undefined, "opus").id, "claude-opus-5-5");
	assert.equal(pickModel(registry, undefined, "gpt"), null);
});

test("pickModel matches the display name case-insensitively", () => {
	const named = [
		{ provider: "a", id: "x-1", name: "Claude Opus 5.5" },
		{ provider: "a", id: "y-2", name: "Claude Sonnet 5.5" },
		{ provider: "a", id: "z-3" },
	];

	assert.equal(pickModel({ available: named, find: () => null }, "opus 5.5", "sonnet").id, "x-1");
	assert.equal(pickModel({ available: named, find: () => null }, "und", "sonnet"), null);
});

test("pickModel returns nothing when no model has credentials", () => {
	const find = () => ({ provider: "anthropic", id: "claude-opus-5-5" });

	assert.equal(pickModel({ available: [], find }, "anthropic/claude-opus-5-5", "opus"), null);
});
