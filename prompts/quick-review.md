---
description: Fast light review of uncommitted changes (security, design, tests)
argument-hint: ""
---

Light review of the uncommitted changes — fast pass, not a deep audit. Scope: `git status --porcelain`, `git diff`, `git diff --cached`; changed lines and their immediate context only.

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

Rules: severity first on the line, bold, no list marker and no indent; `<file>:<line>` unspaced and in backticks; at most six findings, highest severity first; silent areas stay silent, `none` under `## Findings` when there is nothing. No summary section, no prose outside the format. `FAIL` means a HIGH finding, `CONCERNS` means fix something before committing, `PASS` means commit is fine. British English (G-7).

Report only. Do not fix, do not commit.
