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

**Status:** Active | Removed
**Version:** 1
**Date:** YYYY-MM-DD (last change)
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

## Changelog

<Optional. One brief line per bigger change, newest first:
`- v3 (YYYY-MM-DD): R2 removed, refunds are manual again (STAR-123).`>
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
3. **Add it to the index.** Add a row to the table in `docs/bdr/README.md` (`| [NNN](NNN-slug.md) | Title | Status |`).
4. **Change in place, bump the version.** A changed business decision is edited into the existing record; never write a new record that supersedes it. Increment `**Version:**` and set `**Date:**` with every change, typo fixes included. Bigger changes (a rule added, changed in meaning, or removed) get one brief line in `## Changelog`; the full diff lives in git. Update the tests and `DEV-NOTE:` references of every changed rule in the same change.
5. **Source matters.** Link the origin (Jira, Confluence, Slack thread, stakeholder name) when known.
6. **Keep it short.** 1-2 paragraphs per section. Each rule should be quotable in one breath.
7. **Removing.** A removed rule keeps its line with the ID unbolded, so rule-coverage checks no longer count it: `- BDR-NNN-R2 — Removed (v4): <reason>.` A removed record keeps its file and number, its content is replaced by `Removed (vN): <reason>.`, `**Status:**` becomes `Removed` (also in the index), and the version is bumped. Delete or rename the tests of removed rules. IDs are never reused; a new rule gets the next unused number.
8. **Migrate legacy supersede chains when touched.** Older records may still supersede each other. When a change touches a record that supersedes, or is superseded by, another, migrate the chain in the same change: the superseding record keeps its rules and IDs (so its tests keep their names), drops the "supersedes" wording from its status, and gets `**Version:**` (records without one count as v1). Each superseded rule in the older record becomes `- BDR-OLD-Rn — Removed (vN): replaced by BDR-NEW-Rm.`; a fully superseded record becomes `Removed (vN): replaced by BDR-NEW.` with `**Status:** Removed`. Status becomes `Active` or `Removed` in the files and the index. Add one `## Changelog` line per migrated record.

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
