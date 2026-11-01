---
name: build
description: "Implement a written plan or spec phase by phase, pausing for review after each phase and stopping on any mismatch with the spec. Use when the user runs /build or hands over a spec or plan from /plan."
---

# Build: implement a plan phase by phase

Turns a plan into working code one phase at a time. General working rules (testing, `DEV-NOTE:`
anchors, commits, the 300-LOC/3-file confirmation, language skills per file type) come from
AGENTS.md and apply unchanged; this skill adds only the spec-driven procedure.

## 1. Load the plan

The plan is one of: a spec file (`notes/specs/*.md` or a path the user gives), a plan from
`/plan` earlier in the conversation, or the user's inline phase list.

1. Read it completely, without line limits.
2. Spec files carry YAML front matter. `work_state: draft` means it was not approved: say so and
   ask whether to proceed or to finish it with `/plan` first.
3. Read every file the plan names, and search the affected directories for `DEV-*` anchors.
4. Check the plan against the code as it is now. Anything that no longer matches (renamed files,
   changed signatures, work already done) is a mismatch (section 4) before any code is written.
5. Create one todo per phase, in plan order.

## 2. Implement one phase

For each phase, in order:

1. Load the language skill for each file type the phase touches (AGENTS.md "Skill Auto-Loading").
2. Make the changes the phase lists, nothing outside them.
3. Run the phase's verification: the plan's success criteria, the repository's check/test
   targets, and the tests for the code changed in the phase.
4. Mark the phase's todo done only when its verification passed.

## 3. Pause after each phase

Unless the user said to run all phases, stop after each one:

```
Phase <N> done: <one line on what changed>.
Verified: <commands run and their result>.
Not verified: <what could not be run here, and why>.

Continue with phase <N+1>: <its title>?
```

## 4. Mismatches stop the build

When the code, a test, or a constraint contradicts the plan, do not improvise a different design:

```
Phase <N> does not match the code:
Plan says: <quote>
Found: <what is actually there, with file:line>
Why it matters: <consequence of following the plan as written>
Options: <a) …  b) …, with a recommendation>
```

Wait for the answer. A small, obviously-equivalent adjustment (a renamed variable, a moved file
the plan clearly means) may proceed, but is reported in the phase summary.

## 5. Finish

After the last phase: run the full relevant test suite once, update the spec's front matter to
`work_state: done` when it is a spec file, summarise the phases with their verification, and
propose a commit message. Nothing is committed without the user's approval.
