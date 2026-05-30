# AGENTS.md

## The Golden Rule

When unsure about implementation details, ALWAYS ask the developer.

---

## Non-negotiable golden rules

| #   | AI _may_ do | AI _must NOT_ do |
|-----|-------------|------------------|
| G-0 | Whenever unsure about something project-specific, ask the developer for clarification before making changes. | Write changes or use tools when you are not sure about something project specific, or if you don't have context for a particular feature/decision. |
| G-1 | Add/update **`AIDEV-NOTE:` anchor comments** near non-trivial edited code. | Delete or mangle existing `AIDEV-` comments. |
| G-2 | Follow lint/style configs (`.golangci.yml`, `pyproject.toml`, `.prettierrc`). Use the project's configured linter instead of manually re-formatting. | Re-format code to any other style. |
| G-3 | For changes >300 LOC or >3 files, **ask for confirmation**. | Refactor large modules without human guidance. |
| G-4 | Stay within the current task context. Inform the dev if it'd be better to start afresh. | Continue work from a prior prompt after "new task" — start a fresh session. |

---

## Environment

- Shell: **fish**. Use fish syntax. Never use `$()` or `export VAR=value`.
- **Never commit or push without explicit user approval.**
- **Never use `grep` in Bash. Use `rg` instead.**

---

## Skill Auto-Loading

Before writing, reviewing, or modifying code, load the matching skill(s):

| File pattern | Skill(s) |
|---|---|
| `.go` | golang |
| `.sh`, shell scripts | bash-scripts |
| `.tf` | terraform-iac |
| `Chart.yaml`, `values.yaml`, `templates/` | helm-charts |
| ArgoCD Application/AppProject manifests | argocd |
| `.github/workflows/*.yml`, `action.yml` | github-actions |
| `.ts`, `.mts`, `.cts` | typescript |
| `.tsx` | typescript + react |
| `.jsx` | react |
| `.py` | python |

**Skill load failures:** Inform the user and proceed with caution.

---

## Code Style and Patterns

### Anchor comments

Add specially formatted comments throughout the codebase for inline knowledge that can be easily searched.

- Use `AIDEV-NOTE:`, `AIDEV-TODO:`, or `AIDEV-QUESTION:` (all-caps prefix) for comments aimed at AI and developers.
- Before scanning files, always first try to **search for existing anchors** `AIDEV-*` in relevant subdirectories.
- **Update relevant anchors** when modifying associated code.
- **Do not remove `AIDEV-NOTE`s** without explicit human instruction.
- Add relevant anchor comments whenever code is too complex, very important, confusing, or could have a bug.

---

## Commit discipline

Once a task is finished, provide a git commit message example AND WAIT FOR INPUT before doing anything else. Never start a new task without being prompted.

- **Clear commit messages**: Explain the _why_; link to issues/ADRs if architectural.
- **Review AI-generated code**: Never merge code you don't understand.
- NEVER push or do any actions on the remote branch.

---

## Test Regression Prevention

Existing tests are a contract. **Never modify existing test assertions solely to match new code behavior.** Investigate first and explain why before changing. **Never delete existing tests** without explicit user approval.

---

## Context7 — Library Docs

**Always use `ctx7` first** when looking up library/framework/API behavior, configuration, or usage.
Do not read vendored source, Go module cache, or web docs as a first resort — use `ctx7`:
`npx ctx7@latest library <name>` then `npx ctx7@latest docs <id> "<question>"`.
Fall back to source/web only if `ctx7` has no results or quota is exhausted.
On quota error: suggest `npx ctx7@latest login`.

---

## BEADS — Task Tracking (opt-in)

Load the `beads` skill for the full command reference. Activate only when:
- The user explicitly asks to track tasks, create issues, or manage work items
- The user invokes `/beads` or references an existing issue/epic

When inactive, use a to-do list for step-level tracking.

---

## Directory-Specific AGENTS.md Files

- **Always check for `AGENTS.md` files in specific directories** before working on code within them.
- If a directory's `AGENTS.md` is outdated or incorrect, **update it**.
- If you make significant changes to a directory's structure, **document these in its `AGENTS.md`**.
- If a directory lacks an `AGENTS.md` but contains complex logic, **suggest creating one**.

---

## AI Assistant Workflow

When responding to user instructions:

1. **Consult Relevant Guidance**: Check `AGENTS.md` files (root and directory-specific).
2. **Clarify Ambiguities**: Ask targeted questions before proceeding.
3. **Break Down & Plan**: Chalk out a rough plan referencing project conventions.
4. **Trivial Tasks**: Go ahead immediately.
5. **Non-Trivial Tasks**: Present the plan for review and iterate on feedback.
6. **Track Progress**: Use a to-do list for multi-step tasks.
7. **If Stuck, Re-plan**: Return to step 3 to re-evaluate.
8. **Update Documentation**: Update anchor comments and `AGENTS.md` files you touched.
9. **User Review**: Ask the user to review, repeat as needed.
10. **Session Boundaries**: Suggest starting fresh if context would cause confusion.

---

## What AI Must NEVER Do

1. **Never modify test files** without explaining why — tests encode human intent
2. **Never change API contracts** — breaks real applications
3. **Never alter migration files** — data loss risk
4. **Never commit secrets** — use environment variables
5. **Never assume business logic** — always ask
6. **Never remove AIDEV- comments** — they're there for a reason

Remember: We optimize for maintainability over cleverness.
When in doubt, choose the boring solution.

---

<!-- codebase-memory:start -->
## Codebase Knowledge Graph (codebase-memory)

This repository has a code knowledge graph indexed by codebase-memory-mcp.
The following Pi tools are available for structural code intelligence:

- `get_architecture` — high-level overview (node/edge counts, labels, modules)
- `search_graph` — find symbols by name or keyword
- `trace_path` — trace callers, callees, and dependency paths
- `query_graph` — flexible Cypher-style graph queries
- `get_code_snippet` — retrieve source for a symbol by qualified_name
- `search_code` — text-pattern search returning graph nodes
- `index_status` — check if the index is current
- `detect_changes` — find files changed since last index

### When to use

- Use `get_architecture` first when exploring an unfamiliar codebase or subsystem.
- Use `search_graph` to discover symbols before reading source files.
- Use `trace_path` before refactoring shared code to understand callers/callees.
- Use `get_code_snippet` to view a specific function without reading the whole file.
- Use `query_graph` for advanced structural queries (call `get_architecture` first to see labels/edges).
<!-- codebase-memory:end -->

---

## Files to NOT modify

These files control AI indexing and should not be modified without permission:
- `.agentignore` — files ignored by AI tools
- `.agentindexignore` — files excluded from indexing

**When adding new files**, check these ignore patterns to ensure proper inclusion.
