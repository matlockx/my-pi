---
name: golang
description: Write and review Go code following SonarCloud SonarGo, golangci-lint, and Effective Go best practices covering security, reliability, performance, and maintainability
---

## What I do

Guide writing and reviewing Go code that is compliant with SonarCloud's SonarGo analysis rules, golangci-lint's comprehensive linter suite (staticcheck, gosec, govet, errcheck, gocritic, revive, and more), and idiomatic Go best practices from Effective Go and the Go community. This covers security vulnerabilities, reliability bugs, performance pitfalls, and maintainability code smells.

## When to use me

Use this skill when:
- Writing new Go files (`.go`)
- Reviewing or refactoring existing Go code
- Fixing SonarCloud or golangci-lint issues in Go projects
- Setting up Go project tooling (golangci-lint, gosec, go vet)
- Preparing Go code for CI/CD pipelines that run SonarCloud or golangci-lint analysis
- Designing Go packages, interfaces, or concurrency patterns

## Project setup

### Module structure

Every Go project MUST have a `go.mod` at the root:
```
module github.com/org/project

go 1.22

require (
    // pinned dependencies
)
```

- Always run `go mod tidy` before committing.
- Commit `go.sum` to version control.
- Use Go 1.21+ for `log/slog`, 1.22+ for range-over-int and enhanced routing.

### Standard project layout

```
project/
├── cmd/                    # Main applications (one dir per binary)
│   └── myapp/
│       └── main.go
├── internal/               # Private packages (not importable by other modules)
│   ├── handler/
│   ├── service/
│   └── repository/
├── pkg/                    # Public library packages (optional, use sparingly)
├── api/                    # API definitions (OpenAPI specs, protobuf)
├── configs/                # Configuration file templates
├── scripts/                # Build and CI scripts
├── go.mod
├── go.sum
├── .golangci.yml
└── Makefile
```

- `internal/` is enforced by the Go compiler -- other modules cannot import it.
- `cmd/` should contain minimal code: parse flags, wire dependencies, call `internal/`.
- Avoid `pkg/` unless you explicitly intend the package to be a public library.
- Never create packages named `util`, `common`, `misc`, `helpers`, or `base`.

### golangci-lint configuration

Create `.golangci.yml` at the project root:

```yaml
version: "2"

run:
  timeout: 5m
  go: "1.22"

linters:
  default: standard
  enable:
    # Security
    - gosec
    # Bugs
    - bodyclose
    - nilerr
    - exhaustive
    - noctx
    # Style & maintainability
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
    funlen:
      lines: 60
      statements: 40
    gocognit:
      min-complexity: 15
    cyclop:
      max-complexity: 15
    goconst:
      min-len: 3
      min-occurrences: 3
    revive:
      rules:
        - name: exported
        - name: var-naming
        - name: error-return
        - name: error-naming
        - name: receiver-naming
        - name: increment-decrement
        - name: range
        - name: context-as-argument
        - name: context-keys-type
        - name: blank-imports
        - name: unexported-return
    gosec:
      excludes: []
    godot:
      scope: toplevel
      period: true

formatters:
  enable:
    - gofumpt

exclusions:
  presets:
    - comments
    - std-error-handling
    - common-false-positives
```

## SonarCloud SonarGo rules - Security

### S2068 - Do not hardcode credentials (BLOCKER)
Never embed passwords, tokens, API keys, or secrets in source code. Use environment variables or secret managers.
```go
// BAD
const apiKey = "sk-abc123secret"
password := "admin123"
dsn := "postgres://user:pass@host/db"

// GOOD
apiKey := os.Getenv("API_KEY")
password := os.Getenv("DB_PASSWORD")
```
gosec equivalent: G101 (hardcoded credentials)

### S4423 - Do not use weak SSL/TLS protocols (CRITICAL)
Never allow TLS versions below 1.2.
```go
// BAD
tlsConfig := &tls.Config{
    MinVersion: tls.VersionTLS10,
}
tlsConfig := &tls.Config{
    MinVersion: tls.VersionSSL30,
}

// GOOD
tlsConfig := &tls.Config{
    MinVersion: tls.VersionTLS12,
}
```
gosec equivalent: G402

### S5527 - Always verify server certificates (CRITICAL)
Never disable TLS certificate verification.
```go
// BAD
tlsConfig := &tls.Config{
    InsecureSkipVerify: true,
}
client := &http.Client{
    Transport: &http.Transport{
        TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
    },
}

// GOOD
tlsConfig := &tls.Config{
    MinVersion: tls.VersionTLS12,
}
// InsecureSkipVerify defaults to false
```
gosec equivalent: G402

### S5131 - Sanitize input to prevent injection (BLOCKER)
Never concatenate user input into SQL queries or OS commands.
```go
// BAD - SQL injection
query := "SELECT * FROM users WHERE id = " + userID
db.Query(fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name))

// GOOD - parameterized queries
db.Query("SELECT * FROM users WHERE id = $1", userID)
db.QueryRow("SELECT * FROM users WHERE name = $1", name)

// BAD - command injection
exec.Command("sh", "-c", "ls " + userInput)

// GOOD
exec.Command("ls", userInput)
```
gosec equivalent: G201 (SQL string formatting), G202 (SQL string concatenation), G204 (command injection)

### S2245 - Do not use math/rand for security purposes (CRITICAL)
`math/rand` is not cryptographically secure. Use `crypto/rand` for tokens, keys, and secrets.
```go
// BAD
import "math/rand"
token := rand.Int63()
sessionID := fmt.Sprintf("%x", rand.Int63())

// GOOD
import "crypto/rand"
b := make([]byte, 32)
_, err := rand.Read(b)
if err != nil {
    return fmt.Errorf("generating token: %w", err)
}
token := hex.EncodeToString(b)
```
gosec equivalent: G404

### S4790 - Avoid weak hashing algorithms (CRITICAL)
Do not use MD5 or SHA1 for security purposes. Use SHA-256 or stronger.
```go
// BAD
import "crypto/md5"
h := md5.New()

import "crypto/sha1"
h := sha1.New()

// GOOD
import "crypto/sha256"
h := sha256.New()
```
gosec equivalent: G401 (MD5), G505 (SHA1)

### S5332 - Do not use clear-text protocols (CRITICAL)
Avoid HTTP, FTP, Telnet. Always prefer HTTPS, SFTP, SSH.
```go
// BAD
resp, err := http.Get("http://example.com/api")

// GOOD
resp, err := http.Get("https://example.com/api")
```

### S5542 - Do not use weak encryption algorithms (CRITICAL)
Avoid DES, 3DES, RC4. Use AES-GCM or ChaCha20-Poly1305.
```go
// BAD
import "crypto/des"
block, _ := des.NewCipher(key)

import "crypto/rc4"
cipher, _ := rc4.NewCipher(key)

// GOOD
import "crypto/aes"
import "crypto/cipher"
block, _ := aes.NewCipher(key)
gcm, _ := cipher.NewGCM(block)
```
gosec equivalent: G405 (DES), G406 (deprecated crypto)

### gosec G104 - Do not ignore errors (MAJOR)
Every error return value must be checked. This is also enforced by `errcheck`.
```go
// BAD
json.Unmarshal(data, &result)
f.Close()
http.ListenAndServe(":8080", nil)

// GOOD
if err := json.Unmarshal(data, &result); err != nil {
    return fmt.Errorf("unmarshalling: %w", err)
}
defer func() {
    if err := f.Close(); err != nil {
        log.Printf("closing file: %v", err)
    }
}()
```

### gosec G110 - Protect against decompression bombs (MAJOR)
Limit the size of decompressed data to prevent denial of service.
```go
// BAD
io.Copy(dst, gzipReader)

// GOOD
limited := io.LimitReader(gzipReader, maxDecompressedSize)
if _, err := io.Copy(dst, limited); err != nil {
    return fmt.Errorf("decompressing: %w", err)
}
```

### gosec G114 - Always set timeouts on HTTP servers (MAJOR)
Using `http.ListenAndServe` with default timeouts allows slowloris attacks.
```go
// BAD
http.ListenAndServe(":8080", handler)

// GOOD
srv := &http.Server{
    Addr:         ":8080",
    Handler:      handler,
    ReadTimeout:  5 * time.Second,
    WriteTimeout: 10 * time.Second,
    IdleTimeout:  120 * time.Second,
}
if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
    log.Fatalf("server error: %v", err)
}
```

### gosec G301-G306 - File permission issues (MAJOR)
Do not create files or directories with world-writable permissions.
```go
// BAD
os.Mkdir("dir", 0777)
os.WriteFile("file.txt", data, 0666)

// GOOD
os.Mkdir("dir", 0750)
os.WriteFile("file.txt", data, 0600)
```

### gosec G304 - Do not use user-controlled paths for file operations (MAJOR)
Sanitize and validate file paths from user input to prevent path traversal.
```go
// BAD
data, err := os.ReadFile(userInput)

// GOOD
cleanPath := filepath.Clean(userInput)
if !strings.HasPrefix(cleanPath, allowedBaseDir) {
    return fmt.Errorf("path traversal attempt: %s", userInput)
}
data, err := os.ReadFile(cleanPath)
```

### gosec G501-G505 - Blocklisted imports (MAJOR)
Do not import deprecated or insecure crypto packages:
- `crypto/md5` (G501)
- `crypto/des` (G502)
- `crypto/rc4` (G503)
- `net/http/cgi` (G504)
- `crypto/sha1` (G505) -- for security use only; fine for checksums

## SonarCloud SonarGo rules - Reliability

### S1763 - All code paths should be reachable (MAJOR)
Do not place code after `return`, `panic`, `os.Exit`, or `log.Fatal`.
```go
// BAD
func process() error {
    return nil
    cleanup() // unreachable
}

// GOOD
func process() error {
    cleanup()
    return nil
}
```
staticcheck equivalent: SA4004

### S2201 - Do not ignore return values (MAJOR)
Functions that return values without side effects should have their return values used.
```go
// BAD
strings.Replace(s, "old", "new", -1) // result discarded
fmt.Sprintf("hello %s", name)        // result discarded

// GOOD
result := strings.Replace(s, "old", "new", -1)
msg := fmt.Sprintf("hello %s", name)
```
Enforced by: errcheck, staticcheck SA4006

### S1656 - Do not self-assign variables (MAJOR)
```go
// BAD
x = x

// GOOD - if transforming, make it explicit
x = transform(x)
```

### S1764 - Do not use identical expressions on both sides of an operator (MAJOR)
Almost always a copy-paste bug.
```go
// BAD
if x == x { ... }
result := x - x

// GOOD
if x == y { ... }
result := x - y
```

### S3516 - Functions should not always return the same value (MAJOR)
If every code path returns the same literal, the return value is meaningless.
```go
// BAD
func validate(data string) bool {
    if data == "" {
        return true
    }
    return true
}

// GOOD
func validate(data string) bool {
    if data == "" {
        return false
    }
    return true
}
```

### errcheck - All error returns must be checked (CRITICAL)
This is the single most important Go reliability rule. Never discard an error.
```go
// BAD
file, _ := os.Open("config.json")
result, _ := strconv.Atoi(input)

// GOOD
file, err := os.Open("config.json")
if err != nil {
    return fmt.Errorf("opening config: %w", err)
}

result, err := strconv.Atoi(input)
if err != nil {
    return fmt.Errorf("parsing integer %q: %w", input, err)
}
```

### bodyclose - Always close HTTP response bodies (CRITICAL)
Leaking response bodies causes resource exhaustion.
```go
// BAD
resp, err := http.Get(url)
if err != nil {
    return err
}
// forgot to close body

// GOOD
resp, err := http.Get(url)
if err != nil {
    return fmt.Errorf("fetching %s: %w", url, err)
}
defer resp.Body.Close()
```

### nilerr - Do not return nil when err is not nil (CRITICAL)
```go
// BAD
result, err := doSomething()
if err != nil {
    return nil // swallows the error
}

// GOOD
result, err := doSomething()
if err != nil {
    return fmt.Errorf("doing something: %w", err)
}
```

### exhaustive - Switch on enums must be exhaustive (MAJOR)
When switching on a typed constant (enum), cover all cases or add a default.
```go
type Status int
const (
    Active Status = iota
    Inactive
    Pending
)

// BAD - missing Pending case
switch s {
case Active:
    // ...
case Inactive:
    // ...
}

// GOOD
switch s {
case Active:
    // ...
case Inactive:
    // ...
case Pending:
    // ...
}
```

### go vet - Standard compiler-adjacent checks (CRITICAL)
go vet catches:
- **printf format mismatches**: `fmt.Printf("%d", stringVar)` -- wrong format verb
- **copylocks**: copying a `sync.Mutex` or types containing one
- **unreachable code**: statements after return/panic
- **struct tags**: malformed or duplicate JSON/XML struct tags
- **nil function comparison**: comparing function to nil
- **atomic misuse**: non-atomic operations on `sync/atomic` values

All go vet findings should be treated as bugs.

### staticcheck SA - Selected correctness rules
```go
// SA1012 - Do not pass nil context
// BAD
doWork(nil, data)
// GOOD
doWork(context.Background(), data)

// SA1029 - Do not use built-in types as context keys
// BAD
ctx = context.WithValue(ctx, "key", value)
// GOOD
type contextKey string
const myKey contextKey = "key"
ctx = context.WithValue(ctx, myKey, value)

// SA4006 - Assigned value is never used
// BAD
result, err := compute()
result = recompute() // first result wasted
// GOOD
_, err := compute()
result := recompute()

// SA9003 - Empty body in if/else branch
// BAD
if condition {
} else {
    doWork()
}
// GOOD
if !condition {
    doWork()
}
```

## Performance

### Preallocate slices when length is known or estimable
```go
// BAD
var result []string
for _, item := range items {
    result = append(result, item.Name)
}

// GOOD
result := make([]string, 0, len(items))
for _, item := range items {
    result = append(result, item.Name)
}
```
golangci-lint: prealloc

### Avoid fmt.Sprintf for simple conversions
```go
// BAD
s := fmt.Sprintf("%d", n)
s := fmt.Sprintf("%s", str) // unnecessary

// GOOD
s := strconv.Itoa(n)
s := str
```

### Use strings.Builder for string concatenation in loops
```go
// BAD
result := ""
for _, s := range items {
    result += s + ","
}

// GOOD
var b strings.Builder
for _, s := range items {
    b.WriteString(s)
    b.WriteByte(',')
}
result := b.String()
```

### Use sync.Pool for frequently allocated objects
```go
var bufPool = sync.Pool{
    New: func() any {
        return new(bytes.Buffer)
    },
}

func process(data []byte) {
    buf := bufPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufPool.Put(buf)
    }()
    // use buf
}
```

### Avoid unnecessary heap escapes
- Prefer value receivers for small structs.
- Use stack-friendly patterns; avoid returning pointers to local variables when unnecessary.
- Use `go build -gcflags="-m"` to check escape analysis.

### Range loop variable semantics
In Go 1.22+, range loop variables are per-iteration (no longer shared). For older versions:
```go
// BAD (Go <1.22) - closure captures shared loop variable
for _, item := range items {
    go func() {
        process(item) // all goroutines may see last item
    }()
}

// GOOD (Go <1.22) - capture explicitly
for _, item := range items {
    item := item
    go func() {
        process(item)
    }()
}

// Go 1.22+ - per-iteration scoping, no shadowing needed
for _, item := range items {
    go func() {
        process(item) // safe
    }()
}
```

## SonarCloud SonarGo rules - Maintainability

### S100 - Follow Go naming conventions (MINOR)
Go uses `MixedCaps` (exported) and `mixedCaps` (unexported). Never use `snake_case` for Go identifiers.
```go
// BAD
func get_user_by_id(user_id int) (*User, error) { ... }
var max_retry_count = 3

// GOOD
func GetUserByID(userID int) (*User, error) { ... } // exported
func getUserByID(userID int) (*User, error) { ... } // unexported
var maxRetryCount = 3
```
- Acronyms are all-caps: `ID`, `HTTP`, `URL`, `API`, `JSON`, `XML`, `SQL`, `SSH`, `TLS`.
- Interfaces with a single method: name is method + `er` suffix: `Reader`, `Writer`, `Closer`, `Stringer`.
revive equivalent: var-naming, exported

### S107 - Functions should not have too many parameters (MAJOR)
Limit functions to 5 parameters maximum. Use option structs or functional options for configuration.
```go
// BAD
func CreateUser(name, email string, age int, address, phone, role, department string) error { ... }

// GOOD - option struct
type CreateUserParams struct {
    Name       string
    Email      string
    Age        int
    Address    string
    Phone      string
    Role       string
    Department string
}
func CreateUser(params CreateUserParams) error { ... }

// GOOD - functional options (for constructors)
type Option func(*Server)
func WithPort(port int) Option { return func(s *Server) { s.port = port } }
func NewServer(opts ...Option) *Server { ... }
```

### S138 - Functions should not be too long (MAJOR)
Functions should not exceed 60 lines / 40 statements. Break large functions into smaller, focused helpers.
golangci-lint: funlen

### S3776 - Reduce cognitive complexity (CRITICAL)
Deeply nested and branching code is hard to understand. Refactor functions with cognitive complexity above 15.
- Use early returns (guard clauses).
- Extract helper functions.
- Replace complex conditions with named booleans.
```go
// BAD - deeply nested
func process(data []Item) error {
    if data != nil {
        for _, item := range data {
            if item.IsValid() {
                if item.Type == "A" {
                    for _, sub := range item.Children {
                        if sub.Active {
                            if err := handle(sub); err != nil {
                                return err
                            }
                        }
                    }
                }
            }
        }
    }
    return nil
}

// GOOD - flat with early returns and helpers
func process(data []Item) error {
    if data == nil {
        return nil
    }
    for _, item := range data {
        if err := processItem(item); err != nil {
            return fmt.Errorf("processing item %s: %w", item.ID, err)
        }
    }
    return nil
}

func processItem(item Item) error {
    if !item.IsValid() || item.Type != "A" {
        return nil
    }
    for _, sub := range item.Children {
        if !sub.Active {
            continue
        }
        if err := handle(sub); err != nil {
            return fmt.Errorf("handling sub %s: %w", sub.ID, err)
        }
    }
    return nil
}
```
golangci-lint: gocognit, cyclop

### S1481 - Remove unused variables (MINOR)
Do not declare variables that are never read.
```go
// BAD
func process() {
    unused := compute()
    return otherCompute()
}

// GOOD
func process() {
    return otherCompute()
}
```
Enforced by: go vet, unused, ineffassign

### S1192 - Do not duplicate string literals (MINOR)
If the same string appears 3+ times, assign it to a constant.
```go
// BAD
log.Print("processing stage: compilation")
notify("processing stage: compilation")
record("processing stage: compilation")

// GOOD
const stageCompilation = "processing stage: compilation"
log.Print(stageCompilation)
notify(stageCompilation)
record(stageCompilation)
```
golangci-lint: goconst

### S131 - Switch should have a default case (CRITICAL)
Unless switching on a type with exhaustive coverage, always include `default:`.
```go
// BAD
switch action {
case "start":
    doStart()
case "stop":
    doStop()
}

// GOOD
switch action {
case "start":
    doStart()
case "stop":
    doStop()
default:
    return fmt.Errorf("unknown action: %s", action)
}
```

### S1066 - Collapse mergeable if statements (MAJOR)
```go
// BAD
if a {
    if b {
        process()
    }
}

// GOOD
if a && b {
    process()
}
```
golangci-lint: gocritic (nestingReduce)

### S125 - Remove commented-out code (MAJOR)
Commented-out code is dead code. Remove it; version control preserves history.
```go
// BAD
// func oldProcess() {
//     return legacyCompute()
// }

// GOOD - just delete it
```

### S1135 - Track TODO/FIXME comments (INFO)
`TODO` and `FIXME` comments should include a ticket reference.
```go
// BAD
// TODO: fix this later

// GOOD
// TODO(PROJ-1234): refactor to use streaming client
```

### revive - Go-specific style rules

#### Exported functions must have documentation comments
```go
// BAD
func ProcessData(data []byte) error { ... }

// GOOD - 1-line purpose, don't restate the signature
// ProcessData transforms raw bytes into the canonical format.
func ProcessData(data []byte) error { ... }
```
Comment must start with the function name. Max 3 lines. Never restate what the signature already says.

#### Error variables should be named errXxx
```go
// BAD
var NotFound = errors.New("not found")

// GOOD
var ErrNotFound = errors.New("not found")
```
revive: error-naming

#### Error types should be named XxxError
```go
// BAD
type NotFound struct{ ID string }

// GOOD
type NotFoundError struct{ ID string }
func (e *NotFoundError) Error() string { return fmt.Sprintf("not found: %s", e.ID) }
```
revive: errname (golangci-lint: errname)

#### Receiver names should be short and consistent
```go
// BAD
func (this *Server) Handle(r *http.Request) { ... }
func (server *Server) Close() error { ... }
func (self *Server) Start() error { ... }

// GOOD - short, consistent across all methods
func (s *Server) Handle(r *http.Request) { ... }
func (s *Server) Close() error { ... }
func (s *Server) Start() error { ... }
```
Never use `this`, `self`, or the full type name. Use 1-2 letter abbreviation, consistent across all methods.
revive: receiver-naming

#### context.Context must be the first parameter
```go
// BAD
func FetchUser(userID string, ctx context.Context) (*User, error) { ... }

// GOOD
func FetchUser(ctx context.Context, userID string) (*User, error) { ... }
```
revive: context-as-argument

#### Do not use built-in types as context keys
```go
// BAD
ctx = context.WithValue(ctx, "userID", id)

// GOOD
type contextKey string
const userIDKey contextKey = "userID"
ctx = context.WithValue(ctx, userIDKey, id)
```
staticcheck: SA1029

## Effective Go and idiomatic patterns

### Error handling

Always check errors. Wrap them with context using `fmt.Errorf` and the `%w` verb:
```go
f, err := os.Open(path)
if err != nil {
    return fmt.Errorf("opening %s: %w", path, err)
}
defer f.Close()
```

Use `errors.Is()` and `errors.As()` for error inspection (not `==` or type assertion):
```go
// BAD
if err == sql.ErrNoRows { ... }
if e, ok := err.(*os.PathError); ok { ... }

// GOOD
if errors.Is(err, sql.ErrNoRows) { ... }
var pathErr *os.PathError
if errors.As(err, &pathErr) { ... }
```

Define sentinel errors and custom error types for your domain:
```go
var (
    ErrNotFound     = errors.New("not found")
    ErrUnauthorized = errors.New("unauthorized")
)

type ValidationError struct {
    Field   string
    Message string
}
func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation error on %s: %s", e.Field, e.Message)
}
```

golangci-lint: errorlint (checks proper `errors.Is`/`errors.As` usage), wrapcheck (ensures errors from external packages are wrapped)

### Context usage

Always pass `context.Context` as the first parameter. Respect cancellation:
```go
func FetchData(ctx context.Context, id string) (*Data, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("fetching data: %w", err)
    }
    defer resp.Body.Close()
    // ...
}
```

Never store `context.Context` in a struct. Always pass it as a parameter.
golangci-lint: noctx (detects HTTP requests without context)

### Goroutines and concurrency

Always handle panics in goroutines:
```go
go func() {
    defer func() {
        if r := recover(); r != nil {
            log.Printf("recovered panic: %v", r)
        }
    }()
    doWork()
}()
```

Use `errgroup` for coordinating goroutines with error propagation:
```go
import "golang.org/x/sync/errgroup"

g, ctx := errgroup.WithContext(ctx)
for _, item := range items {
    g.Go(func() error {
        return process(ctx, item)
    })
}
if err := g.Wait(); err != nil {
    return fmt.Errorf("processing items: %w", err)
}
```

Channel ownership rules:
- The goroutine that creates a channel should close it.
- Senders close channels, never receivers.
- When in doubt, use `sync.WaitGroup` or `errgroup` instead of bare channels.

Never launch goroutines without ensuring they can be stopped (via context cancellation, done channel, or similar):
```go
// BAD - goroutine leak
go func() {
    for {
        process()
        time.Sleep(time.Second)
    }
}()

// GOOD
go func() {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            process()
        }
    }
}()
```

### Interfaces

Accept interfaces, return structs. Keep interfaces small (1-3 methods).
```go
// BAD - too large, too specific
type UserManager interface {
    CreateUser(ctx context.Context, u User) error
    GetUser(ctx context.Context, id string) (*User, error)
    UpdateUser(ctx context.Context, u User) error
    DeleteUser(ctx context.Context, id string) error
    ListUsers(ctx context.Context) ([]User, error)
    SearchUsers(ctx context.Context, q string) ([]User, error)
}

// GOOD - small, focused interfaces
type UserReader interface {
    GetUser(ctx context.Context, id string) (*User, error)
}

type UserWriter interface {
    CreateUser(ctx context.Context, u User) error
}
```

Define interfaces at the consumer side, not the provider side.
The standard library interfaces (`io.Reader`, `io.Writer`, `io.Closer`, `fmt.Stringer`) are the gold standard.

### Struct initialization

Always use named fields. Never use positional initialization for structs with more than one field.
```go
// BAD
srv := Server{"localhost", 8080, nil, false}

// GOOD
srv := Server{
    Host:    "localhost",
    Port:    8080,
    Handler: nil,
    Debug:   false,
}
```

### Package design

- Package names are lowercase, single words. No underscores, no mixedCaps.
- Package name should describe what it provides, not what it contains.
- Avoid stutter: `http.HTTPServer` is bad, `http.Server` is good.
- Avoid `package util`, `package common`, `package base`, `package shared`.
```go
// BAD
package string_utils
func StringUtilsFormatName(name string) string { ... }

// GOOD
package names
func Format(name string) string { ... }
```

### Testing

Use table-driven tests:
```go
func TestAdd(t *testing.T) {
    tests := []struct {
        name string
        a, b int
        want int
    }{
        {name: "positive", a: 1, b: 2, want: 3},
        {name: "negative", a: -1, b: -2, want: -3},
        {name: "zero", a: 0, b: 0, want: 0},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := Add(tt.a, tt.b)
            if got != tt.want {
                t.Errorf("Add(%d, %d) = %d, want %d", tt.a, tt.b, got, tt.want)
            }
        })
    }
}
```

- Use `t.Helper()` in test helper functions.
- Use `t.Parallel()` for tests that can run concurrently.
- Test files go in the same package (`foo_test.go`) or `foo_test` package for black-box testing.
- Name test functions `TestXxx`, benchmarks `BenchmarkXxx`, examples `ExampleXxx`.
- Use `testing/fstest`, `net/http/httptest`, and `io` test helpers from the stdlib.
- Always run tests with `-race`: `go test -race ./...`

### Logging

Use structured logging with `log/slog` (Go 1.21+):
```go
import "log/slog"

logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
}))

logger.Info("processing request",
    slog.String("method", r.Method),
    slog.String("path", r.URL.Path),
    slog.Int("status", statusCode),
)
```

Never use `fmt.Println` or `log.Printf` for application logging in production code.

### Resource cleanup with defer

- Use `defer` immediately after acquiring a resource.
- Remember defer is LIFO (last in, first out).
- Defer runs when the surrounding function returns, not at block end.
```go
f, err := os.Open(path)
if err != nil {
    return err
}
defer f.Close() // immediately after acquiring

mu.Lock()
defer mu.Unlock() // immediately after acquiring
```

For deferred calls that return errors (like `f.Close()`), use a named return:
```go
func readFile(path string) (data []byte, err error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, fmt.Errorf("opening: %w", err)
    }
    defer func() {
        if cerr := f.Close(); cerr != nil && err == nil {
            err = fmt.Errorf("closing: %w", cerr)
        }
    }()
    return io.ReadAll(f)
}
```

## Tooling integration

### go vet (standard static analysis)
```sh
go vet ./...
```
Built into the Go toolchain. Catches printf format bugs, copylocks, unreachable code, struct tag issues.

### gofumpt (strict formatting)
Stricter than `gofmt`, enforces additional formatting rules.
```sh
# Install
go install mvdan.cc/gofumpt@latest
# Run
gofumpt -l -w .
```

### golangci-lint (meta-linter)
Runs 50+ linters in a single pass.
```sh
# Install
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
# or
brew install golangci-lint
# Run
golangci-lint run
# Run with auto-fix
golangci-lint run --fix
```

### gosec (security scanner)
```sh
# Install
go install github.com/securego/gosec/v2/cmd/gosec@latest
# Run
gosec ./...
```

### Running tests
```sh
# All tests with race detector
go test -race -count=1 ./...
# With coverage
go test -race -coverprofile=coverage.out ./...
go tool cover -html=coverage.out
# Specific package
go test -race -v ./internal/handler/...
```

### Pre-commit configuration (recommended)
```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/golangci/golangci-lint
    rev: v2.11.4
    hooks:
      - id: golangci-lint
  - repo: https://github.com/tekwizely/pre-commit-golang
    rev: v1.0.0-rc.1
    hooks:
      - id: go-vet
      - id: go-test-mod
        args: [-race]
```

### Makefile targets (recommended)
```makefile
.PHONY: lint test build fmt vet

fmt:
	gofumpt -l -w .

vet:
	go vet ./...

lint:
	golangci-lint run

test:
	go test -race -count=1 ./...

build:
	go build ./...

check: fmt vet lint test build
```

## Checklist for new Go files

When writing a new Go file, verify:

- [ ] Package name is lowercase, single word, no underscores
- [ ] Package-level doc comment present when purpose isn't obvious
- [ ] Exported symbols have 1-line doc comment starting with their name
- [ ] Imports are grouped: stdlib, third-party, local (goimports/gofumpt handles this)
- [ ] No unused imports
- [ ] All exported functions accept `context.Context` as first parameter where appropriate
- [ ] All error return values are checked
- [ ] Errors are wrapped with context: `fmt.Errorf("doing X: %w", err)`
- [ ] Error variables use `Err` prefix: `ErrNotFound`
- [ ] Error types use `Error` suffix: `NotFoundError`
- [ ] Functions use `MixedCaps`/`mixedCaps` naming (no `snake_case`)
- [ ] Acronyms are all-caps: `ID`, `HTTP`, `URL`, `API`
- [ ] Receiver names are 1-2 letter abbreviation, consistent across methods
- [ ] No mutable global state
- [ ] No hardcoded credentials or secrets
- [ ] No `math/rand` for security purposes (use `crypto/rand`)
- [ ] No weak hashing (MD5/SHA1) for security
- [ ] TLS 1.2+ enforced, certificates verified
- [ ] HTTP servers have timeouts configured
- [ ] SQL uses parameterized queries (no string concatenation)
- [ ] File permissions are restrictive (not 0777/0666)
- [ ] Goroutines have panic recovery and shutdown mechanism
- [ ] Slices preallocated when size is known
- [ ] `strings.Builder` used for string concatenation in loops
- [ ] `defer` used immediately after resource acquisition
- [ ] Struct initialization uses named fields
- [ ] Switch statements have `default:` case
- [ ] Functions are not too long (<60 lines)
- [ ] Cognitive complexity is low (<15)
- [ ] No commented-out code
- [ ] No unused variables
- [ ] `go vet ./...` passes
- [ ] `golangci-lint run` passes
- [ ] `go test -race ./...` passes

## Checklist for code review

When reviewing Go code, additionally check:

- [ ] No SQL injection (S5131, gosec G201/G202)
- [ ] No command injection (S5131, gosec G204)
- [ ] No hardcoded credentials (S2068, gosec G101)
- [ ] TLS verification not disabled (S5527, gosec G402)
- [ ] Strong hashing algorithms for security (S4790, gosec G401/G505)
- [ ] Cryptographically secure random for tokens (S2245, gosec G404)
- [ ] No weak encryption (S5542, gosec G405/G406)
- [ ] HTTP server timeouts set (gosec G114)
- [ ] No decompression bombs (gosec G110)
- [ ] File paths from user input validated (gosec G304)
- [ ] All error returns handled (errcheck)
- [ ] HTTP response bodies closed (bodyclose)
- [ ] Errors wrapped, not silently swallowed (nilerr, wrapcheck, errorlint)
- [ ] `errors.Is()`/`errors.As()` used for error comparison (errorlint)
- [ ] Context propagated correctly (noctx)
- [ ] No goroutine leaks (channels closed, context respected)
- [ ] Race conditions avoided (test with `-race`)
- [ ] Return values of pure functions not discarded (S2201)
- [ ] All code paths reachable (S1763)
- [ ] No duplicate string literals (goconst)
