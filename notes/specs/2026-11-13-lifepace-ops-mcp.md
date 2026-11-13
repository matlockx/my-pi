---
work_state: in_progress
---

# Plan: lifepace production access only through the MCP guard

## Goal

No omp session can reach the lifepace server (Hetzner, `deploy@178.104.206.74`) on its own: not with `ssh`,
`scp`, `rsync`, a port forward, a `make` target or a script. The agent reads production through one host-side
MCP server, `lifepace`, behind the MCP guard (`notes/specs/2026-11-12-mcp-guard.md`). Every database query is
asked in the native dialog with Deny, Allow and "Allow for this session"; nothing is approved beyond the omp
session that asked.

## Decisions (owner, 2026-11-13)

- **The wall is the sandbox, not a text guard.** A guard over `bash`/`eval` text cannot see an `ssh` inside
  `make plan-diag` or a Python string (it did not on 2026-11-13). nono denies the ssh-agent socket, so no
  process in a session can sign an ssh login, however it is started. Option "fileguard rule for ssh/psql"
  was rejected for that reason; option "nono wall only, no MCP" because every production read would go
  back to the owner's terminal.
- **Database reads ask, with a session button.** `prod_sql` raises the dialog on every call until the owner
  clicks "Allow for this session"; then that omp session's further `prod_sql` calls pass (logged). The
  approval lives in the guard's memory only: it ends with the omp session (its MCP session id), after
  8 hours without a call, or when the guard restarts. Never on disk.
- **Database writes ask every time.** `prod_sql_write` raises the dialog on every call, without the session
  button, like destructive GitHub tools.
- **Copying a plan version needs no dialog.** `plan_diag` runs `deploy/plan-diag.sh` (fixed, reviewed,
  read-only SQL) and is logged.

## Facts

- Sessions run in `nono run --profile pi` (`~/.config/nono/profiles/pi.json`). `~/.ssh` is denied, but
  `SSH_AUTH_SOCK` (`/private/var/run/com.apple.launchd.*/Listeners`) is reachable, so the agent can sign
  logins with the owner's key (observed 2026-11-13: `ssh-add -l` lists it; `make plan-diag` ran from a
  session).
- `deploy` on the server runs `docker compose`: full access to Postgres and every container.
- In the Postgres container, local socket logins need no password; TCP logins need one (official image
  defaults; lifepace's scripts log in as `$POSTGRES_USER`, the database owner and a superuser).
- `psql -c <text>` sends text to the server as it is unless it starts with a backslash; multiple statements
  in it run in one transaction. A psql meta-command (`\!`) would run a shell in the container, from where
  the owner role is one `psql` away.
- A `BEGIN READ ONLY` transaction as the owner is not a fence: the text can `COMMIT` and go on, and a
  superuser can write files with `COPY ... TO` or end other sessions. Only a role without privileges is.
- omp's HTTP MCP client stores the `Mcp-Session-Id` answered to `initialize` and sends it with every later
  request (strings of omp 18.18.6). The stdio bridge issues no session id today.

## Approach

### Server side (lifepace repository)

- Role `diag` (`deploy/server/postgres-diag.sql`, run by every apply like `postgres-monitoring.sql`):
  `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2`, no password (so it can log
  in only over the container's local socket), `pg_read_all_data`, `default_transaction_read_only = on`,
  `statement_timeout = 30s`. It reads every table and writes nothing; it cannot end other backends or write
  server files.
- `deploy/prod-sql.sh [--write]` reads one SQL text on stdin (at most 20 000 characters, no backslash, no
  NUL), runs it with `psql -X -q --csv -v ON_ERROR_STOP=1 -c "$q"` in the container as `diag`, or as
  `$POSTGRES_USER` with `--write`. Prints CSV. Uses the ssh settings of `deploy/server.sh`.

### Host side (this repository)

- `mcp/lifepace/server.mjs`, a stdio MCP server, tools:
  - `plan_diag {subject, case, version?, note?}`: `deploy/plan-diag.sh` with `CASE`/`NOTE`; returns its
    output (run folder, weeks). `readOnlyHint`.
  - `prod_sql {query}`: `deploy/prod-sql.sh` as `diag`. `readOnlyHint`.
  - `prod_sql_write {query}`: `deploy/prod-sql.sh --write`. `destructiveHint`.
  - Output capped at 100 000 characters (the cut is said). The lifepace checkout is `LIFEPACE_REPO`,
    default `~/projects/lifepace`.
- `mcp/lifepace/policy.mjs`: the base checks (secrets, personal data) plus `prod_sql` confirm with
  `session: true`, `prod_sql_write` confirm, `plan_diag` allow, any other tool deny.
- `mcp/lifepace/guard.mjs`: stdio guard on 127.0.0.1:8088 with session approval on.
- Guard core: option `sessions`. With it, the guard answers `initialize` with a random `Mcp-Session-Id`,
  remembers per session the tools approved for it, and drops a session on `DELETE` or after 8 hours idle.
  A request whose findings are all `session: true` and carries a known session id gets the third dialog
  button "Allow for this session" (osascript allows three buttons; the allowlist offer never applies to
  this server). Missing or unknown id: no session button.
- A generic stdio tool server (`mcp/guard/toolserver.mjs`) replaces the JSON-RPC loop the vcluster server
  has, so both servers share it.

### Sandbox (owner, `~/.config/nono/profiles/pi.json`, read-only for the agent)

Deny the ssh-agent socket (seatbelt rule below), then restart omp. The regex covers both spellings of the
socket path: a session's `SSH_AUTH_SOCK` reads `/var/run/...`, its resolved path `/private/var/run/...`.

```json
"(deny network-outbound (remote unix-socket (path-regex #\"^(/private)?/var/run/com\\.apple\\.launchd\\.[^/]+/Listeners$\")))"
```

The rule cannot be tried from a session: nono refuses a nested sandbox (`sandbox-exec: sandbox_apply:
Operation not permitted`, 2026-11-13). Try it in a host terminal first; the first command must print the
key, the second must fail:

```fish
printf '%s\n' '(version 1)' '(allow default)' '(deny network-outbound (remote unix-socket (path-regex #"^(/private)?/var/run/com\.apple\.launchd\.[^/]+/Listeners$")))' > /tmp/agent-deny.sb
ssh-add -l; sandbox-exec -f /tmp/agent-deny.sb ssh-add -l; rm /tmp/agent-deny.sb
```

After the omp restart: in a new session `ssh-add -l` fails and `make plan-diag SUBJECT=1` fails at ssh.

Consequence: `git fetch`/`git push` over ssh stop working in sessions. Pushes go through the owner or jflow.

## Phases

- [x] **Phase 1: role and script (lifepace)**
  - Files: `deploy/server/postgres-diag.sql`, `deploy/main.tf`, `deploy/locals.tf`, `deploy/prod-sql.sh`,
    `docs/12_DEPLOYMENT.md`, `AGENTS.md`, `docs/00_README_AGENT.md`.
  - Verify: `shellcheck`; `tofu validate`; after `make deploy` (owner) `prod_sql` with an `UPDATE` fails
    with "cannot execute UPDATE in a read-only transaction" or "permission denied".
- [x] **Phase 2: session approval in the guard**
  - Files: `mcp/guard/guard.mjs`, `mcp/guard/guard.test.mjs`.
  - Verify: tests: session id issued on initialize only with `sessions`; session button offered only when
    every finding is `session: true` and the id is known; an approved session passes without a dialog, a
    second session still asks; DELETE and idle expiry drop it; no session button for a write.
- [x] **Phase 3: lifepace MCP server**
  - Files: `mcp/guard/toolserver.mjs`, `mcp/vcluster/server.mjs`, `mcp/lifepace/{server,policy,guard}.mjs`
    and tests, `mcp.json`, `bin/my-pi-start`.
  - Verify: unit tests with a fake runner (argument checks, script and environment, output cap); policy
    table test; `npm test`.
- [ ] **Phase 4: wall (owner)**: nono rule, omp restart, `my-pi-start restart`, a `prod_sql` from a session.

## Status (2026-11-13)

Phases 1-3 built, not committed. lifepace (GitHub #514): `deploy/server/postgres-diag.sql`, apply wiring in
`deploy/main.tf` and `deploy/locals.tf`, `deploy/prod-sql.sh` (tested with fake ssh/docker/psql: the query
reaches psql as one `-c` argument, `$(...)`, backticks and quotes untouched; backslash, NUL, empty and
over-long texts refused), docs/12 §7.2-§7.3, AGENTS.md, docs/00. my-pi: session approvals in
`mcp/guard/guard.mjs` (tests: no id without `sessions`, approval passes only its own session, no session
button for a write or a finding outside `session`, DELETE and idle end it; a mutation that shares approvals
across sessions fails two of them), `mcp/guard/toolserver.mjs` (the vcluster server uses it too),
`mcp/lifepace/{server,policy,guard}.mjs` with tests, `mcp.json`, `bin/my-pi-start`, setup check. An
end-to-end run (real guard, bridge and server; fake scripts and dialog) showed: `plan_diag` logged without a
dialog; `prod_sql` asked once, then passed in that session (`decision: session`); another session asked
again; `prod_sql_write` asked without the session button.

Verified in the sandbox against a throwaway PostgreSQL 18.4 (the server's version) with the image's
authentication (local trust, TCP scram), `postgres-diag.sql` applied twice: `diag` reads `lk.subjects`;
`UPDATE` fails "cannot execute UPDATE in a read-only transaction"; with the read-only default switched off,
`UPDATE` fails "permission denied for table subjects" and `CREATE TABLE` "permission denied for schema lk";
`COPY ... TO` a file and `pg_terminate_backend` are refused; `statement_timeout` is 30s; a TCP login as
`diag` fails. `deploy/prod-sql.sh` against the same database (only ssh and docker faked, real psql): a
query with `'` and `$(id)` returns CSV unchanged, a `SET default_transaction_read_only = off; UPDATE ...`
text fails, `--write` updates as the owner.

Open on the host: `make deploy` in lifepace (creates `diag`), the rule check above, the nono rule and an
omp restart, `my-pi-start restart`, `/mcp reconnect lifepace`, then an `UPDATE` through `prod_sql` must
fail on the server too. The MCP setup wizard has no step for this server: `my-pi-start` starts it only where
the lifepace checkout exists, and `disabledServers` turns it off.

## Alternatives not taken

- Text guard rules for `ssh`/`psql` in `fileguard.ts`: bypassed by any wrapper.
- Node Postgres client over an ssh tunnel with `BEGIN READ ONLY`: a new dependency, and still the owner
  role, so not a fence.
- nono command policies with a prompt: the interactive mode (capability elevation) is Linux-only.

## Risks

- Health data in `prod_sql` answers reaches the model context, as with any read; the dialog is the gate.
- The seatbelt rule is checked only by the host one-liner in "Sandbox"; until it is in `pi.json` and omp is
  restarted, the old hole stays.
- omp may reconnect and get a new session id; the owner is asked again (fail closed).
- Any sandboxed process can open its own MCP session on 8088 with `curl` and raise the dialog; the dialog
  does not say which omp session asks. Approving still needs the owner's click, and the approval holds only
  for the session that asked. `plan_diag` needs no click from any caller (read-only, logged).

## Done when

- A session cannot `ssh` to the server, by any route.
- `prod_sql` asks until "Allow for this session"; another session asks again; `prod_sql_write` asks every
  time; `plan_diag` runs without a dialog; all three appear in `mcpguard.log`.
- An `UPDATE` through `prod_sql` fails on the server.
