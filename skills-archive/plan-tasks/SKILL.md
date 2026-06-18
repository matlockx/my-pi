---
name: plan-tasks
description: "Planning tasks for a code change. Opus explores the codebase and emits a set of self-contained beads tasks that a small local model can execute mechanically with minimal further reasoning."
---

# plan-tasks

Planning-only mode. Explore the codebase, design the full solution, and emit a
set of self-contained beads tasks that a small local model (e.g. Qwen3-Coder-30B)
can execute mechanically with minimal further reasoning.

## Usage

`/plan-tasks <description of the feature/change>`

Example:
`/plan-tasks add a DELETE /orders/{id}/cancel endpoint that cancels the order and emits an OrderCancelledEvent`

## Instructions for Opus (planner)

You are in PLANNING mode. Do NOT write or edit implementation code yourself.
Your only output is exploration + a set of beads tasks.

### 1. Explore efficiently

- Batch independent reads/searches into a single turn (multiple tool calls
  in parallel) rather than one file per turn.
- Identify: existing patterns to mirror (similar endpoints/handlers/repos),
  exact types/structs/interfaces involved, relevant module versions
  (check go.mod / package.json etc.), test conventions, and any codegen'd
  types that must be used as-is.
- Stop exploring once you have enough to write unambiguous instructions.
  Do not over-explore "for completeness" — every extra turn costs cache.

### 2. Make every decision now

The executor model has:
- No memory of this conversation
- Limited reasoning / cannot resolve ambiguity or tradeoffs
- Cannot explore beyond the files you point it to

So for each task, resolve ALL of:
- Exact function/method/struct/field names and signatures
- Exact import paths
- Exact error handling / logging / wrapping conventions (cite the pattern
  source file + line range)
- Exact location to insert new code (file + nearby anchor, e.g. "after the
  Create method in internal/repository/order/order.go")
- Naming conventions already used in the codebase

If a step requires judgment (architecture choice, which existing pattern to
follow when multiple exist, error-handling strategy), YOU decide and document
the decision and rationale in the task — never leave it open for the executor.

### 3. Output format — one beads task per step

For each task, output:

```yaml
id: <short-id, e.g. ORD-1>
title: <one line>
depends_on: [<task ids>]   # empty list if none
files:
  - path: <exact file path>
    action: create | edit
context_files:             # files the executor should read for patterns, NOT modify
  - <file path>: <why — e.g. "mirror the Create method pattern, lines 40-65">
instructions: |
  <Step-by-step, imperative, unambiguous instructions. Include:
   - exact code to write where it's simple/mechanical (struct fields, imports,
     function signatures)
   - exact insertion point ("add after line X" / "after function Y")
   - exact naming for every new identifier
   - any constants/values to use verbatim
   This should read like a precise diff description, not a design brief.>
acceptance_check: |
  <How to verify, e.g. "go build ./... succeeds" / "go test ./internal/repository/order/... passes"
   / "curl -X DELETE localhost:8080/orders/123/cancel returns 204">
notes: |
  <Optional: anything genuinely tricky the executor should be careful about,
   or "Opus should review this step's output before proceeding" if the change
   is high-risk (schema/contract changes, cross-service effects).>
```

### 4. Task granularity

- Default: one file per task, one logical change per task.
- Split a file into multiple tasks only if changes are independent and could
  be done in parallel/different order.
- Order tasks via `depends_on` so the executor (or a runner script) can
  process them in dependency order.

### 5. Sizing the plan itself

- Keep total exploration turns proportional to the task's actual complexity —
  a small endpoint addition shouldn't need 60 turns of exploration.
- The plan should be detailed enough that the executor needs ZERO follow-up
  questions for "mechanical" tasks (CRUD, boilerplate, simple handlers).
- Flag (in `notes`) any task touching: event schemas/codegen, cross-service
  contracts, concurrency, migrations, or security-sensitive code — these
  should note "recommend Opus review before/after this step" since small
  models are unreliable here.

### 6. Final output

After listing all tasks, output a short summary:
- Total tasks, dependency order
- Which tasks (if any) are flagged for Opus review
- Any open questions for the human (should be rare/none for well-scoped requests)

Then STOP. Do not implement anything.
