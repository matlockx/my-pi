import test from "node:test";
import assert from "node:assert/strict";

import {
	applyBreakChoice,
	approveExtra,
	BREAK_OPTIONS,
	builderBudget,
	continueBudget,
	PAUSE_FACTOR,
	pauseDecision,
	QUICK_BUDGET_USD,
	decideSpawn,
	followUpBreak,
	freeAgents,
	guardToolCall,
	leadBashAllowed,
	MAX_REPLANS,
	newRun,
	planDialog,
	recordMessage,
	recordSpawn,
	replan,
	reviseTaskInput,
	runFooter,
	runSummary,
} from "./gate.mjs";
import { ORCHESTRATOR_AGENTS } from "./state.mjs";

const spawn = (run, agent) => decideSpawn({ enabled: true, run, agent, orchestratorAgents: ORCHESTRATOR_AGENTS });
const lead = (toolName, input) => guardToolCall({ enabled: true, agent: { kind: "main", name: "main" }, toolName, input });

test("no subagent starts before route, and lane answer starts none", () => {
	assert.match(spawn(undefined, "implementer").reason, /route first/);
	assert.match(spawn(newRun("r", "answer"), "scout").reason, /answer runs no subagent/);
});

test("quick: one free implementer, no planner, no QA or guardian", () => {
	let run = newRun("r", "quick");
	assert.equal(spawn(run, "planner").allow, false);
	assert.equal(spawn(run, "implementer").allow, true);
	run = recordSpawn(run, "implementer", "B1");
	assert.match(spawn(run, "implementer").reason, /No free implementer.*request_agents/);
	assert.equal(spawn(run, "qa").allow, false);
	assert.equal(spawn(run, "guardian").allow, false);
});

test("a refused spawn names the agents still free, so an unnamed task item can be corrected", () => {
	const run = newRun("r", "build", "clear");
	assert.deepEqual(freeAgents(run), ["implementer", "guardian"]);
	assert.match(spawn(run, "task").reason, /No free task in this run \(0 started\)\. Free now: implementer, guardian \(set agent on the task item\)/);
	assert.equal(spawn(run, "constructor").allow, false, "a prototype key is no agent");
	const used = recordSpawn(recordSpawn(recordSpawn(run, "implementer", "B1"), "qa", "Q1"), "guardian", "G1");
	assert.deepEqual(freeAgents(used), []);
	assert.doesNotMatch(spawn(used, "scout").reason, /Free now/);
});

test("plan: one free planner; the implementer waits for plan approval", () => {
	let run = newRun("r", "plan");
	assert.equal(spawn(run, "planner").allow, true);
	run = recordSpawn(run, "planner", "A1");
	assert.equal(spawn(run, "planner").allow, false);
	assert.match(spawn(run, "implementer").reason, /approve_plan/);
	run = { ...run, planApproved: true };
	assert.equal(spawn(run, "implementer").allow, true);
});

test("build: one QA per Builder round, fix rounds counted from follow-ups to the Builder only", () => {
	let run = recordSpawn(newRun("r", "build"), "implementer", "B1");
	assert.equal(spawn(run, "qa").allow, true);
	run = recordSpawn(run, "qa", "Q1");
	assert.equal(spawn(run, "qa").allow, false);
	run = recordMessage(run, "agent://Q1");
	assert.equal(spawn(run, "qa").allow, false, "a message to QA is not a Builder round");
	run = recordMessage(run, "agent://B1");
	assert.equal(spawn(run, "qa").allow, true);
	assert.equal(spawn(run, "guardian").allow, true);
});

test("QA rounds are capped at three Builder rounds", () => {
	let run = recordSpawn(newRun("r", "build"), "implementer", "B1");
	for (let i = 0; i < 4; i++) run = recordMessage(run, "agent://B1");
	for (let i = 0; i < 3; i++) run = recordSpawn(run, "qa", `Q${i}`);
	assert.equal(spawn(run, "qa").allow, false);
});

test("extra agents start only after the user approved them, one per approval", () => {
	let run = recordSpawn(newRun("r", "quick"), "implementer", "B1");
	assert.equal(spawn(run, "scout").allow, false);
	run = approveExtra(run, "scout", 1);
	assert.equal(spawn(run, "scout").allow, true);
	run = recordSpawn(run, "scout", "S1");
	assert.equal(spawn(run, "scout").allow, false);
	run = approveExtra(run, "implementer", 1);
	assert.equal(spawn(run, "implementer").allow, true);
});

test("replan keeps the run, frees one planner, resets plan approval, and stops after MAX_REPLANS", () => {
	let run = { ...recordSpawn(newRun("r", "plan"), "planner", "A1"), planApproved: true };
	let next = replan(run, "plan", "Builder found a second service", "builder");
	run = next.run;
	assert.equal(run.planApproved, false);
	assert.equal(spawn(run, "planner").allow, true);
	assert.deepEqual(run.replans, [{ from: "plan", to: "plan", trigger: "builder", reason: "Builder found a second service" }]);
	for (let i = 1; i < MAX_REPLANS; i++) run = replan(run, "plan", "again").run;
	assert.match(replan(run, "plan", "once more").error, /replanned 2 times/);
});

test("switch off: only the orchestrator agents are refused, nothing is guarded for the Lead", () => {
	assert.equal(decideSpawn({ enabled: false, run: undefined, agent: "scout", orchestratorAgents: ORCHESTRATOR_AGENTS }).allow, true);
	assert.match(decideSpawn({ enabled: false, run: undefined, agent: "qa", orchestratorAgents: ORCHESTRATOR_AGENTS }).reason, /orchestrator mode/);
	assert.equal(guardToolCall({ enabled: false, agent: { kind: "main" }, toolName: "edit", input: {} }), undefined);
	assert.equal(guardToolCall({ enabled: false, agent: { kind: "main" }, toolName: "bash", input: { command: "rm -rf x" } }), undefined);
});

test("Lead: edit, ast_edit, eval blocked; write only to the allowed schemes", () => {
	for (const tool of ["edit", "ast_edit", "eval"]) assert.equal(lead(tool, {}).block, true, tool);
	for (const path of ["xd://memory_save", "local://plan.md", "out://x.md", "agent://Builder", "proc://Builder/kill"]) {
		assert.equal(lead("write", { path }), undefined, path);
	}
	for (const path of ["src/a.go", "/tmp/x", "proc://Builder", "xd://ast_edit"]) assert.equal(lead("write", { path }).block, true, path);
	assert.equal(lead("read", { path: "src/a.go" }), undefined);
	assert.equal(lead("jflow_commit", {}), undefined);
});

test("Lead bash: single git and gate commands only", () => {
	for (const ok of ["git status", "git -C /r diff --stat", "git commit -m 'fix: a; b | c'", "git push", "crapper --threshold 10 a.go", "dryer --threshold 0.8", "go test -cover ./..."]) {
		assert.equal(leadBashAllowed(ok), true, ok);
	}
	for (const bad of ["git checkout main", "git reset --hard", "rm -rf x", "git status && rm x", "git log | head", "git diff > p.patch", 'git commit -m "$(cat f)"', "git commit -m `id`", "dryer --help", "ls", ""]) {
		assert.equal(leadBashAllowed(bad), false, bad);
	}
	assert.match(lead("bash", { command: "npm test" }).reason, /git status\|diff/);
});

test("subagents: planner writes local:// only; qa never edits; the implementer is unguarded", () => {
	const sub = (name, toolName, input) => guardToolCall({ enabled: true, agent: { kind: "sub", name }, toolName, input });
	assert.equal(sub("planner", "write", { path: "local://plan.md" }), undefined);
	assert.equal(sub("planner", "write", { path: "src/a.go" }).block, true);
	for (const tool of ["edit", "ast_edit", "write"]) assert.equal(sub("qa", tool, { path: "a.go" }).block, true, tool);
	assert.equal(sub("qa", "bash", { command: "git apply /p.patch" }), undefined);
	assert.equal(sub("implementer", "edit", { path: "a.go" }), undefined);
	assert.equal(sub("scout", "write", { path: "a.go" }), undefined);
});

test("planDialog warns above $50 unless budget is off", () => {
	assert.equal(planDialog({ summary: "S", estimateUsd: 60, budget: "on" }).overThreshold, true);
	assert.match(planDialog({ summary: "S", estimateUsd: 60, budget: "on" }).title, /\$60\.00\. Above the \$50 threshold/);
	assert.equal(planDialog({ summary: "S", estimateUsd: 60, budget: "off" }).overThreshold, false);
	assert.equal(planDialog({ summary: "S", estimateUsd: 10, budget: "on" }).overThreshold, false);
	assert.match(planDialog({ summary: "S", estimateUsd: undefined, budget: "on" }).title, /No estimate/);
});

test("quick lane: QA starts only when a trigger fired on the Builder's round", () => {
	const run = recordSpawn(newRun("r", "quick"), "implementer", "B1");
	assert.match(spawn(run, "qa").reason, /not required in lane quick/);
	assert.equal(decideSpawn({ enabled: true, run, agent: "qa", orchestratorAgents: ORCHESTRATOR_AGENTS, qaDue: true }).allow, true);
});

test("reviseTaskInput isolates implementer and qa items and hands QA the latest patch", () => {
	const batch = { context: "c", tasks: [{ agent: "implementer", task: "do" }, { agent: "qa", task: "review" }, { agent: "scout", task: "look" }] };
	const { input } = reviseTaskInput(batch, "/a/B.round-2.patch");
	assert.deepEqual(input.tasks.map((t) => [t.agent, t.isolated]), [["implementer", true], ["qa", true], ["scout", undefined]]);
	assert.match(input.tasks[1].task, /review\n\nPatch to review.*\/a\/B\.round-2\.patch/);
	assert.equal(reviseTaskInput({ agent: "implementer", task: "do" }, undefined).input.isolated, true);
	assert.match(reviseTaskInput({ agent: "qa", task: "r" }, undefined).reason, /No Builder round patch/);
	const plain = { tasks: [{ agent: "scout", task: "look" }] };
	assert.equal(reviseTaskInput(plain, undefined).input, plain);
});

test("followUpBreak: replan request, pause, round cap and no progress each open the dialog", () => {
	const run = recordSpawn(newRun("r", "build"), "implementer", "B1");
	assert.equal(followUpBreak(run, {}), undefined);
	assert.equal(followUpBreak(run, { status: "needs_replan" }).level, "scope");
	assert.equal(followUpBreak(run, { status: "paused" }).level, "budget");
	assert.equal(followUpBreak(run, { noProgress: "identical patch" }).level, "progress");
	const spent = recordMessage(recordMessage(run, "agent://B1"), "agent://B1");
	assert.match(followUpBreak(spent, {}).reason, /3 Builder rounds/);
});

test("applyBreakChoice: another round past the cap grants one round and one QA; other choices block with the next step", () => {
	let run = recordSpawn(newRun("r", "build"), "implementer", "B1");
	run = recordMessage(recordMessage(run, "agent://B1"), "agent://B1");
	const brk = followUpBreak(run, {});
	const more = applyBreakChoice(run, brk, BREAK_OPTIONS[0]);
	assert.equal(more.block, undefined);
	assert.equal(followUpBreak(more.run, {}), undefined);
	assert.equal(more.run.approvedExtra.qa, 1);
	assert.deepEqual(more.run.loopBreaks, [{ level: "rounds", reason: brk.reason, decision: BREAK_OPTIONS[0] }]);
	assert.match(applyBreakChoice(run, brk, BREAK_OPTIONS[1]).block.reason, /apply_change/);
	assert.match(applyBreakChoice(run, brk, BREAK_OPTIONS[2]).block.reason, /replan: true/);
	assert.match(applyBreakChoice(run, brk, BREAK_OPTIONS[3]).block.reason, /proc:\/\/<id>\/kill/);
	assert.match(applyBreakChoice(run, brk, undefined).block.reason, /closed the dialog/);
});

test("builderBudget: $5 in quick, the approved estimate in plan, the $50 threshold for build without a plan", () => {
	assert.equal(builderBudget(newRun("r", "quick")), QUICK_BUDGET_USD);
	assert.equal(builderBudget({ ...newRun("r", "plan"), planApproved: true, estimateUsd: 12 }), 12);
	assert.equal(builderBudget(newRun("r", "build")), 50);
	assert.equal(builderBudget({ ...newRun("r", "plan"), estimateUsd: 0 }), 50);
});

test("pauseDecision blocks every tool but yield from 1.5x the budget, and never with budget off", () => {
	const at = (costUsd, toolName = "edit", budget = "on") => pauseDecision({ costUsd, limitUsd: 10, budget, toolName });
	assert.equal(PAUSE_FACTOR, 1.5);
	assert.equal(at(14.99), undefined);
	assert.match(at(15).reason, /Budget pause.*\$15\.00.*\$10\.00.*status paused/);
	assert.equal(at(40, "yield"), undefined);
	assert.equal(at(40, "edit", "off"), undefined);
	assert.equal(pauseDecision({ costUsd: 40, limitUsd: undefined, budget: "on", toolName: "edit" }), undefined);
});

test("continueBudget: spent plus the Builder's remaining estimate, else plus the previous budget", () => {
	assert.equal(continueBudget(15, 4, 10), 19);
	assert.equal(continueBudget(15, Number.NaN, 10), 25);
	assert.equal(continueBudget(15, 0, 10), 25);
});

test("runSummary carries lane, estimate, rounds, verdicts and outcome; runFooter shows lane and Builder cost", () => {
	let run = recordSpawn({ ...newRun("r", "plan", "two approaches"), planApproved: true, estimateUsd: 12 }, "implementer", "B1");
	assert.deepEqual(
		(({ lane, estimateUsd, builderRounds, qaVerdicts, outcome, pipelineVersion }) => ({ lane, estimateUsd, builderRounds, qaVerdicts, outcome, pipelineVersion }))(runSummary(run, { pipelineVersion: "v1", qaVerdicts: ["FAIL", "PASS"] })),
		{ lane: "plan", estimateUsd: 12, builderRounds: 1, qaVerdicts: ["FAIL", "PASS"], outcome: "open", pipelineVersion: "v1" },
	);
	run = { ...run, outcome: "applied" };
	assert.equal(runSummary(run, { pipelineVersion: "v1", qaVerdicts: [] }).outcome, "applied");
	assert.equal(runSummary(newRun("a", "answer"), { pipelineVersion: "v", qaVerdicts: [] }).outcome, "answered");
	assert.equal(runFooter(run, { costUsd: 3.5, limitUsd: 12 }), "plan · builder $3.50 / $12.00");
	assert.equal(runFooter(newRun("q", "quick"), { costUsd: undefined, limitUsd: undefined }), "quick");
	assert.equal(runFooter(undefined, {}), undefined);
});
