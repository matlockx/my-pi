---
description: Fast light review of uncommitted changes, or of unpushed commits when the tree is clean (security, design, tests)
argument-hint: ""
---

Light review — fast pass, not a deep audit.

Pick the scope first:

1. Run `git status --porcelain`. If it lists tracked changes, review the uncommitted work: `git diff`, `git diff --cached`.
2. If the tree is clean, review the commits ahead of the upstream main: `git fetch origin` (skip on failure and say so), then `git log --oneline origin/main..HEAD` and `git diff origin/main...HEAD`. State the scope in one line before the verdict, e.g. `Scope: 3 commits ahead of origin/main`.
3. Nothing in either — reply `VERDICT: PASS` with `none` under `## Findings` and omit the commit message section.

Changed lines and their immediate context only.

Check, in this order: **security** (secrets, unvalidated input at a trust boundary, injection, missing authn/authz, PII in logs) · **correctness** (swallowed errors, nil deref, unchecked assertion, missing `defer Close/Rollback`, context not propagated, unsynchronised shared state) · **design and scope** (changes beyond the request, logic already in the repo, one-implementation abstraction, contradicted `docs/bdr/` rule) · **tests** (new behaviour tested, `TestBDR###R#` for record rules, assertions not weakened).

Reply with exactly this shape, as markdown, nothing else. Only the commit message is fenced;
the rest is plain markdown so the terminal renders it:

**VERDICT: PASS | CONCERNS | FAIL**

## Findings

**<HIGH|MED|LOW>** `<file>:<line>` — <finding, one line> → <fix, one line>

## Commit message

```text
<type>(<scope>): <subject, imperative, max 72 chars>

<body: 2-4 lines, wrapped at 72, omitted for a one-line fix>
```

Omit the `## Commit message` section when the scope is already-committed work; there is nothing to commit.

Rules: severity first on the line, bold, no list marker and no indent; `<file>:<line>` unspaced and in backticks; at most six findings, highest severity first; silent areas stay silent, `none` under `## Findings` when there is nothing. No summary section, no prose outside the format. `FAIL` means a HIGH finding, `CONCERNS` means fix something before committing, `PASS` means commit is fine. British English (G-7).

Report only. Do not fix, do not commit.
