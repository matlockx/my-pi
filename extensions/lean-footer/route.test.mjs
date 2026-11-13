import assert from "node:assert/strict";
import test from "node:test";

import { routeLabel } from "./route.mjs";

const opus = { provider: "anthropic", id: "claude-opus-5-5" };

test("an OAuth session names its account by e-mail, so two logins of one provider are told apart", () => {
	assert.equal(routeLabel(opus, { accountId: "acc-1", email: "a@example.com" }), "anthropic/claude-opus-5-5 · a@example.com");
	assert.equal(routeLabel(opus, { accountId: "acc-2", email: "b@example.com" }), "anthropic/claude-opus-5-5 · b@example.com");
});

test("an identity without e-mail falls back to account id, then organisation, then project", () => {
	assert.equal(routeLabel(opus, { accountId: "acc-1", orgName: "Org" }), "anthropic/claude-opus-5-5 · acc-1");
	assert.equal(routeLabel(opus, { orgId: "org-1", orgName: "Org" }), "anthropic/claude-opus-5-5 · Org");
	assert.equal(routeLabel(opus, { orgId: "org-1" }), "anthropic/claude-opus-5-5 · org-1");
	assert.equal(routeLabel(opus, { projectId: "p-1" }), "anthropic/claude-opus-5-5 · p-1");
});

test("without an OAuth identity the route is an API key, and without a model there is no route", () => {
	assert.equal(routeLabel({ provider: "openai", id: "gpt-6" }, undefined), "openai/gpt-6 · api key");
	assert.equal(routeLabel(undefined, { email: "a@example.com" }), "no model");
});

const pa = { email: "a@example.com" };
const pb = { email: "b@example.com" };
const priorities = new Map([[pb, 10]]);
const priorityOf = (account) => priorities.get(account);

test("before omp binds an account, the label names the config default instead of omp's first stored account", () => {
	assert.equal(
		routeLabel(opus, pa, [pa, pb], priorityOf),
		"anthropic/claude-opus-5-5 · account pending, config default: b@example.com",
	);
});

test("once an account is bound, the label names it even when the config prefers another one", () => {
	assert.equal(routeLabel(opus, pa, [{ ...pa, active: true }, pb], priorityOf), "anthropic/claude-opus-5-5 · a@example.com");
});

test("the config default is the highest policy priority; a tie goes to the account stored first", () => {
	const pc = { email: "c@example.com" };
	const ranked = new Map([[pa, 1], [pb, 5], [pc, 5]]);
	assert.equal(
		routeLabel(opus, pa, [pa, pb, pc], (account) => ranked.get(account)),
		"anthropic/claude-opus-5-5 · account pending, config default: b@example.com",
	);
});

test("a pending account without any policy priority says that the config sets no default", () => {
	assert.equal(routeLabel(opus, pa, [pa, pb]), "anthropic/claude-opus-5-5 · account pending, no config default");
});
