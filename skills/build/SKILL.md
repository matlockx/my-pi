---
name: build
description: "Implement a written plan or spec phase by phase, pausing for review after each phase and stopping on any mismatch with the spec; fix a reported bug through a red feedback loop. Use when the user runs /build, hands over a spec or plan from /plan, or asks to fix a bug."
---

# Build: implement a plan phase by phase

Turns a plan into working code one phase at a time. General working rules (testing, `DEV-NOTE:`
anchors, commits, the 300-LOC/3-file confirmation, language skills per file type) come from
AGENTS.md and apply unchanged; this skill adds the spec-driven procedure and a bug-fix loop.

A bug to fix with no plan follows section 6 instead of sections 1–5.

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

## 6. Fixing a bug

For a reported bug, with or without a `/debug` report. Adapted from mattpocock/skills
`diagnosing-bugs` (MIT).

1. **Build a red loop first.** One command that drives the real code path and asserts the
   user's exact symptom: a failing test at the seam that reaches the bug, a `curl` against a local
   service, a CLI run diffed against known-good output, a replayed captured payload, a
   `git bisect run` script. It must be red on this bug, give the same verdict every run, and take
   seconds. Run it and show the command and its output, secrets redacted. Reading code to build a
   theory before this command exists is the failure this step prevents. No loop possible → stop,
   list what was tried, and ask for access, a captured artefact (log dump, HAR, payload) or
   permission for temporary instrumentation.
2. **Minimise.** Cut inputs, config, data and steps one at a time, rerunning the loop after each
   cut, until every remaining element is needed to keep it red.
3. **Rank 3–5 hypotheses** before testing any. Each states its prediction: "if X is the cause,
   changing Y makes the loop go green". Show the ranked list to the user, then continue with the
   top one unless the user re-ranks it.
4. **Instrument one variable at a time.** Prefer the debugger (omp `debug` tool, Delve for Go) to
   logs. Tag every temporary log line with one unique prefix (`[DEBUG-a4f2]`) so cleanup is one
   search. Performance bugs: measure a baseline (benchmark, `pprof`, query plan) before changing
   anything.
5. **Regression test, then fix.** Turn the minimised loop into a failing test at a seam that
   reproduces the real bug pattern, watch it fail, fix the root cause, watch it pass, and rerun
   the original loop. When no seam can reproduce the pattern (the bug needs several callers, the
   only test point is too shallow), say so instead of writing a test that gives false confidence.
6. **Clean up and report.** Search for the debug prefix and remove every hit, delete throwaway
   harnesses, and state the confirmed hypothesis in the summary and the proposed commit message.
