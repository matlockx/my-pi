---
name: tdd-workflow
description: Use this skill when writing new features, fixing bugs, or refactoring code. Enforces test-driven development with 80%+ coverage including unit, integration, and E2E tests.
---

# Test-Driven Development Workflow

This skill ensures all code development follows TDD principles with comprehensive test coverage.

## When to Activate

- Writing new features or functionality
- Fixing bugs or issues
- Refactoring existing code
- Adding API endpoints or gRPC services
- Creating new packages or modules

## Core Principles

### 1. Tests BEFORE Code

ALWAYS write tests first, then implement code to make tests pass.

### 2. Coverage Requirements

- Minimum 80% coverage (unit + integration + E2E)
- All edge cases covered
- Error scenarios tested
- Boundary conditions verified

### 3. Test Types

#### Unit Tests

- Individual functions and methods
- Pure functions and utilities
- Interface implementations
- Helpers and transformers

#### Integration Tests

- HTTP/gRPC endpoints
- Database operations
- Service interactions
- External API calls (with mocks or testcontainers)

#### E2E Tests

- Critical user flows end-to-end
- Complete API workflows
- Multi-service interactions

## TDD Workflow Steps

### Step 1: Write User Journeys

```
As a [role], I want to [action], so that [benefit]

Example:
As a user, I want to search for orders by status,
so that I can find all pending orders for processing.
```

### Step 2: Generate Test Cases

For each user journey, create comprehensive test cases:

```go
func TestOrderService_FindByStatus(t *testing.T) {
    tests := []struct {
        name     string
        status   OrderStatus
        want     []Order
        wantErr  bool
    }{
        {
            name:   "returns pending orders",
            status: StatusPending,
            want:   []Order{{ID: "1", Status: StatusPending}},
        },
        {
            name:   "returns empty slice for no matches",
            status: StatusCancelled,
            want:   []Order{},
        },
        {
            name:    "returns error for invalid status",
            status:  OrderStatus("invalid"),
            wantErr: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            svc := NewOrderService(mockRepo)
            got, err := svc.FindByStatus(context.Background(), tt.status)
            if tt.wantErr {
                require.Error(t, err)
                return
            }
            require.NoError(t, err)
            assert.Equal(t, tt.want, got)
        })
    }
}
```

### Step 3: Run Tests (They Should Fail)

```bash
go test ./... -v -count=1
# Tests should fail - we haven't implemented yet
```

### Step 4: Implement Code

Write minimal code to make tests pass:

```go
func (s *OrderService) FindByStatus(ctx context.Context, status OrderStatus) ([]Order, error) {
    if !status.IsValid() {
        return nil, fmt.Errorf("invalid order status: %s", status)
    }
    return s.repo.FindByStatus(ctx, status)
}
```

### Step 5: Run Tests Again

```bash
go test ./... -v -count=1 -race
# Tests should now pass
```

### Step 6: Refactor

Improve code quality while keeping tests green:

- Remove duplication
- Improve naming
- Optimize performance
- Enhance readability

### Step 7: Verify Coverage

```bash
go test ./... -coverprofile=coverage.out -covermode=atomic
go tool cover -func=coverage.out
# Verify 80%+ coverage achieved

# HTML report for visual inspection
go tool cover -html=coverage.out -o coverage.html
```

## Testing Patterns

### Table-Driven Tests (the Go standard)

```go
func TestParseConfig(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    *Config
        wantErr string
    }{
        {
            name:  "valid config",
            input: `{"port": 8080}`,
            want:  &Config{Port: 8080},
        },
        {
            name:    "invalid JSON",
            input:   `{broken`,
            wantErr: "invalid character",
        },
        {
            name:    "missing required field",
            input:   `{}`,
            wantErr: "port is required",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := ParseConfig([]byte(tt.input))
            if tt.wantErr != "" {
                require.ErrorContains(t, err, tt.wantErr)
                return
            }
            require.NoError(t, err)
            assert.Equal(t, tt.want, got)
        })
    }
}
```

### HTTP Handler Integration Tests

```go
func TestGetOrderHandler(t *testing.T) {
    svc := NewMockOrderService()
    handler := NewOrderHandler(svc)

    t.Run("returns order by ID", func(t *testing.T) {
        svc.On("GetByID", mock.Anything, "order-1").Return(&Order{ID: "order-1"}, nil)

        req := httptest.NewRequest(http.MethodGet, "/orders/order-1", nil)
        w := httptest.NewRecorder()

        handler.ServeHTTP(w, req)

        assert.Equal(t, http.StatusOK, w.Code)
        var got Order
        require.NoError(t, json.NewDecoder(w.Body).Decode(&got))
        assert.Equal(t, "order-1", got.ID)
    })

    t.Run("returns 404 for missing order", func(t *testing.T) {
        svc.On("GetByID", mock.Anything, "missing").Return(nil, ErrNotFound)

        req := httptest.NewRequest(http.MethodGet, "/orders/missing", nil)
        w := httptest.NewRecorder()

        handler.ServeHTTP(w, req)

        assert.Equal(t, http.StatusNotFound, w.Code)
    })
}
```

### Database Integration Tests (with testcontainers)

```go
func TestOrderRepo_Integration(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test")
    }

    ctx := context.Background()
    pgContainer, err := postgres.Run(ctx,
        "postgres:16-alpine",
        postgres.WithDatabase("testdb"),
    )
    require.NoError(t, err)
    t.Cleanup(func() { pgContainer.Terminate(ctx) })

    connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    require.NoError(t, err)

    db, err := sql.Open("pgx", connStr)
    require.NoError(t, err)

    repo := NewOrderRepo(db)

    t.Run("creates and retrieves order", func(t *testing.T) {
        order := &Order{ID: "test-1", Status: StatusPending}
        require.NoError(t, repo.Create(ctx, order))

        got, err := repo.GetByID(ctx, "test-1")
        require.NoError(t, err)
        assert.Equal(t, order.ID, got.ID)
    })
}
```

## Test File Organization

```
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── order/
│   │   ├── handler.go
│   │   ├── handler_test.go      # unit tests alongside code
│   │   ├── service.go
│   │   ├── service_test.go
│   │   ├── repo.go
│   │   ├── repo_test.go         # integration tests (use -short to skip)
│   │   └── testdata/            # test fixtures
│   │       └── golden_order.json
│   └── ...
├── test/
│   ├── e2e/                     # end-to-end tests
│   │   └── order_flow_test.go
│   └── testutil/                # shared test helpers
│       ├── db.go
│       └── fixtures.go
```

## Mocking Patterns

### Interface-based mocking (preferred)

```go
// Define interface in consumer package
type OrderRepository interface {
    GetByID(ctx context.Context, id string) (*Order, error)
    Create(ctx context.Context, order *Order) error
}

// Generate mock: go generate ./...
//go:generate mockery --name=OrderRepository --output=./mocks
```

### Test helpers

```go
// testutil/db.go
func SetupTestDB(t *testing.T) *sql.DB {
    t.Helper()
    // ... setup
    t.Cleanup(func() { db.Close() })
    return db
}

// testutil/fixtures.go
func MakeOrder(t *testing.T, overrides ...func(*Order)) *Order {
    t.Helper()
    o := &Order{
        ID:     uuid.NewString(),
        Status: StatusPending,
    }
    for _, fn := range overrides {
        fn(o)
    }
    return o
}
```

## Test Coverage Verification

### Run Coverage Report

```bash
go test ./... -coverprofile=coverage.out -covermode=atomic
go tool cover -func=coverage.out
```

### Coverage Thresholds (enforced in CI)

```bash
# Check that total coverage meets threshold
COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | sed 's/%//')
if (( $(echo "$COVERAGE < 80" | bc -l) )); then
    echo "Coverage $COVERAGE% is below 80% threshold"
    exit 1
fi
```

## Common Testing Mistakes to Avoid

### WRONG: Testing Implementation Details

```go
// Don't test internal state
assert.Equal(t, 5, svc.cache.Len())
```

### CORRECT: Test Observable Behavior

```go
// Test what callers observe
got, err := svc.GetByID(ctx, "1")
require.NoError(t, err)
assert.Equal(t, expected, got)
```

### WRONG: No Test Isolation

```go
// Tests depend on each other via shared state
var globalDB *sql.DB
func TestCreate(t *testing.T) { /* writes to globalDB */ }
func TestRead(t *testing.T) { /* reads from globalDB, depends on TestCreate */ }
```

### CORRECT: Independent Tests

```go
func TestCreate(t *testing.T) {
    db := testutil.SetupTestDB(t)
    repo := NewRepo(db)
    // each test owns its state
}
```

### WRONG: No -race flag

```bash
go test ./...  # misses data races
```

### CORRECT: Always use -race

```bash
go test ./... -race -count=1
```

## Best Practices

1. **Write Tests First** — always TDD
2. **Table-driven tests** — the Go standard for multiple cases
3. **Use `t.Helper()`** — in all test helper functions
4. **Use `t.Cleanup()`** — for deterministic teardown
5. **Use `t.Parallel()`** — where safe, for faster test runs
6. **Use `testdata/`** — for golden files and fixtures
7. **Use `-short`** — to skip slow integration tests in dev
8. **Always `-race`** — catch data races early
9. **Test error paths** — not just happy paths
10. **Use `require` for preconditions** — `assert` for checks

## Success Metrics

- 80%+ code coverage achieved
- All tests passing (green)
- No skipped or disabled tests without reason
- Tests run with `-race` in CI
- Integration tests use testcontainers or equivalent
- E2E tests cover critical user flows

---

**Remember**: Tests are not optional. They are the safety net that enables confident refactoring, rapid development, and production reliability.
