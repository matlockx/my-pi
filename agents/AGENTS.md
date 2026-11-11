# AGENTS.md

## Golden Rules

When unsure, **ask the developer** before making changes.

| # | DO | DON'T |
|---|-----|-------|
| G-1 | Add/update `DEV-NOTE:` anchors near non-trivial edits | Delete/mangle existing `DEV-` comments |
| G-2 | Follow lint/style configs (`.golangci.yml`, `pyproject.toml`, `.prettierrc`) | Re-format to other styles |
| G-3 | Ask confirmation for >300 LOC or >3 files | Refactor large modules without guidance |
| G-4 | Stay in current task context | Continue prior task after "new task" |
| G-5 | Name custom HTTP headers without a prefix (`Request-Id`, `Correlation-Id`) | Use the deprecated `X-` prefix (RFC 6648); existing `X-` headers stay only for compatibility |
| G-6 | Set `User-Agent` to the calling service's own name on every outbound call to an internal service, once on the shared `http.Client`/transport | Leave the Go default (`Go-http-client/1.1`) or an empty UA, or set it per request |
| G-7 | Use British English everywhere: code identifiers, comments, docs, commit messages, logs, UI copy (`cancelled`, `behaviour`, `initialise`, `colour`) | Mix in US spellings (`canceled`, `behavior`, `initialize`, `color`); exception: third-party API fields and language keywords keep their spelling (CSS `color`, `initializeApp`) |
| G-8 | Multi-repo change: list changes per repo, ask for external code review, ask for a commit | Report only a summary or commit without asking |
| G-9 | Golden Helm chart template: pass config to internal services via **env variables** | Use command line args/`args:`/`command:` (if truly unavoidable, say so and wait for user confirmation) |
| G-10 | Multi-repo change: `git fetch origin` (or pull) each repo's `main` **before** research/lookups | Reason about code from a stale local checkout |
| G-11 | Doc comments: state the fact plainly and name the source (`as reported by the provider`) | Anthropomorphise or use chatty phrasing (`when it says`, `we`, `you'll want to`) |
| G-12 | Caller-specific rationale goes at the call site as `DEV-NOTE:`; doc comments state the contract only | Explain one caller's wiring in the callee's doc comment |
| G-13 | Insert new declarations **above** an existing comment block; comment and declaration move as one unit | Insert between a comment block and the declaration it documents |
| G-14 | **HARD RULE.** Every decision put to the user is a decidable question (context, options, recommendation, cost of deferring), asked **one at a time**, with a recommendation that says why it wins **and why every other option loses** | List bare topics, statuses, or headings under "open questions"; dump several questions in one block; offer options without a recommendation or without saying why the others lose |
| G-15 | New/changed code passes the repo's coverage gate once, before it is pushed for review (see "When the quality gates run"): with a SonarQube gate (`sonar-project.properties`, or a Sonar step in CI) **≥ 80 %** line+branch coverage, measured locally; otherwise every added or changed function at **CRAP ≤ 10** (`crapper --threshold 10 <files the branch changed>`). `crapper` not installed → report the gate as not run and point to `/skill-install ub-mode` | Push over the gate, pad with assertion-free tests, extend `sonar.*exclusions` to pass, run Sonar scans nobody asked for, rerun the gate after every task, or push without saying the gate was not run |
| G-16 | Before changing a metric (counter, gauge, histogram, timer, meter), search memory and every alert/dashboard repo for its name and labels; fix the consumers in the same change; labelled counters start at zero. Full rules: `rule://metrics` (injected by omp when an edit writes metric code) | Rename, re-label, retype, or remove a metric without knowing which alert or dashboard reads it |
| G-17 | **HARD RULE.** Run subagents one at a time by default. Before starting **any** agents in parallel (or any fan-out of several agents), ask first and state the consequences: how many agents, what each does, expected duration, the token/cost multiplier (each agent re-reads repo, docs and KB on its own), shared-file or merge risks, and the sequential alternative | Spawn parallel agents (or several background agents at once) without asking, even when the user said "do all now" or "go" |
| G-18 | New/changed code leaves no `dryer --threshold 0.8` duplicate candidate touching the change, checked once before it is pushed for review: extract the shared logic or reuse what exists | Copy a function and tweak it; gate with `dryer --changed`, which never compares against untouched files |

## Asking the User (HARD RULE)

**HARD RULE — no exceptions, no shortcuts, every time.** Each decision or question put to the user:

- is asked **one at a time**, never several in one block;
- carries a **recommendation**;
- explains **why the recommended option wins**;
- explains **why each other option loses**.

A question missing any of these is not sent; it is rewritten first. The rule applies to small
questions as much as large ones, and terse output styles (caveman, lean, ponytail) do not shorten
it: the reasons may be one line each, but they are never dropped. The user should never have to ask
"what do you recommend?" or "why not the other one?".

When something is genuinely needed from the user, it is asked as a question the user can answer
without opening the code. A heading with a topic name is not a question. A status report labelled
"open questions" is not a question.

Each item follows this shape:

1. **The question**, one sentence, ending in a question mark, answerable with a choice or a yes/no.
2. **Context**: what exists today, what is blocked by the answer, and where (file, record, service).
3. **Options**, whenever more than one path exists — each with its consequence, not just its name.
4. **Recommendation** — mandatory. Name the option, state why it wins (the criterion that decides
   it), then state for **every** other option why it loses against that criterion. "Also fine" or
   "more work" without the concrete cost is not a reason.
5. **Cost of deferring**: what stays broken, unwritten, or unreleasable until the answer arrives.

Rules:

- No option list of one. If there is only one path, it is not a question — state it as a decision
  taken and move on, or as a blocker with its owner.
- A point with no decision attached is not an open question. Put it under `## Notes` or a
  `DEV-TODO:` anchor instead, and do not ask the user to respond to it.
- Never merge several decisions into one item. One question, one answer.
- Recommendation is withheld only when the choice is a business or product decision the developer
  owns and no technical criterion separates the options. Say that explicitly, name the criterion
  that is missing, and still state what each option costs — never stay silent.
- Order questions by what blocks the most work, not by the order they were discovered.
- Two or more questions: walk the user through them **one at a time**, in that order. Ask the
  first in full shape (context, options, recommendation with why it wins and why each other option
  loses, cost of deferring), wait for the answer, then ask the next — re-checking it against the
  answer just given, and dropping or rewording it when that answer settled or changed it. Use the
  interactive question tool when the harness has one (`ask`, with the recommended option marked);
  otherwise ask in chat and stop. A batch summary of all questions may precede the walk-through as
  an overview, never replace it.
- With `ask`, the `question` field carries only the one-sentence question. Context, cost of
  deferring, why the recommendation wins and why each other option loses go in the chat text
  written before the call; each option's consequence goes in its `description`. The ask dialog
  clamps the question text to a few lines and drops its line breaks, so anything longer is cut off
  on a normal-height terminal.

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
   (b) loses: it saves one record edit per partner but defers every typo to a failed warehouse query.
   Deferring: partner onboarding stays unvalidated; no data is lost, so this does not block release.
```

## Environment

- Shell: **fish** syntax. No `$()` or `export VAR=value`.
- **Never commit/push** without explicit approval.
- **Search with the `grep` tool**, not `grep`/`rg` in bash (omp `bashInterceptor` blocks them); `rg` in a pipe (`kubectl logs … | rg error`) is fine.
- **Images in GitHub issues, PRs and comments** (`https://github.com/user-attachments/assets/<uuid>`):
  `read http://127.0.0.1:8082/asset?url=<URL-encoded link>` (my-pi GitHub MCP proxy, which adds
  the token). A direct fetch answers 404 for private repositories.

## Skill Auto-Loading

| Pattern | Skill |
|---------|-------|
| `.go` | golang |
| `.sh` | bash-scripts |
| `.github/workflows/*.yml` | github-actions |
| `.ts`/`.mts`/`.cts` | typescript |
| `.tsx` | typescript |
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

A repository with an executable `dev/check` at its top level gets it run before every agent
`git commit` (my-pi `extensions/git-gate`). It checks the staged tree; a failure blocks the
commit and returns its output. Stage and commit in separate commands, and never use
`git commit -a`: files staged in the commit's own command are not staged yet when the check runs,
so the gate refuses that command. Split one file between commits with a patch that keeps its
context lines (`git apply --cached`), never with `--unidiff-zero`.

**Report git state only after checking it in the same turn.** Before writing that a commit,
branch, or repository is pushed, unpushed, ahead, behind, merged, or clean, run
`git fetch origin` and then `git status -sb` (or `git branch -r --contains <sha>`) in that
repository, and quote the result. The user, a watcher, or another session may have pushed since
the last check, so a state remembered from earlier in the session is not a fact. When the fetch
fails, state the failure and give no push state at all; never fill it in from memory.

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

Coverage gates: a repo with a SonarQube gate uses 80 % coverage on new code; every other repo uses
complexity-weighted coverage (CRAP). Both are in `agents/quality-gates.md`. Never run Sonar scans
(`sonar`, `sonar-scanner`, SonarCloud/SonarQube analysis) unless the user explicitly asks; CI runs
them. SonarCloud rules cited in the language skills are writing guidance, not a reason to run a
scan.

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
unless the current version of the BDR changed or removed that rule. When in doubt, ask the user before modifying test assertions.

### When the quality gates run

The coverage gate (G-15) and the duplication gate (G-18) run **once before the work is pushed**,
not after every task. The `push-gate` extension blocks `jflow_pr`, `jflow_review_resolve` and
`git push` until both have run on the content being pushed; its block message names the commands.
The full rules (Sonar 80 %, CRAP, dryer, exemptions, tool installation) are in
`~/github/my-pi/agents/quality-gates.md`: read it before running the gates.

- During the work, run the tests of the package or file being changed, and the full suite once
  when the task is done. Tests for new code are still written in the same task ("New code is
  tested by default").
- A task report without a gate run says so in one line: `Quality gates: not run (run before push)`.

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

### Metrics

Labelled counters start at zero, and a changed metric reaches its dashboards and alerts in the
same change (G-16). The full rules are the omp rule `metrics` (my-pi `rules/metrics.md`): omp
injects it when an edit or write adds metric code in Go, Python, Java, Kotlin or TypeScript. Read
`rule://metrics` before any metric change it did not fire for: a renamed label value, a removed
increment site, a deleted instrument.

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
- **Read the current file** before relying on a BDR rule. A rule quoted from memory, a session
  summary, or an earlier conversation may come from an older version; the file wins.
- **BDRs change in place.** A changed business decision is edited into the existing record, and its
  `**Version:**` is incremented with every change. Never write a new record to supersede a BDR.
  Bigger changes get one brief line in the record's `## Changelog`; the full diff lives in git.
  A removed rule or record keeps its ID with the text replaced by `Removed (vN): <reason>`; IDs
  are never reused. Tests and `DEV-NOTE:` references to a changed or removed rule are updated in
  the same change.
- **Migrate legacy supersede chains when touched.** A change to a BDR that supersedes or is
  superseded by another record migrates the whole chain in the same change: see the bdr skill,
  rule 8.
- **ADRs are never modified** — supersede them with a new numbered record. Narrow additive
  exception: rule numbering and an `## Observability` section may be added to an existing ADR,
  since neither changes what the record decided. ADR rule text itself is immutable.

## Context7

Use `ctx7` first for library/API lookups: `npx ctx7@latest library <name>` then `npx ctx7@latest docs <id> "<question>"`. Fall back to source only if no results.

## BEADS (opt-in)

Use beads (`bd`) only when the user explicitly asks. Otherwise use to-do lists.

**NEVER** add beads issue IDs (e.g. `bd-123`) into code as comments. Beads IDs belong in the issue tracker, not the source.

## Never Do

- Modify tests without explaining why
- Change API contracts
- Alter migration files
- Commit secrets
- Add a `replace` directive to `go.mod` (use a local, gitignored `go.work` instead)
- Assume business logic
- Use emojis in documentation, commit messages, or any written output

Optimise for maintainability. When in doubt, choose boring.

## Files to NOT modify

- `.agentignore`, `.agentindexignore` — control AI indexing
