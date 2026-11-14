import test from "node:test";
import assert from "node:assert/strict";

import { accuracyNote, footerOn, footerText, handlesOf, hasSavedState, ISOLATION, loadState, modeConflict, onNotice, ORCHESTRATOR_AGENTS, parseCommand, pipelineVersion, prRoundKey, quickReviewStandsDown, readGlobalDefault, sessionModeState, settingsPlan, statusText, writeGlobalDefault } from "./state.mjs";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("hasSavedState tells a new branch from one with a saved entry", () => {
	assert.equal(hasSavedState([]), false);
	assert.equal(hasSavedState(undefined), false);
	assert.equal(hasSavedState([{ type: "custom", customType: "orchestrator", data: "x" }]), false);
	assert.equal(hasSavedState([{ type: "custom", customType: "orchestrator", data: { enabled: false } }]), true);
});

test("loadState starts a branch without a saved entry on the global default; a saved entry wins", () => {
	assert.deepEqual(loadState([], true), { enabled: true, budget: "on" });
	assert.deepEqual(loadState(undefined, true), { enabled: true, budget: "on" });
	assert.deepEqual(loadState([], "yes"), { enabled: false, budget: "on" });
	const saved = [{ type: "custom", customType: "orchestrator", data: { enabled: false, budget: "off" } }];
	assert.deepEqual(loadState(saved, true), { enabled: false, budget: "off" });
});

test("readGlobalDefault is off for a missing or corrupt file; write then read round-trips", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-gd-"));
	const path = join(dir, "nested", "orchestrator.json");
	assert.equal(readGlobalDefault(path), false);
	writeGlobalDefault(true, path);
	assert.equal(readGlobalDefault(path), true);
	writeGlobalDefault(false, path);
	assert.equal(readGlobalDefault(path), false);
	assert.deepEqual(readdirSync(join(dir, "nested")), ["orchestrator.json"]);
	writeFileSync(path, "{not json");
	assert.equal(readGlobalDefault(path), false);
	writeFileSync(path, JSON.stringify({ enabled: "true" }));
	assert.equal(readGlobalDefault(path), false);
});

test("parseCommand reads on, off, status, budget and rate; everything else is an error", () => {
	assert.deepEqual(parseCommand(""), { action: "status" });
	assert.deepEqual(parseCommand(" ON "), { action: "on" });
	assert.deepEqual(parseCommand("off"), { action: "off" });
	assert.deepEqual(parseCommand("budget off"), { action: "budget", value: "off" });
	assert.deepEqual(parseCommand("rate 4 good split, QA caught the bug"), { action: "rate", rating: 4, note: "good split, QA caught the bug" });
	assert.deepEqual(parseCommand("rate 5"), { action: "rate", rating: 5 });
	for (const bad of ["rate 0", "rate 6", "rate 2.5", "rate", "budget", "budget maybe", "on now", "start"]) {
		assert.ok(parseCommand(bad).error, bad);
	}
});

test("loadState takes the latest saved state and defaults to off with budget on", () => {
	assert.deepEqual(loadState([]), { enabled: false, budget: "on" });
	const entries = [
		{ type: "custom", customType: "orchestrator", data: { enabled: true, budget: "off" } },
		{ type: "custom", customType: "other", data: { enabled: false } },
		{ type: "message" },
	];
	assert.deepEqual(loadState(entries), { enabled: true, budget: "off" });
	entries.push({ type: "custom", customType: "orchestrator", data: { enabled: false, budget: "on" } });
	assert.deepEqual(loadState(entries), { enabled: false, budget: "on" });
});

test("loadState reads a malformed entry fail-closed: off, budget on", () => {
	assert.deepEqual(loadState([{ type: "custom", customType: "orchestrator", data: { enabled: "yes", budget: 3 } }]), { enabled: false, budget: "on" });
});

test("modeConflict refuses omp plan (active or paused) and vibe, nothing else", () => {
	assert.match(modeConflict({ plan: "active", vibe: "inactive" }), /plan mode/);
	assert.match(modeConflict({ plan: "paused", vibe: "inactive" }), /plan mode/);
	assert.match(modeConflict({ plan: "inactive", vibe: "active" }), /vibe mode/);
	assert.equal(modeConflict({ plan: "inactive", vibe: "inactive", goal: "active" }), undefined);
	assert.equal(modeConflict(undefined), undefined);
});

test("settingsPlan: on isolates and caps requests per role over the user's budgets; off disables the orchestrator agents on top of the user's", () => {
	const base = { "task.disabledAgents": ["scout", "qa"], "task.agentSoftRequestBudget": { lead: 400, qa: 10 } };
	assert.deepEqual(settingsPlan(true, base), {
		...ISOLATION,
		"task.agentSoftRequestBudget": { lead: 400, qa: 80, implementer: 150, planner: 80, guardian: 40 },
	});
	assert.deepEqual(settingsPlan(false, base), { "task.disabledAgents": ["scout", "qa", "planner", "implementer"] });
	assert.deepEqual(settingsPlan(false, {})["task.disabledAgents"], ORCHESTRATOR_AGENTS);
});

test("prRoundKey keys jflow watcher prompts by pull request and ignores other prompts", () => {
	assert.equal(prRoundKey("jflow watcher, round 2/10: PR #42 (https://github.com/acme/api/pull/42) has 2 threads"), "acme/api#42");
	assert.equal(prRoundKey("jflow watcher, round 1/10: PR #7 has 1 thread"), "#7");
	assert.equal(prRoundKey("fix PR #42"), undefined);
});

test("quick-review stands down only while orchestrated, in the Lead and the orchestrator agents", () => {
	assert.equal(quickReviewStandsDown("orchestrated", { kind: "main", name: "main" }), true);
	assert.equal(quickReviewStandsDown("orchestrated", { kind: "sub", name: "implementer" }), true);
	assert.equal(quickReviewStandsDown("orchestrated", { kind: "sub", name: "scout" }), false);
	assert.equal(quickReviewStandsDown("off", { kind: "main", name: "main" }), false);
});

test("statusText shows the switch state on and off", () => {
	assert.equal(statusText({ enabled: false, budget: "off" }), "orch: off");
	assert.equal(statusText({ enabled: true, budget: "on" }), "orch: on");
	assert.equal(statusText({ enabled: true, budget: "off" }), "orch: on · budget off");
});

test("pipelineVersion changes with a persona file or a setting, not with file order", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-pv-"));
	const a = join(dir, "a.md");
	const b = join(dir, "b.md");
	writeFileSync(a, "one");
	writeFileSync(b, "two");
	const v = pipelineVersion([a, b], { x: 1 });
	assert.equal(pipelineVersion([b, a], { x: 1 }), v);
	assert.notEqual(pipelineVersion([a, b], { x: 2 }), v);
	writeFileSync(b, "two, edited by the retro");
	assert.notEqual(pipelineVersion([a, b], { x: 1 }), v);
});

test("accuracyNote needs three runs and says which way to correct", () => {
	assert.equal(accuracyNote(undefined), undefined);
	assert.equal(accuracyNote({ ratio: 2, runs: 2 }), undefined);
	assert.match(accuracyNote({ ratio: 1.6, runs: 4 }), /last 4 planned runs cost 1\.60x the estimate; estimate higher/);
	assert.match(accuracyNote({ ratio: 0.5, runs: 4 }), /estimate lower/);
	assert.match(accuracyNote({ ratio: 1.05, runs: 4 }), /close to the estimates/);
});

test("onNotice names the live-preview setting only while it is off and not yet hinted", () => {
	assert.match(onNotice({ previewOn: false, hinted: false }), /display\.subagentLivePreview/);
	assert.doesNotMatch(onNotice({ previewOn: false, hinted: true }), /subagentLivePreview/);
	assert.doesNotMatch(onNotice({ previewOn: true, hinted: false }), /subagentLivePreview/);
	assert.doesNotMatch(onNotice({ previewOn: undefined, hinted: false }), /subagentLivePreview/, "pi has no such setting");
});

test("footerText reads the event payload; footerOn tells the switch state from the text", () => {
	assert.equal(footerText({ text: "orch: on · quick" }), "orch: on · quick");
	for (const bad of [undefined, null, {}, { text: 3 }]) assert.equal(footerText(bad), undefined);
	assert.equal(footerOn(statusText({ enabled: true, budget: "off" })), true);
	assert.equal(footerOn(statusText({ enabled: false })), false);
});

test("handlesOf keeps only real setting handles; sessionModeState reads the TUI's mode state", () => {
	const handle = { get: () => 1, override() {}, clearOverride() {} };
	const mod = { lookup: (id) => ({ a: handle, b: { get: () => 2 } })[id] };
	assert.deepEqual([...handlesOf(mod, ["a", "b", "c"]).keys()], ["a"]);
	assert.equal(handlesOf({}, ["a"]), undefined, "pi has no settings registry");
	assert.deepEqual(sessionModeState({ sessionModes: { getState: () => ({ plan: true }) } }), { plan: true });
	for (const ctx of [{}, { sessionModes: {} }, undefined]) assert.equal(sessionModeState(ctx), undefined);
});
