---
name: golang
description: Write and review Go code following SonarCloud SonarGo, golangci-lint, and Effective Go best practices covering security, reliability, performance, and maintainability
---

## What I do

Guide writing and reviewing Go code compliant with SonarCloud SonarGo, golangci-lint (staticcheck, gosec, govet, errcheck, gocritic, revive, etc.), and idiomatic Go best practices. Covers security, reliability, performance, and maintainability.

## When to use me

- Writing, reviewing, or refactoring `.go` files
- Fixing SonarCloud or golangci-lint issues
- Designing Go packages, interfaces, or concurrency patterns

## Go version

**Always use Go 1.26+.** Never target or reference older versions (1.22, 1.23, 1.24, etc.) in generated code, `go.mod`, or configs.

All modern features are baseline — use them freely:

| Feature | Example |
|---------|---------|
| Range-over-int | `for i := range 10 { ... }` |
| Per-iteration loop vars | `for _, item := range items { go func() { process(item) }() }` — safe, no shadowing |
| Range-over-func (iterators) | `func All[T any](s []T) iter.Seq2[int, T] { ... }` |
| Generic type aliases | `type Set[T comparable] = map[T]struct{}` |
| `os.Root` safe file I/O | `root, _ := os.OpenRoot("/data"); f, _ := root.Open("file.txt")` |
| **`new(expr)` pointer helper** | `new(StatusVerified)`, `new("default")`, `new(string(raw))` — replaces `ptr()` helpers |

## Project setup

### Module structure
Every project MUST have `go.mod` at root. Always `go mod tidy` before committing. Commit `go.sum`.

### Local lib development (MUST FOLLOW)
When changing a lib and using it directly in the current project, use a `go.work` file. NEVER add a `replace` entry to `go.mod`. `replace` pollutes the committed module and breaks other consumers; `go.work` stays local and is gitignored.
```
go work init
go work use . ../mylib
```

### Standard layout
```
project/
├── cmd/myapp/main.go       # Main apps (minimal: parse flags, wire deps, call internal/)
├── internal/               # Private packages (compiler-enforced)
│   ├── handler/
│   ├── service/
│   └── repository/
├── pkg/                    # Public library (use sparingly)
├── api/                    # API definitions (OpenAPI, protobuf)
├── go.mod, go.sum, .golangci.yml, Makefile
```
- Never create packages named `util`, `common`, `misc`, `helpers`, `base`.
- Avoid stutter: `http.Server` not `http.HTTPServer`.

### golangci-lint config (.golangci.yml)
```yaml
version: "2"
run:
  timeout: 5m
  go: "1.26"  # minimum — never target older versions
linters:
  default: standard
  enable:
    - gosec
    - bodyclose
    - nilerr
    - exhaustive
    - noctx
    - revive
    - goconst
    - gocritic
    - godot
    - misspell
    - prealloc
    - unconvert
    - unparam
    - funlen
    - gocognit
    - cyclop
    - dupl
    - errname
    - errorlint
    - wrapcheck
  settings:
    funlen: { lines: 60, statements: 40 }
    gocognit: { min-complexity: 15 }
    cyclop: { max-complexity: 15 }
    goconst: { min-len: 3, min-occurrences: 3 }
    revive:
      rules:
        - name: exported
        - name: var-naming
        - name: error-return
        - name: error-naming
        - name: receiver-naming
        - name: context-as-argument
        - name: context-keys-type
        - name: blank-imports
        - name: unexported-return
    godot: { scope: toplevel, period: true }
formatters:
  enable: [gofumpt]
exclusions:
  presets: [comments, std-error-handling, common-false-positives]
```

## Preferred libraries

### Testing
| Library | Purpose |
|---------|---------|
| `net/http/httptest` | HTTP handler/server testing (stdlib) |
| `github.com/stretchr/testify` | Assertions (`assert`/`require`) and mocks |

```go
import (
    "net/http/httptest"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestHandler(t *testing.T) {
    rec := httptest.NewRecorder()
    req := httptest.NewRequest(http.MethodGet, "/health", nil)
    handler.ServeHTTP(rec, req)
    assert.Equal(t, http.StatusOK, rec.Code)
}
```
- Use `require` for fatal preconditions, `assert` for non-fatal checks.
- Use `require.NoError(t, err)` not `if err != nil { t.Fatal(err) }`.

#### Decision-record test naming

In repos with `docs/bdr/` or `docs/adr/`, a test that covers a numbered rule carries the rule ID
as its name prefix, so `go test` output and the coverage check both read it:

```go
// covers order-service/BDR-020-R1
func TestBDR020R1_RedeliveredRefundEventIsIgnored(t *testing.T) { ... }
func TestADR006R2_OutboxRowCommitsWithTheOrder(t *testing.T) { ... }
```

ID form in the name: `BDR`/`ADR` + 3-digit record + `R` + rule number, no separators. Subtests
inherit coverage from the parent, so a table-driven test may cover one rule with many cases.

Coverage check (wire into the repo check script; blocking):

```bash
rg -o '^\*\*R[0-9]+' -r '' docs/bdr/*.md   # rules declared
rg -o 'func Test(BDR|ADR)[0-9]+R[0-9]+' --type go  # rules covered
```

#### Test layers

| Layer | Location | Answers |
|-------|----------|---------|
| contract | `internal/client/*/client_test.go` | every documented status+code of a peer maps to the right classification (retryable vs permanent verdict vs contract fault) |
| flow | DB-backed harness (`testx.NewConnection`) | one business rule end to end: HTTP or consumer in, DB + events + history + metrics out |
| unit | package-local | pure logic, `synctest` for anything clock-driven |

A peer returning a generic wrapper (echo/startup turns a route miss into `404` with code
`Internal`) means status alone never classifies an error — assert on status **and** code.

### Application framework — `github.com/flachnetz/startup/v2`
Opinionated application bootstrap: flags, logging, metrics, tracing, Postgres, Kafka events, HTTP server, JWT auth.

**Main packages:**

| Import | Alias | Purpose |
|--------|-------|---------|
| `startup/v2` | — | `MustParseCommandLine`, app entrypoint |
| `startup/v2/startup_base` | `sb` | `FatalOnError`, `Close`, `BaseOptions` |
| `startup/v2/startup_http` | `sht` | `HTTPOptions`, `Serve(Config{...})` |
| `startup/v2/startup_logging` | `sl` | `LoggerOf(ctx)` → `*slog.Logger` |
| `startup/v2/startup_metrics` | `sm` | `MetricsOptions` |
| `startup/v2/startup_postgres` | `spg` | `PostgresOptions`, `Connection()`, migrations |
| `startup/v2/startup_tracing` | `st` | `TracingOptions`, `Tracing(name, op)` |
| `startup/v2/startup_events` | — | `EventOptions`, `EventSender(name)` |

**Lib packages:**

| Import | Purpose |
|--------|---------|
| `lib/api` | `startupapi.Error` — structured API errors with HTTP status |
| `lib/api/echo` | `CustomErrorHandler` for echo error responses |
| `lib/jwt` | `TokenVerifier`, `NewTokenVerifier(ctx, jwksURL)` |
| `lib/jwtest` | `Store()`, `Serve(t, store)` — test JWKS server |
| `lib/ql` | `TxContext`, transaction helpers |
| `lib/testx` | `NewConnection(t, migrations)`, `MustTransact(t, db, fn)` |
| `lib/clock` | `GlobalClock`, `GenerateId()` |
| `lib/events` | Event publishing, `TimeToEventTimestamp` |
| `lib/kafka` | Kafka configuration |

**Typical main.go pattern:**
```go
opts := appConfig{}
opts.Tracing.Inputs.ServiceName = "my-service"
opts.Metrics.Inputs.MetricsPrefix = "my_service"
opts.Postgres.Inputs.Initializer = spg.DefaultMigration("my_service_migrations")
startup.MustParseCommandLine(&opts)

db := opts.Postgres.Connection()
logger := sl.LoggerOf(ctx)

opts.HTTP.Serve(sht.Config{
    Name:    "my-service",
    Routing: func(mux *http.ServeMux) http.Handler { return e },
})
```

**Test utilities:**
```go
// Database + transaction helpers
db := testx.NewConnection(t, "my_service_migrations")
testx.MustTransact(t, db, func(ctx ql.TxContext) {
    // test within transaction
})

// JWT test tokens
store := jwtest.Store()
srv := jwtest.Serve(t, store)
verifier, _ := startupjwt.NewTokenVerifier(t.Context(), srv.URL)
t.Cleanup(func() { verifier.Close() })
signed := store.Sign(jwt.NewBuilder().Subject("player-1").Expiration(time.Now().Add(2*time.Hour)))
```

### HTTP client — `github.com/go-resty/resty/v2`
Fluent HTTP client with retries, middleware, and JSON marshaling.
```go
client := resty.New().
    SetBaseURL("https://api.example.com").
    SetTimeout(10 * time.Second).
    SetRetryCount(3)

var result MyResponse
resp, err := client.R().
    SetContext(ctx).
    SetHeader("Authorization", "Bearer "+token).
    SetResult(&result).
    Get("/v1/resource")
```
- Always pass `context.Context` via `SetContext(ctx)`.
- Use `SetResult`/`SetError` for automatic JSON unmarshaling.

### LRU cache — `github.com/hashicorp/golang-lru/v2`
Generic thread-safe LRU cache.
```go
import lru "github.com/hashicorp/golang-lru/v2"

cache, _ := lru.New[string, *User](1000)
cache.Add("user-123", user)
if val, ok := cache.Get("user-123"); ok { ... }
```
- Use `lru.NewWithEvict` when cleanup is needed on eviction.
- Use `lru.NewARC` for adaptive replacement cache (scan-resistant).

### Job scheduling — `github.com/go-co-op/gocron/v2`
Cron-style job scheduler.
```go
import "github.com/go-co-op/gocron/v2"

s, _ := gocron.NewScheduler()
_, _ = s.NewJob(
    gocron.DurationJob(60 * time.Second),
    gocron.NewTask(func() {
        if err := svc.ExpireOrders(ctx, timeout); err != nil {
            logger.Error("expiry job failed", "error", err)
        }
    }),
)
s.Start()
defer func() { _ = s.Shutdown() }()
```
- Use `gocron.CronJob("*/5 * * * *")` for cron expressions.
- Use `gocron.WithSingletonMode(gocron.LimitModeReschedule)` to prevent overlapping runs.

## Security rules (BLOCKER/CRITICAL)

| Rule | Don't | Do |
|------|-------|----|
| **S2068** Hardcoded creds | `const apiKey = "sk-abc"` | `os.Getenv("API_KEY")` |
| **S4423** Weak TLS | `MinVersion: tls.VersionTLS10` | `MinVersion: tls.VersionTLS12` |
| **S5527** Skip TLS verify | `InsecureSkipVerify: true` | Default `false` |
| **S5131** SQL injection | `"SELECT * WHERE id=" + id` | `db.Query("... $1", id)` |
| **S5131** Cmd injection | `exec.Command("sh","-c","ls "+input)` | `exec.Command("ls", input)` |
| **S2245** Insecure random | `math/rand` for tokens | `crypto/rand` |
| **S4790** Weak hashing | `crypto/md5`, `crypto/sha1` | `crypto/sha256` |
| **S5542** Weak encryption | `crypto/des`, `crypto/rc4` | `crypto/aes` + GCM |
| **S5332** Clear-text proto | `http://...` | `https://...` |
| **G104** Ignored errors | `json.Unmarshal(d, &r)` | `if err := ...; err != nil` |
| **G110** Decomp bombs | `io.Copy(dst, gzReader)` | `io.Copy(dst, io.LimitReader(gz, max))` |
| **G114** No server timeout | `http.ListenAndServe(...)` | `&http.Server{ReadTimeout: 5s, ...}` |
| **G301-G306** Perms | `os.Mkdir("d", 0777)` | `os.Mkdir("d", 0750)` |
| **G304** Path traversal | `os.ReadFile(userInput)` | Validate `filepath.Clean` + prefix check |

## Reliability rules

| Rule | Summary |
|------|---------|
| **errcheck** | Every error return MUST be checked — most important Go rule |
| **bodyclose** | Always `defer resp.Body.Close()` after HTTP calls |
| **nilerr** | Never `return nil` when `err != nil` |
| **exhaustive** | Switch on typed constants must cover all cases or have `default` |
| **S1763** | No unreachable code after return/panic |
| **S2201** | Don't discard return values of pure functions |
| **errorlint** | Use `errors.Is()`/`errors.As()`, not `==` or type assertion |
| **wrapcheck** | Wrap errors from external packages: `fmt.Errorf("ctx: %w", err)` |
| **noctx** | HTTP requests must use `http.NewRequestWithContext(ctx, ...)` |

## Performance

- **Preallocate slices**: `make([]T, 0, len(items))` when size known
- **strings.Builder**: for concatenation in loops
- **sync.Pool**: for frequently allocated objects
- **strconv.Itoa(n)**: not `fmt.Sprintf("%d", n)`
- **Escape analysis**: `go build -gcflags="-m"` to check heap escapes
- Prefer value receivers for small structs

## Maintainability rules

### Naming
- `MixedCaps`/`mixedCaps` only — never `snake_case`
- Acronyms all-caps: `ID`, `HTTP`, `URL`, `API`, `JSON`, `SQL`
- Interfaces with single method: method + `er` → `Reader`, `Writer`
- Error vars: `ErrNotFound`. Error types: `NotFoundError`
- Receiver: 1-2 letter abbreviation, consistent. Never `this`/`self`
- Package: lowercase single word, no underscores

### Functions
- Max **60 lines / 40 statements** (funlen)
- Cognitive complexity < **15** (gocognit/cyclop)
- Max **5 parameters** — use option structs or functional options beyond that
- `context.Context` always first parameter

### Code hygiene
- Remove commented-out code (S125)
- TODO/FIXME must include ticket ref: `// TODO(PROJ-1234): ...`
- String literal used 3+ times → `const` (goconst)
- Switch must have `default:` case (S131)
- Collapse nested ifs: `if a { if b { ... } }` → `if a && b { ... }`
- Exported functions must have doc comment starting with function name

### Context keys
```go
// Never use built-in types as context keys
type contextKey string
const userIDKey contextKey = "userID"
ctx = context.WithValue(ctx, userIDKey, id)
```

## Idiomatic patterns

### Error handling
```go
// Wrap with context
f, err := os.Open(path)
if err != nil {
    return fmt.Errorf("opening %s: %w", path, err)
}
defer f.Close()

// Inspect errors
if errors.Is(err, sql.ErrNoRows) { ... }
var pathErr *os.PathError
if errors.As(err, &pathErr) { ... }
```

### Goroutines
- Always recover panics in goroutines
- Always ensure goroutines can be stopped (context, done channel)
- Use `errgroup.WithContext` for coordinated goroutines
- Senders close channels, never receivers

```go
g, ctx := errgroup.WithContext(ctx)
for _, item := range items {
    g.Go(func() error { return process(ctx, item) })
}
if err := g.Wait(); err != nil { ... }
```

### Interfaces
Accept interfaces, return structs. Keep small (1-3 methods). Define at consumer side.

### Struct init
Always use named fields:
```go
srv := Server{Host: "localhost", Port: 8080}
```

### Resource cleanup
```go
f, err := os.Open(path)
if err != nil { return err }
defer f.Close() // immediately after acquiring
```

### Logging (log/slog)
```go
logger.Info("processing", slog.String("method", r.Method), slog.Int("status", code))
```
Never `fmt.Println` or `log.Printf` in production.

### Testing
```go
// Table-driven tests
func TestAdd(t *testing.T) {
    tests := []struct {
        name    string
        a, b    int
        want    int
    }{
        {"positive", 1, 2, 3},
        {"negative", -1, -2, -3},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            assert.Equal(t, tt.want, Add(tt.a, tt.b))
        })
    }
}
```
- Use `t.Helper()` in helpers, `t.Parallel()` when safe
- Always `go test -race ./...`

## Tooling

```sh
gofumpt -l -w .                    # strict formatting
go vet ./...                       # compiler-adjacent checks
golangci-lint run                  # meta-linter (50+ linters)
golangci-lint run --fix            # auto-fix
gosec ./...                        # security scanner
go test -race -count=1 ./...       # tests with race detector
go test -race -coverprofile=c.out ./... && go tool cover -html=c.out  # coverage
```

### Makefile
```makefile
.PHONY: fmt vet lint test build check
fmt:   ; gofumpt -l -w .
vet:   ; go vet ./...
lint:  ; golangci-lint run
test:  ; go test -race -count=1 ./...
build: ; go build ./...
check: fmt vet lint test build
```

## Checklist — new files

- [ ] Package lowercase, single word
- [ ] Exported symbols have doc comment starting with name
- [ ] `context.Context` first param where appropriate
- [ ] All errors checked and wrapped with `fmt.Errorf("ctx: %w", err)`
- [ ] Error vars `ErrXxx`, error types `XxxError`
- [ ] `MixedCaps` naming, acronyms all-caps
- [ ] 1-2 letter receiver, consistent across methods
- [ ] No hardcoded creds, no `math/rand` for security, TLS 1.2+
- [ ] SQL parameterized, file perms restrictive
- [ ] HTTP servers have timeouts
- [ ] Goroutines have panic recovery and shutdown mechanism
- [ ] Slices preallocated, `strings.Builder` for loops
- [ ] `defer` immediately after resource acquisition
- [ ] Named struct fields, switch has `default:`
- [ ] Functions <60 lines, complexity <15
- [ ] No commented-out code, no unused vars
- [ ] `go vet`, `golangci-lint run`, `go test -race` pass

## Checklist — code review

- [ ] No injection (SQL: G201/G202, cmd: G204)
- [ ] No hardcoded creds (S2068/G101), strong crypto (S4790/S5542)
- [ ] TLS verified (S5527), secure random (S2245/G404)
- [ ] All errors handled (errcheck), HTTP bodies closed (bodyclose)
- [ ] Errors wrapped not swallowed (nilerr, wrapcheck, errorlint)
- [ ] `errors.Is()`/`errors.As()` used (errorlint)
- [ ] Context propagated (noctx), no goroutine leaks
- [ ] Race-safe (`-race`), pure function returns used (S2201)
- [ ] No duplicate literals (goconst), all paths reachable (S1763)
