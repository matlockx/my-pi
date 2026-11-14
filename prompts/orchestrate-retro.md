---
description: Guardian retro — audit the most expensive unreviewed sessions, rank open findings by cost x recurrence, and decide improvements one at a time
argument-hint: "[window, e.g. last:14d; empty = last:30d]"
---

Run the Guardian retro over $ARGUMENTS (`last:30d` when empty). The goal is cheaper and better
runs of the orchestration pipeline and of the tasks themselves, decided by the user from evidence.

1. Read the ledger with `usage_report`:
   - `view: "findings"` for the open findings, ranked by cost x recurrence;
   - `view: "improvements"` for the decisions so far and their measured effect;
   - `view: "runs"`, `groupBy: ["pipelineVersion"]`, then `["lane"]`, for cost per prompt, the
     orchestrated runs table (estimate vs actual, QA first pass, rounds, loop breaks, rating).
2. Audit sessions run with orchestrator mode off, which no Guardian has seen yet:
   - From `view: "runs"`, `groupBy: ["mode", "project"]`, take the 10 most expensive prompts with
     mode `off` that no finding's run ids cover.
   - Before starting, tell the user how many audits that is and the cost cap: about $0.40 per audit
     (Guardian on Sonnet, low thinking). Ask once whether to go on (G-14), with the number and cap.
   - Start one `guardian` per session (batch them in one `task` call). Its task names the run ids and
     the session log path (`~/.omp/agent/sessions/**/<timestamp>_<sessionId>.jsonl`, find it with
     `glob`), and says: audit the turns of these run ids, copy the run ids into `runIds`.
   - Then read `view: "findings"` again.
3. Propose improvements, strongest first, from the open findings plus what the figures show (an
   estimate ratio far from 1, a lane with a low QA first-pass rate, a role whose cost dominates).
   Each proposal names: the findings it answers (ids), the change (file and wording, setting and
   value, or a check to add), its scope (`pipeline` or `task` with the project), and the effect to
   expect. Compare against earlier improvements: a change already tried shows its measured effect.
4. Ask about one proposal at a time (AGENTS.md G-14): apply, reject or defer, with a
   recommendation. After each answer:
   - call `guardian_decision` with the finding ids, the decision, the change and the reason;
   - apply an approved change to the files it names (persona files in `agents/`, `extensions/orchestrator/lead.md`,
     steering files, settings). Follow `skill://writing-for-agents` for any steering text.
5. End with a short list: decisions made, files changed, findings left open. Leave the commit to the
   user.
