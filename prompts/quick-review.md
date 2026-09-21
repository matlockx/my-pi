---
description: Fast light review of uncommitted changes, or of unpushed commits when the tree is clean (security, design, tests)
argument-hint: ""
---

Light review — fast pass, not a deep audit.

Pick the scope first:

1. Run `git status --porcelain`. If it lists tracked changes, review the uncommitted work: `git diff`, `git diff --cached`.
2. If the tree is clean, review the commits ahead of the upstream main: `git fetch origin` (skip on failure and say so), then `git log --oneline origin/main..HEAD` and `git diff origin/main...HEAD`. State the scope in one line before the verdict, e.g. `Scope: 3 commits ahead of origin/main`.
3. Nothing in either — reply `VERDICT: PASS` with `none` under `## Findings` and omit the commit message section.

Changed lines and their immediate context only.

Check, in this order: **security** (secrets, unvalidated input at a trust boundary, injection, missing authn/authz, PII in logs) · **correctness** (swallowed errors, nil deref, unchecked assertion, missing `defer Close/Rollback`, context not propagated, unsynchronised shared state) · **design and scope** (changes beyond the request, logic already in the repo, one-implementation abstraction, contradicted `docs/bdr/` rule) · **tests** (new behaviour tested, `TestBDR###R#` for record rules, assertions not weakened).

## Recurring findings

These are the classes an automated PR reviewer keeps raising on this codebase. Each is cheap to
check against the diff; run them as a pass over the changed hunks, not as a repository audit.
A hit is a finding even when the changed line itself looks correct.

**Client data reaching a durable store, event, or log.** A new field carrying a URL, path, query
string, free-text map, or raw JSON blob from a public client into the database, a Kafka payload, a
redirect URL, or a log line. An allowlist of parameter *names* does not sanitise their *values*; a
sanitised URL does not sanitise the path; a length cap is not a privacy control. A redirect query
parameter lands in browser history and proxy logs. Printing a failed command's stdout can print
the credential it was fetching. Ask where the value is sanitised, and whether a token, e-mail
address, or account identifier can travel in it.

**Validation, ordering, and limits that do not bind.** A JSON string validated as syntactically
valid JSON but not as an object. A size budget enforced after the value has already been parsed or
rebuilt. A slice or map allocated at the caller-supplied length when only a fixed maximum can
survive. A counter that stops at a cap while the surrounding work continues unbounded. A limit
applied before the filter it is meant to count against, so empty or invalid entries consume the
budget. A trim, split, or prefix heuristic that mutates the data it inspects — whitespace stripped
from a path, a sentence terminator missed because a quote follows it, a whole clause discarded to
remove its opening words.

**Header and identity trust.** An operator, tenant, or path taken from a request header and used
for scoping, link generation, or authorisation. Absence treated as a wider scope rather than a
refusal. Dot-segment checks that miss percent-encoded forms. Scoping applied to a list or summary
query while a detail, history, or by-id view on the same page stays unscoped.

**Idempotency, hash recipes, and persisted formats.** Validation placed before the
replay/idempotency check, so a replay of an existing request fails instead of returning the stored
result. A field appended to a content hash, business key, or manifest digest without a version
gate, which makes every pre-existing row compare as mismatched on replay. A published digest
version left unbumped while its recipe changed. A key shape widened so `ON CONFLICT` no longer
matches legacy rows, or narrowed onto columns that are NULL so every row stays distinct. A state
file, cache entry, or column whose serialised shape changed without tolerating the legacy form.

**Destructive steps and shared-resource assumptions.** A delete, reset, or revoke executed before
the replacement is durable — rows cleared before the input file opens, credentials removed before
the new secret is written — so a transient failure destroys the only good copy. Cleanup that
assumes sole ownership of a shared external resource (an IAM user, a topic, a bucket prefix) when
nothing enforces that assumption. Absence of a record treated as proof that no consumer holds the
old value.

**Retry, requeue, and scheduling.** A requeue whose predicate is still true on the next tick, so
the work never advances. A cooldown consulted by one entry point while the scheduler, sweep, or
sibling tick path still runs the same work every interval. A retry budget or failure timestamp
held in memory rather than persisted, so a restart resets it.

**Clocks and windows.** A cutoff derived from a truncated midnight rather than the current instant,
so a documented six-hour threshold stretches to a day. An inclusive/exclusive boundary change
applied to the query but not to its callers or their expected values. A test reading `time.Now()`
while production reads the injected clock.

**Absent versus empty versus NULL.** A template helper given nil where it expects an empty list. A
SQL predicate testing `cardinality(x) = 0` while older rows read the column as NULL. A view
selecting a column that does not yet exist in every target environment, which fails the whole
apply. A missing value treated as a wider scope, a passing check, or a match.

**One path fixed, siblings left behind.** The verified actor derived for one handler while the
neighbouring handlers on the same page still read the actor from a form field. A guard added to
one caller instead of the shared function. An allowlist, walker, or metric help text not extended
with the new file, field, or increment site it now covers. HTTP status and error code disagreeing
(403 with a bad-request code).

**Contract and record drift.** A changed event, command, or peer HTTP payload without the matching
update to the contract, lifecycle, E2E-scenario, or README documentation in the same change. A new
CLI flag or subcommand absent from the command's long help and the README. An Avro or schema
version left unbumped. Generated output under `gen/` not regenerated and committed alongside the
IDL. A new decision record missing from the `docs/bdr` index, a new business rule with no record,
rule text edited in place instead of superseded, a draft record implemented without being
promoted, or a `DEV-NOTE:` pointing at a record that does not exist in this checkout. A commit
message or PR title describing a different change from the one in the diff.

**Cross-service changes shipped one-sided.** A new request or event field added by the producer
with no evidence the peer accepts and persists it. Unknown JSON is ignored silently, so the flow
succeeds while the value is dropped. Either the peer change ships with it, or the review names the
integration test that proves compatibility.

**Tests that cannot catch the change.** Unit coverage of a helper while the actual flow — binding,
persistence, outbox, wire payload — is never exercised, so a wrong JSON tag or a missing
assignment still passes. Fixture numbers contradicting the field they claim to test. Expected
values rebuilt by hand instead of through the production builder, so both drift together. A test
depending on uninitialised global state or an invalid-length identifier, so it fails or short-
circuits before the assertion it was written for. A helper repointing a process-wide singleton, or
a patched module global never restored, while packages run in parallel. A required metric or log
line asserted nowhere. A rule test whose name omits the `BDR###R#` prefix.

**Prose that overstates or lags the code.** A UI banner, doc comment, schema docstring, or metric
help text promising more than the implementation delivers — a refund described as confirmed when
it is only requested, partitioning claimed on a single-partition topic, a counter described by one
of its several increment sites, an Avro field called absent when its default makes it null, an
operator error message naming one of several causes. A comment left behind describing the
behaviour the same diff replaced.

**Outcomes reported more confidently than they are known.** A concurrent-decision result
(`decided=false`, zero rows affected, conflict) folded into the success path, so the operator sees
a banner or history entry claiming this request did the work. A status code and error code that
disagree about what went wrong.

**Repo tooling.** A check or fix script that lost its `cd` to the repository root or a required
environment variable. A check script that writes (`-w`) instead of reporting a difference. A
pattern whose width or shape no longer matches what the neighbouring script generates. Migration
files that break the repository's own documented SQL parser constraints.

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

Omit the `## Commit message` section when the scope is already-committed work; there is nothing to commit.

Rules: severity first on the line, bold, no list marker and no indent; `<file>:<line>` unspaced and in backticks; at most six findings, highest severity first; silent areas stay silent, `none` under `## Findings` when there is nothing. No summary section, no prose outside the format. `FAIL` means a HIGH finding, `CONCERNS` means fix something before committing, `PASS` means commit is fine. British English (G-7).

Report only. Do not fix, do not commit.
