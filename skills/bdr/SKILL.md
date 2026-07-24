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

**Status:** Active | Superseded by BDR-XXX
**Date:** YYYY-MM-DD
**Source:** <Jira ticket / Confluence link / stakeholder, if known>

## Rule

<One-paragraph statement of the business rule or product decision.>

## Rationale

<Why this decision was made — business constraint, regulatory, UX, ops.>

## Constraints & Edge Cases

<Boundaries, exceptions, known quirks.>

```

No "Impact on Implementation" section — BDRs document the *what* and *why*, not *where*.
Code references belong in `DEV-NOTE: see BDR-NNN` comments at the implementation site.

## Rules

1. **One rule per BDR.** Don't bundle unrelated business decisions.
2. **Number sequentially.** `docs/bdr/NNN-short-slug.md`. Check existing files: `ls docs/bdr/`.
3. **Immutable once active.** Don't edit old BDRs to reflect new reality — write a new one that supersedes.
4. **Source matters.** Link the origin (Jira, Confluence, Slack thread, stakeholder name) when known.
5. **Keep it short.** 1-2 paragraphs per section. The rule section should be quotable in one breath.
7. **Status transitions:** Active (current truth) → Superseded (new BDR replaces).

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
