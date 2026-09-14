---
description: Fast light review of uncommitted changes (security, design, tests)
argument-hint: ""
---

Do a **light** review of the uncommitted changes — the fast pass, not the deep audit. Budget: a few minutes, no exhaustive file walks, no refactoring proposals.

Scope: `git status --porcelain` plus `git diff` and `git diff --cached`. Only the changed lines and their immediate context.

Check exactly these four areas, in this order:

1. **Security** — hardcoded secrets or tokens, unvalidated input crossing a trust boundary, SQL/command string building, missing authn/authz on a new route, secrets or PII in logs.
2. **Correctness risk** — unhandled or swallowed errors, ignored `err`, nil dereference, unchecked type assertion, missing `defer Close/Rollback`, `context.Context` not propagated, goroutine without cancellation or wait, shared state written without a lock.
3. **Design and scope** — changes beyond what was requested, duplicated logic that already exists elsewhere in the repo, a new abstraction with one implementation, business rule contradicting a `docs/bdr/` record.
4. **Test coverage** — every new or changed function with behaviour has a test in this change; decision-record rules have a `TestBDR###R#`-style test; assertions were not weakened to make code pass.

Report format — nothing else:

```text
VERDICT: PASS | CONCERNS | FAIL

<severity> <file>:<line> — <finding, one line> → <fix, one line>
```

Severity is `HIGH`, `MED`, or `LOW`. List at most eight findings, highest severity first. No findings in an area means that area is silent — do not write "looks good" lines. Close with one line naming anything you deliberately did not inspect.

`PASS` means nothing blocks a commit. `CONCERNS` means commit is possible but a named issue should be fixed first. `FAIL` means a HIGH finding is present.

After the findings, close with two blocks:

**Summary** — two or three lines: what the change does, and the one thing to watch.

**Commit message** — Conventional Commits style, ready to paste:

```text
<type>(<scope>): <subject, imperative, max 72 chars>

<body: 2-4 lines on what changed and why, wrapped at 72 chars>
```

Omit the body only when the change is a one-line fix. Never write a body longer than four lines. British English (G-7).

Do not fix anything and do not commit — the commit message is a proposal. Report only, then stop and wait for approval.
