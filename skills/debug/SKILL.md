---
name: debug
description: "Investigate a bug or failure without editing files: logs, metrics and traces (Grafana MCP: Loki, Prometheus, Tempo), Docker Compose, Kubernetes, local tests, database state and git history. Use when something is broken, behaves unexpectedly, or an error needs tracing."
---

# Debug session

Investigate only: read logs, metrics, traces, state and history, and report the cause with
evidence. Do not edit files, restart services or change data; propose the fix and let the user
decide.

## 1. Get the facts

If the user has not said so, ask in one message:

- What was being done (endpoint, job, screen, command), and what happened instead?
- The exact error text, status code or stack trace.
- When it last worked, and what changed since (deploy, migration, config, dependency update).

## 2. Find where it runs

The place decides the tools. Settle it before collecting evidence.

| Where | Signals | Logs and state |
| --- | --- | --- |
| Local process or test | reproduces on this machine | run it, read stderr, run the failing test |
| Homelab (Raspberry Pi, NAS) | homelab stacks, paperless, backups, home services | `grafana` MCP: Loki, Prometheus |
| Hetzner server (mhj, lifepace) | Lisa's services, manychat-gr, finance, content, lifepace engine | `grafana-hetzner` MCP: Loki, Prometheus, Tempo |
| Kubernetes (work clusters) | namespaces, pods, Helm charts | `kubectl`, the cluster's own observability stack |

Both Grafana MCP servers describe their dashboards and labels in their server instructions; read
a dashboard's summary and panel queries before guessing metric names.

## 3. Collect evidence

### Logs (Loki through the Grafana MCP)

Containers are `{job="docker"}` with labels `compose_project`, `compose_service`, `container`;
the host journal is `{job="journal"}` with `unit` and `level`. Start narrow, then widen:

```logql
{job="docker", compose_service="<service>"} |~ "(?i)error|panic|fatal|exception"
{job="journal", unit="<unit>.service"}
```

Use `query_loki_patterns` to see which messages dominate, and `query_loki_stats` before pulling a
long range. Loki keeps 7 days.

### Metrics and probes (Prometheus through the Grafana MCP)

Error rates, restarts and reachability around the failure time: `up`, `probe_success`,
container restarts from cAdvisor, and the service's own counters (their names are in the
dashboard panel queries). Prometheus keeps 15 days.

### Traces (Tempo, Hetzner only)

`search_tempo_traces` with `resource.service.name = "<service>"` and `status = error`, then
`get_tempo_trace` for one failing request.

### Docker on this machine

`docker compose ps`, `docker compose logs --since 30m <service> | rg -i 'error|panic|fatal'`.
Remote hosts are inspected through Loki; ask before using `ssh`.

### Kubernetes

```bash
kubectl get pods -n <ns> | rg -v 'Running|Completed'
kubectl describe pod -n <ns> <pod>
kubectl logs -n <ns> <pod> --since=30m | rg -i 'error|panic|fatal'
kubectl logs -n <ns> <pod> --previous      # crashed container
kubectl get events -n <ns> --sort-by=.lastTimestamp
```

### Local code and tests

```bash
go test -run TestName -v -race -count=1 ./internal/pkg/...
go test -timeout 30s ./internal/pkg/...    # hangs and deadlocks
```

For stepping through Go code, omp's `debug` tool drives Delve (`dlv`, install it first if it is
missing). For profiles: `go tool pprof http://localhost:6060/debug/pprof/heap`.

### Database state

Read-only queries only (`SELECT`, `\d <table>`), against the environment the user names; never
production without explicit permission. Check the migration table (`goose_db_version`,
`schema_migrations`) when the failure follows a deploy. If no client is installed, say so and
give the user the query.

### Git history

```bash
git log --oneline --since='3 days ago'
git log --oneline -10 -- <suspect-file>
git log -S '<identifier>' --oneline        # when a symbol appeared or vanished
git diff <last-good>..HEAD --stat
```

## 4. Report

```markdown
## Debug findings

### Investigated
- Logs: <datasource, query, time range>
- Metrics/traces: <queries, trace ids>
- State: <commands or queries run>
- Git: <commits and files read>

### Found
- <finding> — evidence: <quoted log line, metric value, trace span, commit hash>

### Root cause
<one or two sentences; say "hypothesis" and what would confirm it if not proven>

### Next steps
1. <fix to make, with file or config>
2. <check that proves the fix>
```

Rules: quote the exact log line, query result or commit for every claim; name the datasource,
namespace or container used; if the issue may span several services, ask which to start with;
an unproven cause is labelled a hypothesis, with the check that would settle it.
