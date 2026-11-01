---
name: bdr
description: Write Business Decision Records (BDRs) following the project convention in docs/bdr/. Use when documenting business rules, domain constraints, product decisions, or external service contracts that govern how features behave — distinct from ADRs which capture technical/architectural choices.
---

## What I do

Guide creation of Business Decision Records that capture the business rules, product constraints, and domain logic rationale behind features. These answer "what is the business rule and why" — complementing ADRs which answer "how did we build it technically."

## When to use me

- Documenting a business rule that governs feature behavior
- Recording why a domain constraint exists (regulatory, product, ops)
- Capturing external service contracts and their implications
- Writing down product scope decisions (what's in, what's out, why)
- Recording lifecycle policies (expiry, cancellation, refund eligibility)
- Explaining domain terminology boundaries

## BDR Format

Every BDR follows this template:

```markdown
# BDR-NNN: <Short Decision Title>

**Status:** Active | Superseded by BDR-XXX | Active, except R2, which BDR-XXX (YYYY-MM-DD) supersedes
**Date:** YYYY-MM-DD
**Source:** <Jira ticket / Confluence link / stakeholder, if known>

## Rule

- **BDR-NNN-R1** — <One testable statement of the rule.>
- **BDR-NNN-R2** — <Next rule of the same decision.>

## Rationale

<Why this decision was made — business constraint, regulatory, UX, ops.>

## Constraints & Edge Cases

<Boundaries, exceptions, known quirks.>

## Observability

<Per rule: how a violation becomes visible — the log line, the audit/history entry, and the
metric, or the automated check that fails. A rule that is an architectural absence (no user
table, no push credential) says so: the absence appearing is the alarm.>
```

Each rule ID (`BDR-NNN-Rn`) is what tests carry in their name (`TestBDR016R1_…`) and what
`DEV-NOTE:` references quote, so keep the `- **BDR-NNN-Rn** —` form exactly; the rule-coverage
checks in the golang and go-service-review skills search for it.

No "Impact on Implementation" section — BDRs document the *what* and *why*, not *where*.
Code references belong in `DEV-NOTE: see <repo>/BDR-NNN` comments at the implementation site.
Always prefix the ID with the owning repo name (e.g. `order-service/BDR-001`), even for records in
the current repo, so cross-repo references are unambiguous.

## Rules

1. **One decision per BDR.** Split it into numbered rules, each testable on its own; don't bundle unrelated decisions.
2. **Number sequentially.** `docs/bdr/NNN-short-slug.md`. Check existing files: `ls docs/bdr/`.
3. **Add it to the index.** Add a row to the table in `docs/bdr/README.md` (`| [NNN](NNN-slug.md) | Title | Status |`), and update the status column of any record it supersedes.
4. **Immutable once active.** Don't edit old BDRs to reflect new reality — write a new one that supersedes. Only rule numbering and an `## Observability` section may be added to an existing record.
5. **Source matters.** Link the origin (Jira, Confluence, Slack thread, stakeholder name) when known.
6. **Keep it short.** 1-2 paragraphs per section. Each rule should be quotable in one breath.
7. **Status transitions:** Active (current truth) → Superseded (new BDR replaces), or partially superseded with the superseded rules named in the status line.

## Naming Convention

```
docs/bdr/001-short-kebab-case-title.md
docs/bdr/002-another-decision.md
```

The number is zero-padded to 3 digits. The slug should be 3-5 words max.

## When NOT to write a BDR

- Pure technical choices (use ADR instead)
- Implementation details that don't reflect a business rule
- Temporary workarounds or hacks
- Anything that's already just a code comment

## BDR vs ADR

| | ADR | BDR |
|---|---|---|
| Answers | "How/why did we build it this way?" | "What is the business rule and why?" |
| Changes when | Tech changes (new pattern, migration) | Business changes (new policy, regulation) |
| Example | "Single item per refund command" | "Spending limits must be reserved before payment" |
| Audience | Engineers choosing implementation | Anyone understanding domain behavior |

## Examples of good BDR topics

- Spending limit reservation policy (when to reserve, commit, rollback)
- Offer validity enforcement timing (re-check at capture, not just checkout)
- Cancellation eligibility rules (which items, which states)
- Chargeback handling policy (lock payouts, don't auto-refund)
- Payment timeout and expiry sweep cadence
- Entry revocation as prerequisite for refund
- Domain terminology boundaries (cancellation vs refund)
- Order-entry separation (commercial product vs gameplay entitlement)
