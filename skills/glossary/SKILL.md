---
name: glossary
description: "GLOSSARY.md, a repo's domain language: read it for the terms when planning, naming or writing tickets; challenge and update it when a term is unclear, disputed, renamed or newly settled. Use in repos with GLOSSARY.md or GLOSSARY-MAP.md, or when the user asks to start one."
---

# Glossary

`GLOSSARY.md` holds the domain terms of one context (a service, or a bounded area inside one): the
words the code, tickets, BDRs and conversations use for the same concepts. It gives agents and
people one name per concept, so names in code stay consistent and explanations stay short.

Adapted from mattpocock/skills `domain-modeling` (MIT, see `LICENSE`).

## Where it lives

- **One context** (most repos): `GLOSSARY.md` at the repo root.
- **Several contexts**: `GLOSSARY-MAP.md` at the repo root lists each context, the path of its
  `GLOSSARY.md`, and how the contexts relate. When the topic's context is unclear, ask.
- No file yet: create the root `GLOSSARY.md` when the first term is settled, not before.

What goes where:

| Content | Home |
| --- | --- |
| What a term means, and the words to avoid for it | `GLOSSARY.md` |
| A business rule with a rule ID (`BDR-019-R1`) | `docs/bdr/` (bdr skill) |
| A hard-to-reverse technical decision | `docs/adr/` (adr skill) |
| Implementation detail, specs, plans | code, `DEV-NOTE:` anchors, `notes/specs/` |

## Reading

Before planning, naming new types or functions, or writing tickets and PR descriptions in a repo
with a glossary, read it and use its terms. A name in new code that conflicts with a glossary term
is a finding.

## Sharpening the language

While designing with the user:

- **Challenge conflicts.** The user uses a term differently from the glossary → say so at once:
  "The glossary defines *settlement* as X; this sounds like Y. Which is it?"
- **Sharpen fuzzy words.** An overloaded word (*account*, *payment*, *status*) → propose the
  precise term: "Customer account or wallet? They are different things here."
- **Test with scenarios.** Invent concrete edge cases that force a boundary between two concepts
  (a partial refund of a split payment, a retried webhook for a cancelled order).
- **Check the code.** When the user states how something works, check whether the code agrees;
  surface a contradiction with `file:line`.
- **Write it down at once.** Update `GLOSSARY.md` the moment a term is settled, not in a batch at
  the end.

## Format

```md
# <Context name>

<One or two sentences: what this context is and why it exists.>

## Language

**Refund**:
Money returned to the player for a settled payment, in full or in part.
_Avoid_: chargeback, reversal

**Chargeback**:
A payment reversal the card issuer forces on the merchant.
_Avoid_: refund, dispute
```

Rules:

- **Be opinionated.** Several words for one concept → pick one, list the others under `_Avoid_`.
- **One or two sentences per term.** Define what it *is*, not what it does or how it is stored.
- **Domain terms only.** Concepts specific to this context belong; general programming terms
  (timeout, retry, DTO) do not, however often the code uses them.
- **Group under subheadings** once natural clusters appear; a flat list is fine until then.
- **Map relationships** in `GLOSSARY-MAP.md`: which context emits which event to which, which
  types they share.
