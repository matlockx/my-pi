---
name: adr
description: Write Architecture Decision Records (ADRs) following the project convention in docs/adr/. Use when making significant architectural, design, or technology decisions that need to be recorded for future reference.
---

## What I do

Guide creation of Architecture Decision Records that capture the context, decision, and consequences of significant architectural choices. Ensures consistency across all ADR documents.

## When to use me

- Making a new architectural or design decision
- Recording a technology choice (library, pattern, protocol)
- Documenting why something was done a certain way (for future developers/agents)
- Reviewing whether an existing ADR is still valid

## ADR Format

Every ADR follows this template:

```markdown
# ADR-NNN: <Short Decision Title>

**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-XXX  
**Date:** YYYY-MM-DD  
**Deciders:** <who made the call>

## Context

What is the issue or force that motivated this decision? What constraints exist?
Describe the problem neutrally — no solution language here.

## Decision

What is the change being proposed or accepted? State it clearly and directly.
"We will use X" / "The service does Y" — not "we should consider".

## Consequences

**Positive:**
- What becomes easier, simpler, faster, safer?

**Negative:**
- What trade-offs are accepted? What's harder now?

**Neutral:**
- Things that change but aren't clearly good or bad.
```

## Rules

1. **One decision per ADR.** Don't bundle unrelated choices.
2. **Number sequentially.** `docs/adr/NNN-short-slug.md`. Check existing files: `ls docs/adr/`.
3. **Immutable once accepted.** Don't edit old ADRs to reflect new reality — write a new one that supersedes.
4. **Context is king.** Future readers need to understand WHY, not just WHAT. Include the alternatives considered and why they lost.
5. **Keep it short.** 1-2 paragraphs per section. No essays.
6. **Link to code.** Reference file paths, function names, or config keys when relevant.
7. **Status transitions:** Proposed → Accepted (team agrees) → Deprecated/Superseded (decision revisited).

## Naming Convention

```
docs/adr/001-short-kebab-case-title.md
docs/adr/002-another-decision.md
```

The number is zero-padded to 3 digits. The slug should be 3-5 words max.

## When NOT to write an ADR

- Trivial implementation choices (variable naming, loop style)
- Bug fixes that don't change architecture
- Dependency version bumps (unless switching libraries entirely)
- Anything that would be a code comment, not a decision record

## Examples of good ADR topics

- Choosing outbox pattern over dual-write
- Single-item-per-refund vs batched refund commands
- SQL-level idempotency guards vs application-level locks
- Terminology boundaries between domains
- Event schema design choices (Avro unions, nullable fields)
- Why a certain state machine transition exists
