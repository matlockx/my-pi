---
work_state: done
---

# Plan: usage tracker per account, provider, model, session and feature

## Goal

An agent session can answer "why did I use so much in the last 5 hours, and which session or feature
used it?" for every connected subscription account (several Anthropic accounts, GitHub Copilot). Each
answer names provider, model and account, shows tokens and API-equivalent cost, and estimates the share
of the account's 5-hour, weekly or monthly limit. Usage from every device on the same subscription is
merged through a private GitHub repository without merge conflicts.

## Decisions (2026-11-13)

- **Sync location**: an hourly host loop `usagesync`, started by `my-pi-start` like ghmcp and jiramcp.
  omp runs inside nono, where SSH cannot read `~/.ssh/known_hosts` (agents/AGENTS.md), so a push from a
  session fails. Rejected: a launchd agent (second host mechanism next to my-pi-start) and GitHub MCP
  `push_files` (one API call per file to pull, every push through the guard, nothing collected between
  sessions).
- **Session identity in the repo**: rows carry the session title and project folder, both passed through
  `redactString` (`extensions/secret-redactor/redact.ts`, the path memory share uses). Rejected: project
  only, opaque ids only; both make cross-device answers unreadable.
- **Repo owner**: a private repository in the personal GitHub account, default name `agent-usage`,
  checkout `~/github/agent-usage`. Policy risk accepted by the user: redacted titles of work sessions
  (Jira keys, client repo names) are stored outside work-controlled storage.
- **Attribution weight**: Anthropic limit shares are split by API-equivalent cost (`usage.cost.total`),
  Copilot shares by `usage.premiumRequests`. Raw tokens would overweight cache reads, which cost a tenth of
  fresh input. Anthropic does not publish its limit formula, so every share is labelled as an estimate.

## Facts the design rests on (checked 2026-11-13, omp 18.18.3)

- `omp usage --json` returns per account `reports[].limits[]` with `id` (`anthropic:5h`, `anthropic:7d`,
  `anthropic:7d:fable`, `copilot:premium`), `amount.usedFraction`, `window.resetsAt` and
  `window.durationMs`, plus `metadata` (accountId, email, orgId, orgName). `omp usage --history --days N`
  returns the hourly snapshots omp stores in `~/.omp/agent/agent.db` table `usage_history`.
- Session logs `~/.omp/agent/sessions/<folder>/<ts>_<id>.jsonl` (format: `omp://session.md`):
  - assistant messages carry `provider`, `model`, `usage.{input,output,cacheRead,cacheWrite,cost.total,premiumRequests}`;
  - side requests are `model_usage` entries with `purpose` (`job-caption`, `job-widget`,
    `task-completion-probe`, `cache-warm`, `auto-thinking`) and their own `usage`;
  - `credential_pin` entries carry `provider` and `hash` = sha256 of
    `provider\0accountId\0email\0orgId\0projectId` of the OAuth identity (omp function `WPt`). No device
    part, so one account has one hash on every device. omp writes the first pin after the first reply.
    Copilot credentials carry no identity, so Copilot traffic is never pinned;
  - runs started by extensions begin with a `custom_message` whose `customType` names the feature
    (`jflow-watch`, `async-result`, …) or with a user message whose text is an extension prompt
    (`Address the quick-review findings above.`, `jflow watcher, round …`);
  - subagent logs live in `<folder>/<ts>_<id>/<Name>.jsonl` and carry their own pins;
  - the first line is a `title` header;
  - seance subagents copy historical entries with their original id and timestamp, older than the
    file's `session` header: the only duplicates found (172 requests).
- The pin hash computed from `omp usage --json` metadata (`accountId`, `email`, `orgId`) matches the
  logged hash (verified 2026-11-13), so the collector labels accounts from that report.
- `~/.omp/stats.db` (`omp stats`) has per-request rows but no account column; not used. It also counts
  a few more requests per file than the logs hold (stale re-sync); the parser matches the logs.
- No `~/.pi/agent/sessions` and no `~/.claude/projects` on this Mac: omp is the only source for now.

## Approach

Session logs already hold every request with provider, model, usage and account pin, so no live hook is
needed and history back-fills for free. One parser turns logs into hourly rows. Each device writes only
its own directory in the repo, and rewrites are merge-by-key, so `git pull --rebase` never conflicts on
data and re-runs never double rows. The agent tool reads other devices from the checkout and this
device live from its own logs, so the current hour is always included.

Repository layout:

```text
agent-usage/
  accounts.json                         # manual overrides: { "<pin hash>": "<label>" }, wins over devices
  devices/<host>-<install-id[0:8]>/
    hourly/<YYYY-MM-DD>.jsonl           # one row per hour x session x agent x feature x provider x model x account
    limits/<YYYY-MM-DD>.jsonl           # limit snapshots: recordedAt, provider, account, limitId, usedFraction, resetsAt, durationMs
    accounts.json                       # labels this device resolved: { "<pin hash>": "<label>" }
```

Hourly row: `hour` (UTC ms), `sessionId`, `project`, `title`, `agent` (`main` or subagent name), `feature`
(initiator `customType`, `user`, or `side:<purpose>`), `provider`, `model`, `account` (pin hash or
`unpinned:<provider>`), `requests`, `input`, `output`, `cacheRead`, `cacheWrite`, `cost`, `premium`.

Feature rule: the first `user` message or `custom_message` after the agent went idle (last assistant
`stopReason` is not `toolUse`) starts a run and names its feature; messages injected before the next
assistant reply (`memory-recall`, `image-attachment`) do not override it. `model_usage` rows are
`side:<purpose>`.

## Phases

- [x] **Phase 1 — Parser and account labels**
  - Files: `extensions/usage/parse.mjs`, `extensions/usage/parse.test.mjs`
  - Change: `parseEntries` / `parseFile` turn one log into request events; `hourlyRows` groups them by
    the schema above; `scanSessions(dir, sinceMs)` does both for every log modified since a time. It
    tracks the current pin per provider (requests before the first pin take it), applies the feature
    rule, skips entries older than the file's `session` header (seance and fork copies), and ignores
    unknown entry types. Spike result: `accountHash(provider, identity)` reproduces omp's pin hash, and
    `omp usage --json` metadata yields the same hash, so labels need no auth-storage access.
  - Verify: `node --test extensions/usage/parse.test.mjs` (7 pass). A scan of all 76 local logs takes
    0.45 s; per-file request counts equal the assistant messages in each file.
  - Risk: medium. The session format is omp-internal; the parser tolerates missing fields and is tested
    against real files.

- [x] **Phase 2 — Store**
  - Files: `extensions/usage/store.mjs`, `extensions/usage/store.test.mjs`
  - Change: `writeRows` / `writeLimits` merge per UTC day file by key (`mergeByKey`: new rows replace,
    rows whose source log is gone stay) and write sorted JSONL atomically; `writeRows` redacts title and
    project. `writeAccounts` merges labels. `readRepo(repo, { since, until, excludeDevice })` unions every
    device. Labels: root `accounts.json` wins, then device files in name order, then the short hash.
  - Verify: `node --test extensions/usage/store.test.mjs` (5 pass).

- [x] **Phase 3 — Host collector and sync**
  - Files: `extensions/usage/collect.mjs`, `extensions/usage/collect.test.mjs`,
    `fish/functions/usagesync.fish`, `bin/my-pi-start`, `setup.fish`
  - Change: `collect.mjs` reads `~/.pi/usage/config.json`, parses every log on the first run and logs
    modified in the last 2 days afterwards, labels accounts and stores snapshots from `omp usage --json`
    and `omp usage --history --json --days 30|3` (history joined to accounts by provider, accountId,
    e-mail), gives unpinned rows the provider's account when the device has exactly one, writes the
    device directory, then commits, `git pull --rebase`, pushes (`-u` on the first push). A failed
    rebase is aborted and reported, never forced. `--loop` repeats hourly; `usagesync
    start|stop|status|now|log` runs it in the background with a pid file; `my-pi-start` starts and
    restarts it; `setup.fish` prints the setup hint when the config is missing.
  - Verify: `node --test extensions/usage/collect.test.mjs` (3 pass: two clones of a bare remote push
    in turn, the re-run changes no file). Dry run on real data: 426 rows, 611 snapshots, both accounts
    labelled. Not run here: the host loop and a push to the real repository (needs the repo and config).

- [x] **Phase 4 — Agent tool**
  - Files: `extensions/usage/report.mjs`, `extensions/usage/report.test.mjs`,
    `extensions/usage/index.ts`, `package.json` (`pi.extensions`)
  - Change: tool `usage_report({ window, groupBy, provider?, account?, top? })`.
    - `window`: `5h` or `7d` (each account's current limit window, start = `resetsAt - durationMs`),
      `last:<N>h|d`, or `<ISO>..<ISO>`.
    - `groupBy`: any of `account`, `provider`, `model`, `session`, `project`, `agent`, `feature`,
      `device`, `hour`.
    - Output per account: each limit's used %, reset time and increase over the window; the increase
      in the limit's own current window is its current value, elsewhere the snapshot difference summed
      across resets. A limit is flagged when its % per tracked cost is 2x or more the median of closed
      windows in the last 30 days. Then a table per group: requests, tokens, API-equivalent $, premium
      requests, share of weight, and the estimated part of each limit.
    - Data: other devices from the checkout, this device live from its logs (merged over its stored
      rows), snapshots from `omp usage` and the checkout.
  - Verify: `node --test extensions/usage/report.test.mjs` (6 pass); the tool run under Bun with real
    data answers in about 2 s. Not run: a call from a live omp session (needs a restart to load).

- [x] **Phase 5 — Docs**
  - Files: `extensions/usage/index.ts` header (config, repo layout, sync, privacy), this spec's state.

- [x] **Phase 6 — HTML reports (daily, weekly, monthly)**
  - Files: `extensions/usage/digest.mjs` (periods, readiness, figures), `extensions/usage/page.mjs`
    (HTML), `extensions/usage/collect.mjs` (`writeReports`, `pushReports`), tests `digest.test.mjs`,
    `page.test.mjs`, `collect.test.mjs`; `report.mjs` exports `durationOf`, `limitDelta` and
    `untrackedRatio` for reuse.
  - Periods: local day, ISO week (Monday start) and month in `timezone` of the config (default
    `Europe/Berlin`). Each run checks the last 7 days, 4 weeks and 2 months for a missing file.
  - Ready: once every device with rows in the period shows a row or snapshot after its end, or
    24 hours after the end at the latest (an asleep device cannot block a report forever).
  - First device wins: reports are written only when `reports/<kind>/<key>.html` is missing in the
    checkout just pulled; they are committed apart from device data and pushed; a rejected push drops
    the report commit (`reset --keep HEAD~1`) and the next run pulls the winner. A report is never
    rewritten, so late rows of a device that synced after the 24-hour limit stay out of it.
  - Page: one self-contained HTML file (inline CSS and SVG, no scripts, light and dark themes):
    KPIs against the previous period; per-account limit chart with peak, time at 90%+ or 100%, pace
    of 7-day-or-longer windows, and the untracked-use flag; cost over time by top project; projects
    by account; features with the automatic share; weekday × hour heatmap (weekly, monthly);
    calendar and ISO-week bars (monthly); top sessions; token kinds with estimated cost shares;
    models, agents and devices (single-value mixes collapse to one line); device sync state.
    `reports/index.html` lists every report.
  - Verify: `node --test extensions/usage/` (33 pass); reports generated from a copy of the real
    repository and their charts inspected as rendered SVG. Not run: a full page in a browser (the
    sandbox blocks Chrome), the hourly loop end to end.

## Alternatives not taken

- Read `~/.omp/stats.db`: internal schema, no account column, filled only by `omp stats`.
- SQLite file in the repo: binary, every concurrent push conflicts.
- One shared JSONL appended by all devices: concurrent appends conflict on rebase.
- Live hook per request (`turn_end`): misses side requests and subagents unless each is hooked; logs
  already hold everything and back-fill history.
- Parsers for pi and Claude Code logs: no such logs on this Mac; add when a device produces them.
- Token attribution per tool result (omp `tool_rollup` style): not needed for the asked questions.
- Calibrating a %-per-$ factor to subtract untracked usage: the side-by-side flag answers the question
  without a model of Anthropic's formula.

## Risks

- omp changes its session format: parser skips unknown entries; tests on real files catch drift.
- Pin hash recipe changes in omp: hashes are opaque keys only; a new hash shows as a new unlabelled
  account until labelled.
- Shares are estimates: cost-weighted split of an undisclosed limit formula; the output says so.
- Hourly buckets: up to one hour of usage at a window edge can fall on the wrong side; stated in output.
- Work session titles in a personal repository (accepted 2026-11-13).
- Two Macs with the same hostname: device directory includes the omp install id.

## Done when

- `usage_report` in an omp session answers the 5-hour question with provider, model, account, session
  and feature, including usage from a second device.
- Two devices push hourly to `agent-usage` for a day without a merge conflict or duplicated row.
- Tests of phases 1 to 4 pass; quality gates (CRAP <= 10, dryer 0.8) run once before push.
