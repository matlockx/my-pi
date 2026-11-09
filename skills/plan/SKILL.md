---
name: plan
description: "Plan a change before building it: research the code, compare approaches, challenge the plan, and produce phases that /build can implement. Changes no files except the spec it stores. Use when the user runs /plan or asks for a plan, design or spec."
---

# Plan: research, decide, challenge, hand over

Produces a plan the user approves and `/build` implements. General rules (asking one question at
a time with a recommendation, G-14) come from AGENTS.md and apply here in full.

## Ground rules

- **Read-only.** Use `read`, `grep`, `glob`, `lsp`, `web_search` and read-only shell commands
  (`git log`, `git diff`, `git show`, `go list`, `rg`). No `edit`, no `write` except the spec
  file in section 5, no installs, builds, test runs or commits. For a session where read-only is
  enforced by the harness, the user can switch on omp's plan mode (`Alt+Shift+P`).
- **Delegate broad exploration** (where things live, how they work, similar implementations) to a
  read-only `scout` task; read the files that matter yourself.
- **Ask instead of assuming** business rules, intent or scope.

## 1. Understand

1. Restate the goal in one or two sentences: what should be true when the work is done.
2. Research the current state: the code involved, its tests, `DEV-*` anchors, decision records
   (`docs/bdr`, `docs/adr`), the domain terms in `GLOSSARY.md` (glossary skill), and existing
   plans in `notes/specs/`.
3. Ask the questions the code cannot answer, one at a time, the question that blocks the most
   work first. Word each so that "yes" accepts the recommendation. Facts are not questions: look
   them up (a `scout` task for broad searches) instead of asking the user.

## 2. Design

1. Break the work into phases that each leave the system working and verifiable.
2. Name the constraints: API and event contracts, migrations, decision records, consumers of
   metrics and payloads, tests that pin behaviour.
3. For non-trivial work, compare at least two approaches with their costs, and choose one.
4. Map what changes together and what else is affected (callers, other repositories,
   dashboards and alerts).

## 3. Challenge

Before presenting, attack the plan once and fold valid objections in:

- What fails, and how would anyone notice?
- Which assumption, if wrong, breaks it?
- Is there a simpler, more boring way?
- What does it break or migrate?
- What is built that nothing needs yet?

## 4. Present

```markdown
## Plan: <title>

### Goal
<what is true when done, and why it matters>

### Approach
<chosen approach and why it wins over the alternatives>

### Phases
- [ ] **Phase 1 — <title>**
  - Files: <paths>
  - Change: <what>
  - Verify: <command or observable result>
  - Risk: <low | medium | high, and why>

### Alternatives not taken
- <alternative>: <why it loses>

### Risks
- <risk>: <mitigation or detection>

### Done when
- <observable success criteria>
```

Open decisions go to the user as G-14 questions, one at a time, before the plan is final.

## 5. Store it

Ask once, with a recommendation:

- **Spec file** `notes/specs/YYYY-MM-DD-<slug>.md` with front matter `work_state: ready` (or
  `draft` while decisions are open). Recommended when the work spans sessions or several
  phases: `/build` reads it in a fresh session and other machines get it through git.
- **Keep it in the conversation.** Enough when `/build` follows right away in this session; loses
  for anything longer, because a new session no longer has it.

Beads tasks only when the user asks for beads (AGENTS.md).

## Revising a plan

Read the existing spec in full, restate the requested changes, research only what they need,
present the updated plan, and store it the same way. Feedback such as "not right yet" returns to
section 2 and runs the challenge again.
