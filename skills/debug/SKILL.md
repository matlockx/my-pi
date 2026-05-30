---
name: debug
description: "Bootstrap a debugging session for issues encountered during manual testing or implementation. Investigates logs (kubectl pods), database state, and git history without editing files. Use when something is broken, unexpected behavior occurs, or you need to trace an issue."
---

# Debug Session

You are tasked with helping debug issues during manual testing or implementation. Your role is to **investigate only** — examine logs, database state, and git history without editing files.

## Arguments

The skill accepts an optional issue reference as `$ARGUMENTS`.

---

## Initial Response

### When invoked WITH context:

```
I'll help debug this issue: $ARGUMENTS

What specific problem are you encountering?
- What were you trying to test/implement?
- What went wrong?
- Any error messages or unexpected behavior?

I'll investigate the logs, database, and git state to figure out what's happening.
```

### When invoked WITHOUT context:

```
I'll help debug your current issue.

Please describe what's going wrong:
- What are you working on?
- What specific problem occurred?
- Any error messages or stack traces?
- When did it last work correctly?

I can investigate logs (kubectl), application state, and recent git changes to help identify the root cause.
```

Wait for user's description before proceeding.

---

## Available Investigation Tools

### 1. Application Logs (Go)

```bash
# Check structured logs (slog output)
# If running locally:
go run ./cmd/server 2>&1 | grep -i "error\|warn\|fatal"

# If running in K8s:
kubectl get pods -A
kubectl logs -n <namespace> <pod-name> --tail=200
kubectl logs -n <namespace> <pod-name> --tail=200 | rg -i "error|panic|fatal|warn"

# Previous crashed container
kubectl logs -n <namespace> <pod-name> --previous

# Describe pod for events/crash reason
kubectl describe pod -n <namespace> <pod-name>
```

### 2. Go-specific Debugging

```bash
# Check for panics in logs
kubectl logs -n <namespace> <pod-name> --tail=500 | rg "panic:|goroutine \d+"

# Build with race detector
go build -race ./cmd/server

# Run tests with verbose output on failing package
go test -v -run TestSpecificTest ./internal/package/...

# Check for deadlocks — run with -timeout
go test -timeout 30s -v ./internal/package/...

# Profile CPU/memory if performance issue
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
go tool pprof http://localhost:6060/debug/pprof/heap

# Use dlv (Delve) for interactive debugging
dlv debug ./cmd/server -- --config=config.yaml
dlv test ./internal/package/ -- -run TestSpecificTest
```

### 3. Database State

```bash
# Connect to database (adjust connection string for your project)
psql $DATABASE_URL

# Run a one-off query
psql $DATABASE_URL -c "<SQL>"

# List all tables
psql $DATABASE_URL -c "\dt"

# Describe a specific table
psql $DATABASE_URL -c "\d <table_name>"

# Check migration state (goose)
psql $DATABASE_URL -c "SELECT * FROM goose_db_version ORDER BY id DESC LIMIT 5;"

# Check migration state (golang-migrate)
psql $DATABASE_URL -c "SELECT * FROM schema_migrations;"
```

### 4. Kubernetes Cluster State

```bash
# List all running pods
kubectl get pods -A

# Find pods matching service name
kubectl get pods -A | rg -i "<service-name>"

# Check deployments and replicas
kubectl get deployments -A

# Recent cluster events
kubectl get events -A --sort-by='.lastTimestamp' | tail -30

# Crashlooping or failed pods
kubectl get pods -A | rg -v "Running|Completed"

# Check services and endpoints
kubectl get svc -A
kubectl get endpoints -n <namespace> <service-name>

# Check configmaps and secrets (names only)
kubectl get configmaps -n <namespace>
kubectl get secrets -n <namespace>
```

### 5. Git History & Recent Changes

```bash
# Recent commits on current branch
git log --oneline -20

# What changed in the last commit
git show --stat HEAD

# Changes since a specific commit
git diff <commit>..HEAD --stat

# Who changed a specific file recently
git log --oneline -10 -- <file>

# Show changes to a specific file
git diff HEAD~5 -- <file>

# Check current branch and status
git status && git branch
```

---

## Investigation Strategy

### Step 1: Gather context from user

Understand:
- What they were doing (feature area, endpoint, flow)
- What broke (error message, panic, wrong data, 500, silent failure)
- When it last worked (after a deploy? migration? code change?)

### Step 2: Map to components

Based on the description, identify:
- Which service/pod handles this flow?
- Which database tables are involved?
- Were there recent migrations or code changes?
- Is this a concurrency issue (goroutine leak, race, deadlock)?

### Step 3: Check logs first

```bash
# Find the relevant pod
kubectl get pods -A | rg -i "<service-name>"

# Check for errors, panics, and warnings
kubectl logs -n <namespace> <pod-name> --tail=200 | rg -i "error|panic|fatal|warn"

# Full recent logs if needed
kubectl logs -n <namespace> <pod-name> --tail=200
```

### Step 4: Check Go-specific issues

```bash
# Look for goroutine dumps (deadlock/panic)
kubectl logs -n <namespace> <pod-name> --tail=500 | rg -A 20 "goroutine \d+"

# Check if binary was built with race detector
# Look for race condition output
kubectl logs -n <namespace> <pod-name> --tail=500 | rg "DATA RACE"
```

### Step 5: Check database state

If the issue involves data:
```bash
psql $DATABASE_URL -c "SELECT * FROM <table> WHERE <condition> LIMIT 10;"
psql $DATABASE_URL -c "SELECT * FROM goose_db_version ORDER BY id DESC LIMIT 5;"
```

### Step 6: Correlate with recent changes

```bash
git log --oneline -10
git log --oneline -10 -- <suspected-file>
```

### Step 7: Synthesize findings

Present:
1. **Root cause hypothesis** — what you believe is wrong and why
2. **Evidence** — log lines, DB state, git commits that support it
3. **Recommended fix** — what to do (but don't do it — surface it for the developer)

---

## Output Format

After investigation, present findings as:

```
## Debug Findings

### What I investigated:
- Logs: [pod name, namespace, time range]
- Database: [tables/queries checked]
- Git: [commits/files reviewed]
- Go-specific: [race detector, pprof, dlv findings]

### What I found:
- [Specific finding with evidence — log line, query result, commit hash]
- [Corroborating detail]

### Root cause hypothesis:
[Concise explanation of what's wrong and why]

### Recommended next steps:
1. [Specific action to fix or verify]
2. [Follow-up check]
```

---

## Important Guidelines

1. **Investigate, don't fix** — surface findings, let the developer decide on the fix
2. **Show evidence** — always quote the specific log line, query result, or git commit
3. **Check all layers** — logs, DB, git history often point to the same root cause
4. **Be specific about pod names** — always show the exact pod/namespace used
5. **Check for Go-specific issues** — panics, goroutine leaks, race conditions, nil pointer dereferences
6. **Ask before assuming scope** — if the issue could span multiple services, ask which to focus on first
7. **Note crashlooping pods** — always check for non-Running pods as part of initial triage
