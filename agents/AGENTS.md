# AGENTS.md

## Golden Rules

When unsure, **ask the developer** before making changes.

| # | DO | DON'T |
|---|-----|-------|
| G-1 | Add/update `DEV-NOTE:` anchors near non-trivial edits | Delete/mangle existing `DEV-` comments |
| G-2 | Follow lint/style configs (`.golangci.yml`, `pyproject.toml`, `.prettierrc`) | Re-format to other styles |
| G-3 | Ask confirmation for >300 LOC or >3 files | Refactor large modules without guidance |
| G-4 | Stay in current task context | Continue prior task after "new task" |

## Environment

- Shell: **fish** syntax. No `$()` or `export VAR=value`.
- **Never commit/push** without explicit approval.
- **Use `rg`** instead of `grep`.

## Skill Auto-Loading

| Pattern | Skill |
|---------|-------|
| `.go` | golang |
| `.sh` | bash-scripts |
| `.github/workflows/*.yml` | github-actions |
| `.ts`/`.mts`/`.cts` | typescript |
| `.tsx` | typescript + react |
| `.jsx` | react |
| `.py` | python |

## Anchor Comments

Use `DEV-NOTE:`, `DEV-TODO:`, `DEV-QUESTION:` markers near non-trivial code. These annotations are for all developers — human and agent alike. Search existing anchors before scanning. Update when modifying associated code. Never remove without human instruction.

If you encounter the old `AIDEV-NOTE:`, `AIDEV-TODO:`, or `AIDEV-QUESTION:` prefix in any file, migrate it to the `DEV-` equivalent in the same edit.

## Commits

Provide commit message example, **wait for input**. Never push. Never start new task unprompted.

## Tests

Tests are contracts. Never modify assertions solely to match new code. Never delete tests without approval. Investigate first.

## Context7

Use `ctx7` first for library/API lookups: `npx ctx7@latest library <name>` then `npx ctx7@latest docs <id> "<question>"`. Fall back to source only if no results.

## BEADS (opt-in)

Load `beads` skill only when user explicitly asks. Otherwise use to-do lists.

**NEVER** add beads issue IDs (e.g. `bd-123`) into code as comments. Beads IDs belong in the issue tracker, not the source.

## Workflow

1. Check `AGENTS.md` files → 2. Clarify ambiguities → 3. Plan → 4. Trivial: go. Non-trivial: present plan → 5. Track progress → 6. Update docs/anchors → 7. User review

## Never Do

- Modify tests without explaining why
- Change API contracts
- Alter migration files
- Commit secrets
- Assume business logic
- Remove DEV- comments
- Use emojis in documentation, commit messages, or any written output

Optimize for maintainability. When in doubt, choose boring.

## Files to NOT modify

- `.agentignore`, `.agentindexignore` — control AI indexing
