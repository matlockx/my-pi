# AGENTS.md

## Golden Rules

When unsure, **ask the developer** before making changes.

| # | DO | DON'T |
|---|-----|-------|
| G-1 | Add/update `DEV-NOTE:` anchors near non-trivial edits | Delete/mangle existing `DEV-` comments |
| G-2 | Follow lint/style configs (`.golangci.yml`, `pyproject.toml`, `.prettierrc`) | Re-format to other styles |
| G-3 | Ask confirmation for >300 LOC or >3 files | Refactor large modules without guidance |
| G-4 | Stay in current task context | Continue prior task after "new task" |
| G-5 | Name custom HTTP headers without a prefix (`Request-Id`, `Correlation-Id`) | Use the deprecated `X-` prefix (RFC 6648) |
| G-6 | Set `User-Agent` to the calling service's own name on every outbound call to an internal service | Leave the Go default (`Go-http-client/1.1`) or an empty UA |
| G-7 | Use British English everywhere (`cancelled`, `behaviour`, `initialise`, `colour`) | Mix in US spellings (`canceled`, `behavior`, `initialize`, `color`) |
| G-8 | Multi-repo change: list changes per repo, ask for external code review, ask for a commit | Report only a summary or commit without asking |
| G-9 | Golden Helm chart template: pass config to internal services via **env variables** | Use command line args/`args:`/`command:` (if truly unavoidable, say so and wait for user confirmation) |
| G-10 | Multi-repo change: `git fetch origin` (or pull) each repo's `main` **before** research/lookups | Reason about code from a stale local checkout |
| G-11 | Doc comments: state the fact plainly and name the source (`as reported by the provider`) | Anthropomorphise or use chatty phrasing (`when it says`, `we`, `you'll want to`) |
| G-12 | Caller-specific rationale goes at the call site as `DEV-NOTE:`; doc comments state the contract only | Explain one caller's wiring in the callee's doc comment |
| G-13 | Insert new declarations **above** an existing comment block; comment and declaration move as one unit | Insert between a comment block and the declaration it documents |
| G-14 | Every open point put to the user is a decidable question: context, options, recommendation, cost of deferring | List bare topics, statuses, or headings under "open questions" |

## Asking the User (MUST)

When something is genuinely needed from the user, it is asked as a question the user can answer
without opening the code. A heading with a topic name is not a question. A status report labelled
"open questions" is not a question.

Each item follows this shape:

1. **The question**, one sentence, ending in a question mark, answerable with a choice or a yes/no.
2. **Context**: what exists today, what is blocked by the answer, and where (file, record, service).
3. **Options**, whenever more than one path exists — each with its consequence, not just its name.
4. **Recommendation**, always when one option is defensible, with the one reason it wins.
5. **Cost of deferring**: what stays broken, unwritten, or unreleasable until the answer arrives.

Rules:

- No option list of one. If there is only one path, it is not a question — state it as a decision
  taken and move on, or as a blocker with its owner.
- A point with no decision attached is not an open question. Put it under `## Notes` or a
  `DEV-TODO:` anchor instead, and do not ask the user to respond to it.
- Never merge several decisions into one item. One question, one answer.
- Recommendation is withheld only when the choice is a business or product decision the developer
  owns and no technical criterion separates the options — say that explicitly rather than staying
  silent.
- Order questions by what blocks the most work, not by the order they were discovered.

Example of what not to write:

```text
4. Partner parameter names (D14) — still convention-based.
```

Example of the same point asked properly:

```text
4. Should partner parameter names be validated against a fixed list, or stay convention-based?
   Today `ingest.go:212` accepts any `pp_*` key and forwards it verbatim; a typo reaches the
   warehouse as a new column.
   a) Fixed allowlist in BDR-0001 — typos rejected at ingest, new partners need a record change.
   b) Keep convention-based — no record churn, typos stay invisible until the warehouse query fails.
   Recommendation: (a). The warehouse cost of a bad column is higher than the cost of editing a record.
   Deferring: partner onboarding stays unvalidated; no data is lost, so this does not block release.
```

## Environment

- Shell: **fish** syntax. No `$()` or `export VAR=value`.
- **Never commit/push** without explicit approval.
- **Use `rg`** instead of `grep`.

## Skill Auto-Loading

| Pattern | Skill |
|---------|-------|
| `.go` | golang |
| `.sh` | bash-scripts |
| `.github/workflows/*.yml` | github-actions |
| `.ts`/`.mts`/`.cts` | typescript |
| `.tsx` | typescript + react |
| `.jsx` | react |
| `.py` | python |

## Anchor Comments

Use `DEV-NOTE:`, `DEV-TODO:`, `DEV-QUESTION:` markers near non-trivial code. These annotations are for all developers — human and agent alike. Search existing anchors before scanning. Update when modifying associated code. Never remove without human instruction.

If you encounter the old `AIDEV-NOTE:`, `AIDEV-TODO:`, or `AIDEV-QUESTION:` prefix in any file, migrate it to the `DEV-` equivalent in the same edit.

## Comments and Docstrings

Doc comments (Javadoc, Go doc, docstrings, Avro/IDL `/** */`) are API documentation, not chat.
Write them as short declarative statements a reader can trust without context.

| DO | DON'T |
|----|-------|
| Name the source of a value precisely: `as reported by the provider`, `taken from the provider response`, `set by the settlement job` | Anthropomorphise a system: `when it says`, `if the provider tells us`, `what the bank thinks` |
| Third person, present tense, no subject pronouns: `Returns the settled amount.` | First/second person: `we return`, `you'll get`, `let's` |
| State the condition explicitly: `Only meaningful when settlementDifferenceMinor is non-zero.` | Vague hedging: `usually`, `might be there`, `sort of` |
| Give units, currency scale, nullability, and enum-ish example values | Restate the field name in prose: `The refund id. The id of the refund.` |
| One sentence per fact, ending with a full stop | Run-on sentences chaining three clauses with commas |

Optional/nullable fields document three things: what the value means, who sets it, and when it is
absent. British English applies here too (G-7).

A doc comment for a field whose value comes from an external system always names that system and
whether the value is passed through verbatim or mapped locally — that is the question a reviewer
asks first.

### A comment block belongs to the declaration directly below it

A doc comment and its declaration are one unit. Never insert anything between them.

When adding a declaration (type, function, const, field) near an existing one, the insertion point
is **above the existing declaration's comment block**, never between the comment and its
declaration. The same applies when moving, reordering, or extracting code: comment block and
declaration move together.

Before writing an edit anchored on a declaration line, look at the lines above it. If they are a
comment block, the anchor moves up to the first line of that block.

```go
// Tenant is the existing type.
type Tenant struct{ ... }
```

Wrong — new type inserted below the comment, orphaning it and stealing `Tenant`'s documentation:

```go
// Tenant is the existing type.

// Account is the new type.
type Account struct{ ... }

type Tenant struct{ ... }
```

Right — new block placed wholly above or wholly below the existing unit:

```go
// Account is the new type.
type Account struct{ ... }

// Tenant is the existing type.
type Tenant struct{ ... }
```

After any edit that adds or moves a declaration, verify each touched declaration still carries its
own comment and no comment block sits immediately above another comment block.

In Go this is machine-checkable: `revive`'s `exported` rule and staticcheck `ST1021` report
`comment on exported type X should be of the form "X ..."` when a comment lands on the wrong
declaration. Keep them enabled; they do not cover unexported declarations, so the manual check
still applies.

### Caller context belongs at the call site

A doc comment is the contract for every caller, present and future. Rationale that holds for only
one caller does not belong there.

- **Doc comment**: what the function does, what it returns, what it guarantees, what it requires of
  any caller, side effects, error cases.
- **Call-site comment** (`DEV-NOTE:`): why this call is made here, why in this order, why not
  somewhere else, which other component's behaviour forced it.

Test before writing: *would an unrelated second caller need this sentence?* If no, move it to the
call site.

A constraint binding on all callers stays in the doc comment, phrased as a requirement (`Callers
must invoke it before the first tenant snapshot is loaded.`); the reason that requirement exists in
a given wiring stays at the call site.

Never duplicate the same explanation in both places — the call site wins.

```go
// PrepareReferenceData persists dev-only tenant configuration in a new transaction.
// The transaction is committed before the function returns.
// Callers must invoke it before the first tenant snapshot is loaded.
func PrepareReferenceData(ctx context.Context, txStarter ql.TxStarter) error { ... }

// DEV-NOTE: seeded here rather than from Bootstrap. TenantsService caches the first
// tenant snapshot, so seeding later keeps the new rule set invisible until the cache expires.
if err := devseed.PrepareReferenceData(ctx, txStarter); err != nil {
```

## Commits

Provide commit message example, **wait for input**. Never push. Never start new task unprompted.

### Multi-repo changes

Before researching or reasoning about code in a multi-repo task, **MUST** fetch/pull the latest
`origin/main` in every repository involved. Never base assumptions on a stale local checkout. If a
fetch fails (no network, auth), say so explicitly and state that findings may be outdated.

When a task touches more than one repository, end the work by reporting, per repository:

- the repository path,
- the files changed there,
- one line per change describing what and why.

Then ask the user to review the diff in the tool of their choice (IDE, `git diff`, PR, review UI),
and ask explicitly for approval to commit — one commit message example per repository, since each
repository commits separately. Never commit or push before that approval.

## Tests

Tests are contracts. Never modify assertions solely to match new code. Never delete tests without approval. Investigate first.

### New code is tested by default

**Every new or changed function with behaviour gets a test in the same task.** Not the next
task, not "follow-up", not "the caller's test covers it". A task that adds a function and no
test is incomplete, and "no rule said I had to" is not a defence — this is the rule.

Behaviour means: a branch, a loop, a calculation, a state transition, error handling,
parsing, mapping, or anything touching money, auth, or persistence.

Exempt — no test needed, but **say which exemption applies**, in one line, when reporting
the work:

- Pure delegation: a wrapper that only forwards arguments and adds nothing.
- Generated code.
- Trivial accessors, constants, and struct literals with no logic.
- Wiring/composition (DI setup, route registration) already covered end to end.
- The test needs infrastructure this repo cannot run — then say so explicitly and file a
  task for it, do not stay silent.

Silence is the failure mode. Either the test exists, or the exemption is named out loud.
Unsure whether it is worth testing → write the test; it is cheaper than the argument.

Rule-coverage checks (`TestBDR###R#`) are an **additional** obligation for decision-record
rules, not a replacement for this one. A repo with no BDRs still owes tests for new code.

When tests break during refactoring: if `docs/bdr/` exists, consult relevant BDRs before
changing assertions. A failing test may protect a business rule — fix the code, not the test,
unless a BDR has been explicitly superseded. When in doubt, ask the user before modifying test assertions.

### Rule traceability (repos with `docs/bdr/` or `docs/adr/`)

Decision records are the test specification. Each record numbers its rules (`BDR-019-R1`,
`ADR-006-R2`), and every rule is covered by at least one test whose name carries the rule ID:

```go
func TestBDR019R1_PermanentVerdictRefundsItemAutomatically(t *testing.T) { ... }
```

One rule may have several tests; one test covers one rule. A rule with no matching test is a
build failure where a coverage check is wired into the repo's check script. When a rule cannot
be tested in this repo (peer service owns it), say so in the record instead of faking coverage.

### Observability contract

Every business rule declares, in its record, how a violation becomes visible: the log line, the
audit/history entry, and the metric. Tests assert those, not only the happy outcome — an
unplanned edge case must show up in monitoring rather than silently corrupting state.

### Adversarial matrix

For money paths and any at-least-once message consumer, the rule's tests include: duplicate
delivery of the same message, out-of-order arrival, duplicate client request id, amount/currency
mismatch, missing correlation ids, provider decline, and concurrent inline path plus background
sweep. Most production bugs live here, not in the happy path.

## Decision Records (BDR / ADR)

If a project has `docs/bdr/` (Business Decision Records) or `docs/adr/` (Architecture Decision Records):

- **Consult** BDRs before implementing features that touch business rules.
- **After new features**: if the implementation introduces a business rule, ask the user whether
  a BDR should be created. Do not create one silently.
- **Reference in code**: leave `DEV-NOTE: see <repo>/BDR-NNN` (or `<repo>/ADR-NNN`) at implementation
  sites where the connection to a decision record is non-obvious. Always prefix the record ID with
  the owning repo name (e.g. `order-service/BDR-001`), also for records in the current repo — so a
  reference stays unambiguous when the record lives in another repo.
- **Never modify** existing BDRs/ADRs — supersede them with a new numbered record. Narrow
  additive exception: rule numbering and an `## Observability` section may be added to an
  existing record, since neither changes what the record decided. Rule text itself is immutable.

## Context7

Use `ctx7` first for library/API lookups: `npx ctx7@latest library <name>` then `npx ctx7@latest docs <id> "<question>"`. Fall back to source only if no results.

## BEADS (opt-in)

Load `beads` skill only when user explicitly asks. Otherwise use to-do lists.

**NEVER** add beads issue IDs (e.g. `bd-123`) into code as comments. Beads IDs belong in the issue tracker, not the source.

## Workflow

1. Check `AGENTS.md` files → 2. Clarify ambiguities → 3. Plan → 4. Trivial: go. Non-trivial: present plan → 5. Track progress → 6. Update docs/anchors → 7. User review

## Never Do

- Modify tests without explaining why
- Change API contracts
- Alter migration files
- Commit secrets
- Add a `replace` directive to `go.mod` (use a local, gitignored `go.work` instead)
- Call an internal service without an identifying `User-Agent` (set it once on the shared `http.Client`/transport, not per request)
- Introduce HTTP headers prefixed with `X-` (deprecated by RFC 6648; only keep existing ones for compatibility)
- Mix US and British spelling (British English only: code identifiers, comments, docs, commit messages, logs, UI copy; exception: third-party API fields and language keywords keep their original spelling, e.g. CSS `color`, `initializeApp`)
- Pass config to a service via Helm `args:`/`command:` when an env variable would do (golden chart template: env only; no other way → inform user, wait for confirmation)
- Assume business logic
- Insert a new declaration between an existing comment block and the declaration it documents (anchor edits on the first line of the comment block, not the declaration line)
- Put one caller's rationale in the callee's doc comment (call-site `DEV-NOTE:` instead; doc comment keeps only constraints binding on all callers)
- Write doc comments that anthropomorphise a system (`verbatim from the provider when it says`) instead of naming the source (`verbatim from the provider response, when present`)
- Remove DEV- comments
- Use emojis in documentation, commit messages, or any written output

Optimize for maintainability. When in doubt, choose boring.

## Files to NOT modify

- `.agentignore`, `.agentindexignore` — control AI indexing
