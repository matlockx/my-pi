---
name: go-service-review
description: Deep review of a Go REST service — architecture, layering, REST surface, security and route exposure, persistence, concurrency, tests, decision records, docs accuracy, observability, dead code and CVEs. Produces a prioritised findings report and optionally files beads tasks. Use when the user asks to review a service, audit a repository, check a Go backend before release, or says "deep review", "service review", "review this service".
---

## What I do

Review a whole Go REST service against the areas below, produce one prioritised
findings report with `file:line` evidence, and optionally file the critical findings
as beads tasks.

This skill orchestrates. It does not restate Go language rules — those live in the
`golang` skill, which is loaded for the code-quality area. It does not restate the
decision-record format — that lives in the `adr` and `bdr` skills.

## Non-negotiable protocol

A deep review is expensive in tokens. Never start scanning before the user confirms.

1. **Detect** — run the auto-detection commands below. Cheap, read-only, no LLM analysis.
2. **Ask** the intake questions. Every question has a default; the user may answer
   "defaults" to accept all.
3. **Print the scan plan** — the exact list of areas that will be reviewed, which were
   skipped and why, and a rough cost signal (files to read, tools to run).
4. **Wait for explicit confirmation.** Always. Even if the user already said "review
everything". A user may cut areas after seeing the plan.
5. **Extract constraints first** — run the `records` area before anything else and
   build the constraint list (see "Recorded decisions win").
6. Only then execute the remaining areas, in the confirmed order.

If the user modifies the plan, print the revised plan and confirm again.

## Execution order

Order matters. Each phase feeds the next.

| Phase | Areas | Why here |
|---|---|---|
| 0 | `records` | Produces the constraint list every later area is filtered through |
| 1 | `docs`, `layering` | Establishes what the service claims to be vs what it is |
| 2 | `security`, `persistence`, `concurrency` | Highest-consequence areas, reviewed while context is freshest |
| 3 | `rest`, `observability`, `ops` | Surface and operability |
| 4 | `go-quality`, `tests` | Tool-driven, cheap to run late |
| 5 | `dead-code`, `deps` | Mechanical, batched |
| 6 | `extensibility`, `ponytail` | Judgement calls — run last, once constraints and real coupling are known |

`extensibility` and `ponytail` are deliberately last: their findings are the ones most
often invalidated by a recorded decision or by coupling discovered in phase 1.

## Recorded decisions win

An accepted ADR or BDR is a requirement, not an opinion. Generic best practice never
overrides it.

After `records`, write the constraint list into the working notes — one line per constraint,
with the record ID:

```
ADR-004  single PSP by decision, no second provider planned  -> no "missing abstraction" finding
BDR-002  partial refunds settle per item, not per payment    -> per-item loop is intended
ADR-003  outbox by decision, no direct publish               -> direct publish IS a finding
```

Then apply, in this order:

1. **Contradicted by a record** — do not report the finding. A hardcoded provider under a
   record saying there will only ever be one is correct code.
2. **The record itself looks wrong** — do not smuggle it back in as a code finding.
   Report it once, in `records`, as "decision worth revisiting", severity **MINOR**, with the
   evidence that changed since the record was written. The user decides, not the review.
3. **Code violates a record** — a finding at the record's own weight, usually
   **CRITICAL**. A record mandating the outbox and a service publishing directly is a
   defect even if the direct publish works.
4. **No record covers it** — normal review rules apply, and if the code encodes a real
   business or architectural decision nobody wrote down, that missing record is its own
   **MAJOR** finding in `records`.

If no `docs/adr` and no `docs/bdr` exist, there are no constraints and every area runs
unfiltered — say so in the report, because unfiltered means "judged against generic best
practice, not against your intent".

## Step 1 — Auto-detection

Run these first. They decide which areas apply.

```bash
ls docs/adr docs/bdr 2>/dev/null                 # records
ls sql/ migrations/ 2>/dev/null                  # persistence
rg -l 'kafka|nats|rabbitmq|sqs' --type go        # concurrency messaging / at-least-once
rg -ln 'gocron|cron\.|time\.Ticker' --type go         # observability: scheduled jobs
rg -ln 'tracing|otel|opentelemetry' --type go          # observability: trace wiring
rg -l 'swagger|openapi' -g '!node_modules'       # docs API spec drift
ls helm-chart/ deploy/ chart/ 2>/dev/null        # ops, security route exposure
ls .beads/ 2>/dev/null; command -v bd            # task filing available?
command -v golangci-lint gosec govulncheck       # go-quality, security, deps tooling
ls dev/check dev/rule-coverage Makefile 2>/dev/null   # repo's own gates
cat AGENTS.md CLAUDE.md 2>/dev/null              # repo conventions are review criteria
```

`AGENTS.md` in the repo is part of the specification. A violation of a documented repo
convention is a finding, at the severity the convention implies (an "MUST update in the
same task" doc rule broken is CRITICAL, a style preference is MINOR).

Skip rules:

| Not detected | Skip |
|---|---|
| No `sql/` or `migrations/`, no `database/sql` import | `persistence` |
| No messaging client import | `concurrency`: the at-least-once half only; keep the concurrency half |
| No `docs/adr` and no `docs/bdr` | `records` becomes a single finding: "no decision records" (MAJOR), not a full area |
| No swagger/openapi file | `docs`: spec-drift check only; keep README/docs drift |
| No chart/deploy dir | `ops`, and the `security` route-exposure check falls back to code-only |

## Step 2 — Intake questions

| # | Question | Default |
|---|---|---|
| 1 | Scope: whole repo, one package, or diff vs `main`? | whole repo |
| 2 | Areas: all applicable, or a subset? | all detected-applicable |
| 3 | Any area to deep-dive beyond the checklist? | none |
| 4 | File beads tasks for findings? (only asked if `bd` is available) | ask again after the report |
| 5 | Include a `/ponytail-audit` over-engineering pass? | no |

## Step 3 — Scan plan and confirmation

Print, then stop and wait:

```
Scan plan
  Scope:      whole repo (48 .go, 19 _test.go)
  Areas:      records docs layering security persistence concurrency rest
              observability ops go-quality tests dead-code deps
  Skipped:    ponytail (not requested)
  Tools:      golangci-lint, go vet, gosec, govulncheck, dev/check
  Cost:       ~N files read, M tool runs
Confirm? (yes / edit areas / cancel)
```

---

# Review areas

Every finding needs `file:line`, what is wrong, why it matters, and the fix. A finding
without a location is not a finding — it is a feeling. Do not report it.

## go-quality — Go code quality

Load the `golang` skill. Run and read, do not re-derive by eye:

```bash
go vet ./... ; golangci-lint run ; gosec ./... ; go build ./...
```

Report tool output grouped by severity, with the linter/rule ID. Do not hand-audit rules
the linter already enforces — read `.golangci.yml` and only manually check what is
**disabled** there (a disabled `revive`, `wrapcheck`, or `errcheck` exclusion is itself
worth a MINOR finding if it hides real issues).

### Toolchain currency

One Go version, current, stated in every place that pins one. Drift between them is how a
build passes locally and breaks in CI.

```bash
rg -n '^go |^toolchain' go.mod
rg -n 'golang|FROM|GOEXPERIMENT' Dockerfile
rg -n 'go-version' .github/workflows/*.yml 2>/dev/null
go version
```

- `go.mod` below the current stable Go release. **MAJOR** — the repo is missing language
  and stdlib fixes, and the gap only grows.
- `go.mod`, the Dockerfile builder image, and the CI `go-version` disagreeing. **CRITICAL**
  — the artifact is not built with the toolchain the code was checked against.
- A `toolchain` directive pinning something older than the `go` directive. **MAJOR**
- Code written for an older Go: manual `ptr()` helpers instead of `new(expr)`, index loops
  where range-over-int reads better, hand-rolled slice/map helpers that `slices`/`maps`
  cover, pre-1.22 loop-variable copies (`item := item`) that are now noise, callback-style
  iteration where `iter.Seq` fits. **MINOR** each, batched into one finding — but see the
  `records` constraint list first, some of this is deliberate.
- A `GOEXPERIMENT` set in the build with no comment saying why and when it goes away.
  **MINOR** — experiments must have an exit condition.

### Container build

```bash
cat Dockerfile ; rg -n 'FROM' Dockerfile
```

- **Multi-stage build.** A single-stage image ships the toolchain, the module cache, and
  the source into production. **CRITICAL** (attack surface and image size).
- **Distroless or equally minimal runtime base.** A full distro base in the final stage is
  **MAJOR**; anything with a shell and a package manager in production is **CRITICAL** for
  a public-facing service.
- Runtime stage copies only the binary and the data it needs (migrations, templates,
  certs). A `COPY . .` in the final stage is **CRITICAL**.
- Base images pinned to a tag or digest, from the organisation's registry where one
  exists — never a floating `latest`. **MAJOR**
- Builder image Go version matching `go.mod`. See toolchain currency above. **CRITICAL**
- Non-root user in the final stage (distroless bases usually default to it — verify, do
  not assume). **MAJOR**
- No secrets, `.netrc`, or credentials baked into any layer, including intermediate ones.
  **BLOCKER**
- `ENTRYPOINT` as the binary with `CMD` for default flags, so flags stay overridable.
  **MINOR**

Reference shape (multi-stage, org builder pinned to the `go.mod` version, distroless
runtime, binary plus migrations only):

```dockerfile
FROM <registry>/golang-builder:1.26.2-trixie AS builder
FROM <registry>/base-image:distroless-debian13
COPY /sql /sql
COPY --from=builder /out/binary /service
ENTRYPOINT ["/service"]
CMD ["--verbose"]
```

Manual, beyond the linter:
- Error wrapping carries context (`fmt.Errorf("doing X: %w", err)`), `errors.Is/As` only.
- Panic only at startup or in tests.
- Goroutines have a shutdown path and cannot leak.
- `context.Context` first parameter, propagated, never `nil`, never stored in a struct.

## layering — Layering and coupling

Map the actual import graph, do not trust the README table.

```bash
rg -n '^\t"github.com/<module>/internal' --type go | sort | uniq -c
```

Findings:
- Repository package imported from a handler (skips the service layer). **CRITICAL**
- HTTP framework types (`echo.Context`, `http.Request`) in the service or repository
  layer. **CRITICAL**
- Provider/PSP-specific types leaking into domain models or repository rows — the
  abstraction exists on paper only. **CRITICAL**
- Domain package importing an infrastructure package (kafka, resty, sqlx) directly.
  **MAJOR**
- Import cycles, or a `util`/`common`/`helpers` package that has become a dumping
  ground. **MAJOR**
- Business logic in the handler (branching on state, computing amounts). **CRITICAL**

Use `project_report` and `module_report` for the import graph and hub files rather than
reading every file.

## extensibility — Extensibility

Run last, and filter every candidate finding through the `records` constraint list first. If a
record says there will only ever be one provider, one tenant model, or one currency, the
hardcoding is the decision — skip it silently and note the constraint under "Constraints
applied" so the reader sees it was considered.

Ask concretely: what breaks when we add integration #2, tenant/shop #N, or event #M?

- `switch` or `if` on a provider/tenant name **outside** the factory that constructs it.
  Every such site is a place someone forgets to extend. **MAJOR**
- Config shaped after one vendor (fields only vendor A can fill). **MAJOR**
- Hardcoded currency, country, locale, or unit assumptions. **MAJOR**
- Interfaces with exactly one implementation and no second one planned — the opposite
  problem, over-abstraction. **MINOR**, and only if it costs real indirection.
- Enum-ish string constants compared as literals in multiple packages instead of a
  shared typed constant. **MAJOR**

## records — Decision records and rule coverage

If `docs/bdr/` or `docs/adr/` exists, they are the specification.

```bash
dev/rule-coverage --strict        # if the repo has it
rg -n '^\*\*R[0-9]+\*\*' docs/bdr docs/adr
rg -n 'func Test(BDR|ADR)[0-9]+R[0-9]+' --type go
```

Findings:
- A numbered rule with no test naming it. **CRITICAL**
- A test naming a rule no record declares (rename drift). **CRITICAL**
- A rule without an `## Observability` row naming its history item, metric, and log.
  **MAJOR**
- A rule that is not one testable sentence ("and" twice → should be split). **MINOR**
- Business logic in the code with no rule behind it — a decision nobody recorded.
  **MAJOR**, list the code site and propose the record.
- A decision recorded but no longer matching reality — the code moved on, the record did
  not. **MAJOR**, and it invalidates the constraint that record would have produced.
- Records edited in place where the repo convention is supersede-only, or superseded
  where the convention is rewrite-in-place. Read the repo's `AGENTS.md` for which
  applies. **MAJOR**
- Cross-repo rule references not prefixed with the owning repo. **MINOR**

## tests — Test quality

Coverage percentage is not the metric. What is tested is.

- **Adversarial matrix** — for every money path and every at-least-once consumer, the
  tests must include: duplicate delivery of the same message, out-of-order arrival,
  duplicate client request id, amount/currency mismatch, missing correlation ids,
  provider decline, and concurrent inline path plus background sweep. Each missing case
  is **CRITICAL** on a money path, **MAJOR** elsewhere.
- Assertions weakened to match implementation (a test that encodes the bug). Check
  `git log -p` on test files for assertion changes shipped alongside the code change
  they were supposed to catch. **CRITICAL**
- `time.Sleep` in tests, or reliance on wall-clock ordering. **MAJOR**
- Mocks below the boundary — mocking the repository in a service test that exists to
  prove the SQL. **MAJOR**
- No test for the error path of an operation that can lose data or money. **CRITICAL**
- A function with behaviour (branch, loop, calculation, state transition, error handling,
  mapping) and no test naming it or exercising it through a caller. **MAJOR**, **CRITICAL**
  on a money, auth, or persistence path. Pure delegation, generated code, trivial
  accessors, and already-covered wiring are exempt — do not report those.
- Table-driven tests missing where there are >2 variants of the same assertion. **MINOR**
- Tests that never run (build tag, skipped, `t.Skip` with no ticket). **MAJOR**

### Postgres integration tests

Integration tests that touch Postgres **must** run against a real database provisioned by
`github.com/flachnetz/pgtest/v2` — in this codebase usually reached indirectly through
`startup/v2/lib/testx` (`testx.NewConnection(t, "<migrations-table>")`), wrapped in a
repo-local `internal/testutil` helper. Anything else is a finding:

- A DB test using `sqlmock`, a hand-rolled fake repository, or an in-memory stand-in to
  assert SQL behaviour — it proves the mock, not the query, and never catches a schema or
  constraint drift. **MAJOR**
- A test pointing at a shared or developer-local database via env DSN instead of a
  pgtest-provisioned one — non-hermetic, order-dependent, fails in CI. **MAJOR**
- Ad-hoc `testcontainers` or `docker run` wiring alongside an existing pgtest setup —
  two provisioning paths, one of them will rot. **MAJOR**
- Migrations not applied from the repo's `sql/` directory in the test database, so tests
  pass against a schema production does not have. **CRITICAL**
- No repo-local wrapper, every test file provisioning its own connection. **MINOR**

Do not report the reverse: pure unit tests with no SQL must **not** pull up a database,
and `synctest`-based tests deadlock against one — a fast unit test without pgtest is
correct.

## docs — Documentation accuracy

Compare documents against the code, not against each other.

- Every route in the router vs every route in `README.md` and the API docs. Mismatch is
  **MAJOR** (a caller reads the doc, not the router).
- Lifecycle/state-machine document vs the actual transitions and emitted events in the
  service. A stale state machine is **CRITICAL** — it is what on-call reads at 3am.
- Swagger/OpenAPI vs handler request and response structs: missing endpoint, wrong
  field name or casing, wrong status codes. **MAJOR**
- Peer-facing scenario/e2e docs listing behaviour the code no longer has. **MAJOR**
- README setup steps that no longer work (env vars renamed, commands removed). **MINOR**

Concrete pattern seen in practice: `README.md` documenting `GET /internal/v1/history`
while the router registers `/internal/backoffice/v1/payments/history`.

## rest — REST interface

- **Route group discipline**: routes are split into `/public/...` and `/internal/...`
  prefixes, and nothing else. A route outside both groups has undefined exposure.
  **CRITICAL**
- HTTP status matches fault ownership: client error → 4xx, our or upstream outage →
  5xx. A provider timeout returned as 400, or a validation failure as 500, breaks both
  alerting and client retries. **CRITICAL**
- Errors returned from the handler and rendered by one central error handler; no
  per-handler error JSON. **MAJOR**
- Request validation at the boundary (required fields, ranges, enum values) rather than
  three layers down. **CRITICAL** if an unvalidated field reaches SQL or a provider call.
- Idempotency on state-changing POSTs that a caller may retry — an idempotency key, a
  unique constraint, or a documented at-most-once guarantee. **CRITICAL** on money paths.
- List endpoints paginated and bounded; no unbounded result set. **MAJOR**
- Verb-in-path or inconsistent pluralisation across routes. **MINOR**
- Versioning consistent across the group. **MINOR**

## security — Security and route exposure

**Route exposure is the first check, and it spans code and chart.** The prefix split
only protects anything if the deployment enforces it.

1. List the routes by group from the router.
2. Read the chart/ingress/gateway config: which groups are exposed, to whom, with what
   auth.
3. Any `/internal/...` route reachable through the public gateway is **BLOCKER**.
4. A public gateway config with a catch-all path (`"path": "/"`) exposes every route
   including the internal group — flag it explicitly and name the internal routes it
   exposes. **BLOCKER**
5. A `/public/...` route with `auth: optional` or none must be safe unauthenticated —
   webhook signature, ULID/UUID unguessable id, or no sensitive data. Otherwise
   **BLOCKER**.
6. Backoffice/admin routes that mutate state (retry, cancel, refund) with no
   authorisation check beyond network placement. **CRITICAL**, name the route.

Then:
- Webhook authenticity: signature verified before any parsing that has side effects,
  constant-time comparison, per-tenant secret, replay window or event-id dedupe.
  **BLOCKER** if missing.
- Secrets: none in code, config defaults, logs, history/audit payloads, or error
  responses. Run `gitleaks` if available. **BLOCKER**.
- PII in the audit ledger or in logs. **CRITICAL**.
- Error responses leaking internals (SQL text, stack, upstream body). The cause belongs
  in the log, not the body. **CRITICAL**
- SSRF: any outbound URL built from request or config data that a tenant controls.
  **CRITICAL**
- TLS verification never disabled; no plaintext protocol for credentials. **BLOCKER**
- Injection: see persistence.

## persistence — Persistence

- **Migrations**: every schema change in a new numbered file, with Up and Down. A shipped
  migration edited in place is **BLOCKER** (environments diverge silently).
- A `Down` that does not reverse the `Up`. **MAJOR**
- Repository column lists out of sync with the schema. **CRITICAL**
- **Injection**: any SQL built by string concatenation or `fmt.Sprintf` with a value that
  is not a compile-time constant. **BLOCKER**. Identifier interpolation (table/column
  names from config) still needs an allowlist. **CRITICAL**
- Transaction boundaries: a read-modify-write across two statements without one
  transaction, or without `SELECT ... FOR UPDATE`, is a lost update. **CRITICAL** on
  money paths.
- Missing index for a column used in a `WHERE`, `JOIN`, or `ORDER BY` on a growing
  table. **MAJOR**
- Uniqueness that the business requires but only the application enforces — the
  constraint belongs in the database. **CRITICAL**
- N+1 queries in a loop. **MAJOR**
- Unbounded `SELECT` with no `LIMIT` on a table that grows. **MAJOR**
- Long-running transaction spanning an external HTTP call. **CRITICAL** (connection pool
  exhaustion under load).

## concurrency — Concurrency, load, and at-least-once

- `go test -race ./...` clean. Any race is **BLOCKER**.
- Every outbound call (HTTP, DB, broker) has a context deadline. A missing timeout is
  **CRITICAL** — it is the standard way a service dies under upstream slowness.
- Retries have bounded attempts, exponential backoff, and jitter. Unbounded retry or
  retry without backoff is **CRITICAL**.
- Retry only on retryable errors; a deterministic failure (validation, unique violation,
  terminal provider decline) must be parked, not retried until exhaustion. **CRITICAL**
- Poison messages have a park/dead-letter path with an operator-visible signal.
  **CRITICAL**
- At-least-once delivery handled idempotently: a dedupe key or unique constraint, not
  a "check then insert". **CRITICAL**
- Consumer offset committed only after the work is durable. **CRITICAL**
- Unbounded goroutine fan-out per request, or an unbounded channel/queue. **MAJOR**
- Background sweep and inline path can both process the same item — is that safe?
  **CRITICAL** on money paths.
- Connection pool sizes configured, not defaulted, when the service is
  latency-sensitive. **MINOR**

## observability — Observability

- Every business-significant action and state transition emits its audit/history item.
  A silent transition is **MAJOR** — customer care cannot reconstruct it.
- Every numbered rule's declared metric and log line actually exist, with the declared
  labels. A record promising a metric the code never emits is **CRITICAL** (the alert
  will never fire).
- Metric label semantics match the docs — verify by reading the increment site, not the
  metric name.
- **Log once**, at the layer that owns the outcome. Lower layers wrap and return; they
  do not log. Double logging is **MINOR**, missing logging on a swallowed error is
  **CRITICAL**.
- Swallowed / best-effort paths log their own warning before returning nil. **CRITICAL**
  if silent.
- Correlation id (request id, trace id) propagated into logs and into outbound calls.
  **MAJOR**
- No `fmt.Println`, `log.*`, or a second logging library beside the project's logger.
  **MINOR**

### Trace coverage

The rule: **every unit of work is inside a span, and every call that leaves the process
shows up as a child span.** Someone in Grafana must be able to answer "what did this
request talk to, and which hop was slow" without reading code.

**Trace entry points — each one must start or continue a trace:**

| Entry | Expected | Missing = |
|---|---|---|
| HTTP server | Tracing middleware on the router (`st.Tracing(service, "serve")`), continuing the inbound trace context header | **CRITICAL** |
| Incoming Kafka/queue message | A span started per message, **linked to the producer's trace** via the propagated context in the message headers — not a fresh unrelated root | **CRITICAL** |
| Cron / scheduled job | A root span per execution, named after the job, so a slow or failing sweep is visible at all | **MAJOR** |
| Outbox publisher / background worker | A span per drain cycle or per item | **MAJOR** |
| CLI / migration entry | Optional | — |

A consumer or job that runs untraced is a blind spot: its latency and errors exist in no
trace view, and the work it does looks like it came from nowhere.

**Outgoing calls — each must be a child span naming the peer:**

- HTTP client calls to another service or a provider: a client span per request, with the
  peer service name, method, route (not the full URL with ids), and status. With the
  startup lib this means the propagating transport (`st.WithSpanPropagation` /
  `st.NewPropagatingRoundTripper`) on the resty/http client, not a bare
  `http.DefaultClient`. Missing is **CRITICAL** — the trace shows a gap where a
  cross-service call happened.
- Trace context headers actually propagated outbound, so the peer's spans attach to the
  same trace. A client span that does not propagate is half the value. **CRITICAL**
- Kafka/queue produce: span with the topic, and the trace context written into the
  message headers so the consumer can continue it. **CRITICAL**
- Database calls: spans with the operation, either from an instrumented driver or an
  explicit wrapper. **MAJOR** — without it, "slow request" is unattributable.
- Cache, object store, or any other network dependency: same rule. **MAJOR**

**Span hygiene:**

- Failed operations mark the span as errored, not just log. An error-free trace over a
  failed request is a lie the dashboard tells. **MAJOR**
- Span names are low-cardinality (route templates, operation names) — never a raw URL or
  an id. Unbounded span names break trace search and cost money. **MAJOR**
- Business identifiers (payment id, order id, tenant) attached as span attributes so a
  trace is findable from a support ticket. **MINOR**, **MAJOR** on money paths.
- No PII or secrets in span attributes. **CRITICAL**
- Manually created spans always ended (`defer span.End()`), or created through the
  library's `Trace` / `TraceWithResult` helpers which end them. A leaked span is a leaked
  goroutine-scoped allocation and a broken trace. **MAJOR**
- Context carrying the span passed down; a function taking `context.Background()` mid-flow
  silently cuts the trace at that point. **CRITICAL**

### Metrics coverage

- Every outbound dependency has a request counter and a latency histogram, labelled by
  peer and outcome. Without it there is no error budget for a dependency. **MAJOR**
- Every consumer has: messages processed, failures, parked/dead-lettered, and consumer
  lag available. Missing parked-message visibility is **CRITICAL** — silent poison
  messages are how data quietly stops flowing.
- Every scheduled job has: last-success timestamp or a run counter, plus duration. A job
  that stops running must be detectable. **CRITICAL** if the job is on a money path.
- Every retry/backoff path exposes attempts and exhaustion separately. **MAJOR**
- Queue depth or pending-work gauge for anything with a backlog (outbox, retry table).
  **MAJOR**
- Metric label cardinality bounded — no id, email, URL, or free-text label. **CRITICAL**
  (this is how a metrics backend falls over).
- Metric names follow one convention across the service, prefixed with the service name.
  **MINOR**
- A metric that exists but nothing alerts on, where the record or runbook implies an
  alert. **MAJOR** — an unwatched metric is not observability.

## ops — Config and operations

- Required configuration fails fast at startup with a clear message; no zero-value
  fallback that boots a misconfigured service. **CRITICAL**
- Health and readiness endpoints exist and readiness actually reflects dependencies.
  **MAJOR**
- Graceful shutdown: signal handling, in-flight requests drained, consumers closed.
  **MAJOR**
- Chart values vs code flags/env: a flag the chart sets that the code no longer reads,
  or a required env the chart never sets. **CRITICAL** for the latter.
- Resource requests and limits set. **MINOR**
- Secrets mounted, not baked into values. **BLOCKER** if baked.
- Image build hardening (multi-stage, distroless, pinned base, non-root) is reviewed under
  `go-quality` → Container build; do not duplicate the findings here.

## dead-code — Dead code and unused surface

```bash
rg -n 'func [A-Z]' --type go        # exported surface
# with tooling, prefer:
deadcode ./... ; staticcheck -checks U1000 ./...
```

- Exported symbol with no caller inside or outside the module (check the sibling repos
  the user names, otherwise say the check is module-local). **MINOR**, batched into one
  finding with a list.
- Declared-but-unused error sentinels, config fields, feature flags. **MINOR**
- Commented-out code blocks. **MINOR**
- A whole file or package nothing imports. **MAJOR** (it rots and misleads).

Report dead code as one grouped finding, never one per symbol.

## deps — Vulnerabilities and dependencies

```bash
govulncheck ./...                 # Go-specific, call-graph aware — preferred
go list -m -u all | rg '\['       # available upgrades
trivy fs --scanners vuln .        # if installed
gitleaks detect --no-banner       # secrets in history
```

- Any `govulncheck` finding that is **reachable** (it reports this): severity mirrors the
  CVE, minimum **CRITICAL**.
- Unreachable known vulnerability: **MAJOR**, batched.
- Dependency several major versions behind, or unmaintained. **MINOR**
- `replace` directives in a committed `go.mod`. **MAJOR**
- Go version below the project's stated minimum. **MAJOR**

If no tool is installed, say so explicitly rather than guessing from `go.sum`.

## ponytail — Over-engineering pass (optional)

Only when requested. Run the `ponytail-audit` skill and fold its ranked list into the
report as a separate section with severity **MINOR** unless a simplification also removes
a correctness risk, in which case keep the risk's own severity.

---

# Output contract

## Severity definitions

| Severity | Meaning | Action |
|---|---|---|
| BLOCKER | Exploitable, or loses money or data, now | Fix before next deploy |
| CRITICAL | Will cause an incident or a wrong business outcome | Fix this sprint |
| MAJOR | Correctness or maintainability risk, no immediate incident | Schedule |
| MINOR | Nice to have, cleanliness | Batch it |

Severity is about consequence, not effort. A one-line fix can be a BLOCKER.

## Report structure

```markdown
# Service review: <repo> — <date>

## Summary
<counts per severity>, and the three things to fix first.

## Findings

### BLOCKER
| # | Area | Location | Finding | Why it matters | Fix |
|---|------|----------|---------|----------------|-----|
| 1 | security | helm-chart/values.yaml:46 | Public gateway routes `"path": "/"` with `auth: optional`, exposing all `/internal/...` routes | Backoffice refund retry is callable unauthenticated from the internet | Restrict the public gateway route list to the `/public` prefix |

### CRITICAL / MAJOR / MINOR
<same table shape>

## Verified clean
<areas and specific checks that passed — so silence is not ambiguous>

## Not checked
<areas skipped, and why>

## Constraints applied
<record ID -> what it ruled out, so the reader sees which findings were suppressed>
```

The **Verified clean** section is mandatory. Without it the reader cannot tell an area
that passed from an area that was never looked at.

## Beads

After the report, if `bd` is available in the repo, ask once:

> File BLOCKER and CRITICAL findings as beads tasks? (yes / all severities / no)

Each task must be a self-contained spec, as the repo's `AGENTS.md` requires: file paths,
what is wrong, the expected behaviour, the rule ID if one applies, and the test that
should prove the fix. Never put beads IDs into source comments.

If beads is not available, offer a checklist in a markdown file instead — and only if the
user asks for one.

# Rules for the reviewer

- Read before judging. Trace the actual flow; a finding based on a filename is noise.
- Evidence or silence. Every finding carries `file:line`.
- No duplicate findings across areas. One root cause, one row, cross-referenced.
- Do not fix anything during the review. This skill reports. Fixing is a separate task
  with its own confirmation.
- Do not propose a rewrite. Propose the smallest change that removes the risk.
- Never report a finding an accepted record already answers. Challenge it once in `records` instead.
- If an area comes back genuinely clean, say so plainly. Manufacturing findings to look
  thorough wastes more of the reader's time than missing one.
