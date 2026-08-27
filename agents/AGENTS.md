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

## Commits

Provide commit message example, **wait for input**. Never push. Never start new task unprompted.

### Multi-repo changes

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
- Remove DEV- comments
- Use emojis in documentation, commit messages, or any written output

Optimize for maintainability. When in doubt, choose boring.

## Files to NOT modify

- `.agentignore`, `.agentindexignore` — control AI indexing
