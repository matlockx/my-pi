---
name: writing-for-agents
description: "Writing documents an agent reads: skills (SKILL.md and their reference files), prompts in my-pi/prompts, AGENTS.md, and docs an agent reaches by a pointer. Use when creating, editing, pruning or reviewing one of them."
---

# Writing for agents

Reference for any document an agent consumes. The packaging differs (skill, prompt, `AGENTS.md`,
a doc behind a pointer); the writing does not. The aim is a document that makes the agent take the
same *process* on every run, not one that produces the same output.

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills/tree/4ae2317/skills/productivity/writing-for-agents)
(`writing-for-agents`, MIT, see `LICENSE`), reworded for omp and my-pi.

## Where each document lives, and what it costs

| Document | Loaded | Cost |
| --- | --- | --- |
| `agents/AGENTS.md` (symlinked as `~/.omp/agent/AGENTS.md`) | every turn, in full | highest: every line, every session |
| Skill `description` in `skills/<name>/SKILL.md` | every session, in the skill listing (about 80 tokens per skill) | permanent, even when the skill never fires |
| Skill body and its sibling files | when the agent or the user opens the skill | only when used |
| Prompt in `prompts/<name>.md` | only when the user types `/<name>` | none for the agent; the user has to remember it exists |
| Doc reached by a pointer | when the pointer fires | the pointer's line only |

## Context pointers

A **context pointer** is a line in the agent's context that names out-of-context material and the
condition for reaching it. A skill description is one; a line in `AGENTS.md` naming a file is the
same object. The pointer's *wording*, not its target, decides when the agent reaches the material
and how reliably. A must-have target behind a weakly worded pointer is a variance bug: sharpen the
wording first, inline the material only if sharpening fails.

A pointer does two jobs: say what the material is, and list the **branches** that should trigger
it (a branch is a distinct case the document handles). Every word of an always-loaded pointer costs
on every turn, so prune it harder than the body:

- **Front-load the leading word**: the start of the pointer does the triggering.
- **One trigger per branch.** Synonyms renaming one branch are that branch written twice; keep one.
- **Cut identity the body already carries.**

## The two loads

- **Context load**: always-loaded material (an `AGENTS.md` line, a skill description) spends tokens
  and attention on every turn, whether or not it fires.
- **Cognitive load**: the human has to know which documents exist and when to reach for each.
  Spend it where human judgement matters (a prompt the user deliberately runs), remove it where it
  does not.

Material behind a pointer escapes context load at the price of the pointer's own line; material
with no pointer at all rides entirely on cognitive load.

## Skill or prompt

- **Skill with a description** (model-invoked): the agent can open it on its own, and other skills
  can point at it. Pays permanent context load for that reach. Write the description for the model:
  the trigger branches, nothing else.
- **Prompt** (user-invoked): zero context load, reached only when the user types it. Use for
  procedures that only ever start by hand (`/retro`, `/skills-audit`). A skill can also be hidden
  from the agent with `disable-model-invocation: true` in its front matter; prefer a prompt in
  my-pi unless the procedure needs sibling reference files.
- Pick a model-invoked skill only when the agent must reach it unprompted, or another skill must.
  Reference that several skills share belongs in one model-invoked skill or one plain file, never
  copied into each.

## Information hierarchy

A document holds **steps** (ordered actions) and **reference** (definitions, rules, facts
consulted on demand). Each piece sits on a ladder ranked by how immediately the agent needs it:

1. **In-file step**: what the agent does, in order.
2. **In-file reference**: consulted on demand. A flat set of peer rules (every rule of a review on
   one rung) is a fine arrangement.
3. **Disclosed reference**: pushed into a separate file, reached by a pointer, loaded only when the
   pointer fires.

**Progressive disclosure** moves material down the ladder so the top stays legible. Test by
branch: inline what every branch needs, disclose what only some branches reach. Reference that
should be disclosed but sits between steps buries the steps and makes following them a coin-flip.

**Co-location**: keep a concept's definition, rules and caveats under one heading. Scattering one
meaning across a document is a different failure from duplicating it, with the same cost.

**Sprawl**: a document simply too long, even when every line is live. Attention thins across the
excess. The cure is the ladder: disclose, and split by branch or sequence.

## Steps and completion criteria

Every step ends on a **completion criterion**, the condition that tells the agent the step is done.

- **Clarity**: can the agent tell done from not done? A vague bound ("understanding reached")
  invites **premature completion**, pulled forward by the steps still ahead. Sharpen the bound
  first. Only if it stays fuzzy *and* the rush is observed, hide the later steps behind a real
  context boundary (a subagent or a separate prompt); an inline call clears nothing.
- **Demand**: how much the criterion requires. "Every modified model accounted for" forces more
  digging than "produce a change list". Demand binds flat reference too: "every rule applied".

The strongest criteria are both checkable and exhaustive.

## When to split

Splitting spends one of the two loads, so split only when the cut earns it:

- **By sequence**: when later steps tempt the agent to rush the current one, move them behind a
  context boundary. Merging sequences does the reverse and invites premature completion.
- **By invocation**: split off a model-invoked skill only for a distinct trigger word you actually
  use, or when another skill must reach it; the new description is permanent context load.

## Leading words

A **leading word** is a compact concept the model already knows (*tracer bullet*, *fog of war*,
*red* for a failing check) that anchors a region of behaviour in one token. Repeated as a token,
never as a sentence, it accumulates a distributed definition. Prefer an existing word over a coined
one: a coined word recruits no prior knowledge and costs definition tokens.

Hunt for passages that collapse into one word:

- "fast, deterministic, low-overhead" → *tight* (a tight loop).
- "a check you believe in" → *red*: the check goes red on the bug, or it does not.

The same word in prompts, docs and code also makes the agent reach the material more reliably.

**Negation** is the failure beside this lever: a prohibition puts the forbidden behaviour into
context and makes it more available. State the target behaviour ("write one-line comments") so the
banned one is never spoken. Keep a prohibition only as a hard guardrail with no positive phrasing,
and pair it with the positive target. (AGENTS.md's DO/DON'T table already pairs them; keep that
shape.)

## Pruning

- **Single source of truth**: each meaning lives in one place, so changing behaviour is a one-place
  edit. Duplication costs tokens and inflates the meaning's prominence beyond its rank. A rule
  stated in AGENTS.md and again in a skill is duplication; the skill points at AGENTS.md instead.
- **The environment is a source of truth too** (`package.json` scripts, config files, directory
  layout, `--help`). A document restating it is a cache, worth its load only when the lookup is
  expensive. Cache what looking cannot find: the unwritten convention, the reason behind a choice,
  the gotcha no config confesses.
- **Relevance**: every line still bears on what the document does. Lines go stale as tools and
  policies change. Without pruning, documents collect **sediment**: stale layers kept because
  adding feels safe and removing feels risky.
- **No-ops**: a sentence the model already obeys by default pays load to say nothing. The test is
  model-relative (does it change behaviour versus the default?), settled by running the document,
  not by debate. Delete the whole sentence rather than trimming words. A leading word too weak to
  beat the default (*be thorough*) is a no-op too; the fix is a stronger word (*relentless*).

## Checklist for an edit

- [ ] Description or pointer: leading word first, one trigger per branch, no identity the body
      repeats.
- [ ] Every step ends on a clear, demanding completion criterion.
- [ ] Reference only some branches need is disclosed behind a pointer.
- [ ] No meaning duplicated across AGENTS.md, skills and prompts; the copy points at the source.
- [ ] No sentence the model follows anyway; no bare prohibition without its positive target.
- [ ] British English (G-7), plain declarative sentences (G-11).
