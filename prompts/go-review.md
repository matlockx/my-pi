---
description: Review and fix Go code for SonarCloud, golangci-lint compliance, security, and idiomatic best practices
argument-hint: "<file or package path>"
---

Load the "golang" skill first.

Then perform the following steps on the target Go file(s):

## Step 1: Identify target files

If arguments are provided, review those specific files or packages: $ARGUMENTS

If no arguments are provided, find all `.go` files in the current project (excluding `vendor/`, `_test.go` files for initial pass, `.git/`).

## Step 2: Run linting and analysis tools

Run the following tools if available and capture the output:
1. `go vet ./...` - standard static analysis
2. `golangci-lint run` - comprehensive linting (uses `.golangci.yml` if present)
3. `go build ./...` - verify compilation
4. `gosec ./...` - security-focused analysis
5. `go test -race -count=1 ./...` - run tests with race detector

If a tool is not installed, note this and proceed with manual review.

## Step 3: Review against SonarCloud, golangci-lint, and Effective Go rules

For each Go file, check every rule from the golang skill systematically:

**Project setup:**
- `go.mod` exists with pinned Go version
- `.golangci.yml` exists with recommended linters enabled
- Standard project layout followed (`cmd/`, `internal/`, etc.)
- No packages named `util`, `common`, `misc`, `helpers`, `base`

**Security (fix immediately):**
- No hardcoded credentials (S2068 / gosec G101)
- No weak SSL/TLS protocols (S4423 / gosec G402)
- SSL certificate verification not disabled (S5527 / gosec G402)
- No SQL injection via string concatenation (S5131 / gosec G201, G202)
- No command injection (S5131 / gosec G204)
- No weak hashing for security purposes (S4790 / gosec G401, G505)
- No clear-text protocols (S5332)
- Cryptographically secure random for security use (S2245 / gosec G404)
- No weak encryption algorithms (S5542 / gosec G405, G406)
- HTTP servers have timeouts configured (gosec G114)
- File permissions are restrictive, not 0777/0666 (gosec G301-G306)
- User-controlled file paths validated against traversal (gosec G304)
- Decompression is size-limited (gosec G110)
- No blocklisted crypto imports (gosec G501-G505)

**Reliability (fix immediately):**
- All error return values checked (errcheck)
- HTTP response bodies closed (bodyclose)
- Errors wrapped with context, not silently swallowed (nilerr, wrapcheck)
- `errors.Is()`/`errors.As()` used for error comparison (errorlint)
- Context propagated correctly, no `nil` context (noctx, SA1012)
- All code paths reachable (S1763 / SA4004)
- No dead stores / unused assignments (S1854 / SA4006, ineffassign)
- Return values of pure functions not discarded (S2201)
- No self-assignments (S1656)
- No identical operands on both sides of operator (S1764)
- Functions don't always return the same value (S3516)
- Switch on enums is exhaustive (exhaustive)
- go vet passes: printf formats, copylocks, struct tags, atomic ops

**Performance (fix):**
- Slices preallocated when size known (prealloc)
- `strings.Builder` used for loop concatenation
- `strconv` used instead of `fmt.Sprintf` for simple conversions
- No unnecessary heap escapes
- `sync.Pool` considered for frequently allocated objects

**Maintainability (fix):**
- `MixedCaps`/`mixedCaps` naming, no snake_case (S100 / revive var-naming)
- Acronyms all-caps: ID, HTTP, URL, API (revive var-naming)
- Receiver names 1-2 letter abbreviation, consistent (revive receiver-naming)
- `context.Context` is first parameter (revive context-as-argument)
- Error variables prefixed with `Err`, error types suffixed with `Error` (revive error-naming, errname)
- Exported functions have doc comments starting with name (revive exported)
- Functions not too many parameters, max 5 (S107)
- Functions not too long, max ~60 lines (S138 / funlen)
- Cognitive complexity under 15 (S3776 / gocognit, cyclop)
- No unused variables (S1481 / unused, ineffassign)
- No commented-out code (S125)
- No duplicate string literals, extract to constants (S1192 / goconst)
- Mergeable if statements combined (S1066 / gocritic)
- Switch has default case (S131)
- TODO/FIXME comments have ticket references (S1135)
- Struct initialization uses named fields
- No `fmt.Println`/`log.Printf` in production; use `log/slog`
- Goroutines have panic recovery and shutdown mechanism
- `defer` used immediately after resource acquisition

## Step 4: Report findings

Provide a summary table of all findings grouped by severity:
- BLOCKER: Must fix immediately - injection, hardcoded creds, insecure crypto
- CRITICAL: Must fix - TLS, weak hashing, unchecked errors, cognitive complexity, bare panics
- MAJOR: Should fix - naming, unused vars, dead code, function length, missing docs
- MINOR / INFO: Nice to fix - TODOs, string dedup, performance hints

Include the SonarCloud rule ID (e.g., S2068) and/or golangci-lint linter name and rule (e.g., gosec G101, errcheck, revive:var-naming) for each finding.

## Step 5: Apply fixes

Apply all fixes to the Go files. For each fix:
1. Reference the rule ID (SonarCloud and/or golangci-lint linter)
2. Show what changed
3. Ensure the fix does not break functionality

After applying fixes:
1. Run `gofumpt -l -w .` (or `gofmt -l -w .`) to ensure consistent formatting
2. Run `go vet ./...` to verify no vet issues remain
3. Run `golangci-lint run` to verify lint issues are resolved
4. Run `go build ./...` to verify compilation
5. Run `go test -race -count=1 ./...` to verify tests pass
