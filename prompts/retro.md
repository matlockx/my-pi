---
description: Retrospective on a coding session — propose changes to the agent's environment (navigation, checks, steering files, tools) that would have made it go better
argument-hint: "[session id, path or topic; empty = this session]"
---

Run a retrospective on a coding session. Session: $ARGUMENTS (the current session when empty).
The goal is the agent's **environment** for future runs, not the code the session produced.

Adapted from mattpocock/skills `retro` (MIT, licence text in `skills/writing-for-agents/LICENSE`).

1. Read `skill://writing-for-agents` for the writing rules any proposed steering text follows.
2. Read the primary sources of the session. Current session: the conversation itself. Another
   session: find it with the `archive` namespace in eval (recent sessions, recaps, prompt history)
   or `vcc_recall`; read the transcript, not a summary of it. Done when you can name the session's
   goal, its outcome, and every point where the agent went wrong, stalled or was corrected by the
   user.
3. Look for candidates in these categories. Each needs evidence from the session: a quoted
   message, a tool call, a count of retries.
   - **Navigation**: the agent took long to find a file, symbol or fact. Fix: a pointer in the
     repo's AGENTS.md or a skill, a `DEV-NOTE:` anchor, a clearer file layout.
   - **Automated checks**: the agent made a mistake a linter, type check, test or CI job could
     have caught. Read the repo's own check commands first (`Makefile`, `package.json` scripts,
     `.golangci.yml`, `.github/workflows`), so an existing check that is unwired or broken is the
     finding, not a reinvented one. A repo with no guardrail (no pre-commit hook and no CI job
     running lint, type check and tests) is a finding on its own.
   - **Coding standards**: a review missed a mistake. Classify it first. A **mechanical** rule (a
     fixed syntactic pattern, a banned API, an import shape, a file location) becomes a
     deterministic check (a linter rule, a pre-commit hook, a CI job), not prose. Only judgement
     calls go into review guidance (`prompts/quick-review.md`, the review skills).
   - **Steering files**: a line in `~/.omp/agent/AGENTS.md` (my-pi `agents/AGENTS.md`), a repo
     AGENTS.md or a skill that the agent ignored, misread, or followed when it should not have; a
     rule duplicated across files; a repo-specific rule sitting in the global file; a line that is
     a no-op (the model behaves that way by default). Name the file and line.
   - **Tool economy**: expensive or repeated tool calls (full test suites rerun, whole files
     reread, large outputs paged), or a tool or MCP server that is token-inefficient.
   - **Information access**: a fact the agent needed but could not reach (service logs, a
     dashboard, read-only access to a third-party system, a doc in another repo).
4. Report the candidates most severe first, as one table: category, evidence, proposed change
   (file and wording or command), expected effect. Severity is the cost the problem caused in the
   session times how often it will recur. Skip categories with no evidence.
5. Change nothing yet. Ask which candidates to apply, one question at a time (AGENTS.md G-14).
   Apply the chosen ones; leave the commit to the user.
