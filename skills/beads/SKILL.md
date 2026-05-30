---
name: beads
description: BEADS task tracking CLI — command reference for creating issues, epics, todos, and managing work items with the bd tool
---

## BEADS — Task Tracking CLI

### Availability

Check first: `command -v bd`

### Commands

- **Create issue:** `bd create "<title>" -t <type> -p <priority> [--parent <epic-id>]`
- **Claim:** `bd update <id> --claim`
- **Close:** `bd close <id> --reason "<what was done>"`
- **Todos:** `bd todo add "Step"` / `bd todo list` / `bd todo done <id>`
- **Epics:** `bd create "Epic: <summary>" -t epic` then `bd create "Step: ..." --parent <epic-id> -t task`
- **Persist state:** `bd dolt commit` (run before session end if beads was used)
- **Check readiness:** `bd ready --json`

### Types & Priorities

**Types:** `bug`, `feature`, `task`, `epic`, `chore`
**Priorities:** `0` critical, `1` high, `2` medium (default), `3` low, `4` backlog

### Engram Bridging

When beads is active, close issues via `bd close` before calling `mem_session_summary`. If `mem_save` returns `judgment_required: true`, call `mem_judge` to resolve conflicts.
