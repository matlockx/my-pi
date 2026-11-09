---
description: Metric instruments (Prometheus, OpenTelemetry, Micrometer, prom-client) - zero-initialised labelled counters and consumers of changed metrics
condition:
  - "prometheus\\.New(Counter|Gauge|Histogram|Summary)(Vec)?\\("
  - "promauto\\.(With\\(|New)"
  - "\\.WithLabelValues\\("
  - "\\.(Int64|Float64)(Counter|UpDownCounter|Histogram|Gauge|ObservableCounter|ObservableGauge|ObservableUpDownCounter)\\("
  - "otel\\.Meter\\(|GetMeterProvider\\(\\)\\.Meter\\("
  - "from prometheus_client import|prometheus_client\\.(Counter|Gauge|Histogram|Summary)\\("
  - "(Counter|Timer|Gauge|DistributionSummary)\\.builder\\("
  - "new (client|promClient|prom)\\.(Counter|Gauge|Histogram|Summary)\\("
scope: "tool:edit(*.go), tool:write(*.go), tool:edit(*.py), tool:write(*.py), tool:edit(*.java), tool:write(*.java), tool:edit(*.kt), tool:write(*.kt), tool:edit(*.ts), tool:write(*.ts)"
interruptMode: tool-only
---

# Metrics

Applies to every change that adds, changes, increments or removes a metric instrument (AGENTS.md
G-16). This file is injected by omp when an edit or write introduces metric code.

## Labelled counters start at zero

A Prometheus counter vector creates a series on its first increment, already at 1. `increase()`
and `rate()` never see that first event, and a counter that never moved is not a field in the
metrics store, so an ES|QL panel over it fails with `Unknown column`. Apply the following directly,
without asking, whenever code adds, changes, or increments a labelled counter in a service:

- Create every label combination the service can emit at 0 on start (`vec.WithLabelValues(...)`
  without `Inc()`), before the first message, request, or job pass. Closed label sets come from
  the constants the increment sites use; open ones (topics, job names, enabled checks) come from
  the configured set, at the call site that knows it.
- A list that mirrors constants carries a `DEV-NOTE:` naming the constants it must stay in step
  with. Label values used in more than one place become named constants.
- The test calls the same initialisation functions start-up calls (extract them if inlined) and
  asserts, per metric, the series count (`testutil.GatherAndCount(prometheus.DefaultGatherer,
  name)`) and that every gathered series is 0, so a missing or pre-incremented combination fails.
- Dashboards over such counters drop zero buckets (`| WHERE x > 0` after `STATS`), so the legend
  lists what happened rather than every combination.

References: payment-service `internal/service/payment/service.go` (`init`), order-service
`internal/event/order.go` (`init`), financial-aggregation-service `InitMetrics` in
`internal/consumer`, `internal/handler`, `internal/service`, called from `consumers.go` and
`jobs.go`.

## Metric changes reach their dashboards and alerts

Alerts and dashboards read metrics by name and label, often from another repository. A renamed
metric or dropped label leaves the panel empty and the alert silent; nothing fails in the service's
own tests. Apply the following directly, without asking, whenever code changes an existing metric
instrument (counter, gauge, up-down counter, histogram, summary, timer, meter):

- **What counts as a change**: rename, removal, type change, unit change, histogram bucket change,
  a label added, removed, or renamed, a label value renamed, and an increment site added, moved, or
  removed (the series keeps its name but counts something else). A new metric is not a change.
- **Search before the edit, at least memory**: `memory_recall` with the metric name, its labels,
  and the service name, across all projects. Memory is the only record of dashboards and alerts
  built by hand in a UI, which no grep finds.
- **Then grep every consumer location** for the metric name (also without the `_total`,
  `_bucket`, `_count`, `_sum`, `_seconds` suffixes) and for each changed label name:
  - `intl-stardust-gitops`: `infrastructure/modules/elastic-alerting` (ES|QL rules, SLOs, ML jobs),
    `infrastructure/modules/elastic-dashboards`, `docs/runbooks`. Elastic stores metrics as
    `metrics.<name>` and labels as `attributes.<label>`.
  - The service repository itself: Grafana JSON, `PrometheusRule`, Datadog monitors, recording
    rules, README.
  - A project with an unknown backend (Grafana, Datadog, other): ask where its alerts and
    dashboards live, then save the answer with `memory_save`.
- **Hit**: update the consumer in the same task (multi-repo rules G-8 and G-10 apply), or keep
  emitting the old name or label until the consumer is migrated. Never leave a consumer pointing at
  a series the code no longer emits. While older data still holds the field, the query runs and
  returns nothing, so the alert stays silent; once retention drops it, ES|QL fails with `Unknown
  column`.
- **Report**: the work summary lists each changed metric with its consumers as `file:line`, or the
  locations searched when there are none. A failed `git fetch` of a consumer repository is stated,
  since the hit list may then be stale.
