---
name: implement-plan
description: Implement technical specs from notes/specs/ with verification. Use when the user wants to execute an approved implementation spec. Trigger on mentions of "implement plan", "execute plan", "implement spec", "start implementation", or "build feature".
---

# Implement Plan

You are tasked with implementing an approved technical spec. Specs live in `notes/specs/` and contain phases with specific changes and success criteria.

## Resolving the Notes Directory

1. **Get the current repo name**:

   ```bash
   basename "$(git remote get-url origin 2>/dev/null | sed 's/\.git$//')" 2>/dev/null
   ```

   If this fails, fall back to `basename "$(git rev-parse --show-toplevel 2>/dev/null)"`, then to `basename "$PWD"`.

2. **Resolve the specs path**:
   - If `$LLM_NOTES_ROOT` is set → `$LLM_NOTES_ROOT/<repo>/notes/specs/`
   - Otherwise → `notes/specs/` relative to the repo root

## Getting Started

When given a spec path:

1. **If given a spec path**:
   - Read the spec completely and check for any existing checkmarks (`- [x]`)
   - Check the YAML frontmatter for `work_state` — warn if it's still `draft`
   - Read all files mentioned in the spec
   - **Read files fully** — never use limit/offset parameters, you need complete context
   - Think deeply about how the pieces fit together
   - Create a todo list using markdown checkboxes to track your progress
   - Start implementing if you understand what needs to be done

3. **If no spec path provided**, ask for one:

   ```
    Which spec would you like to implement? Provide a path.

   Tip: List recent specs with `ls -lt notes/specs/ | head`
   ```

## Implementation Philosophy

> **Before writing any code**, load and follow the companion skills:
> - `/skill:golang` — Go style, naming, error handling, patterns
> - `/skill:tdd-workflow` — write tests first, verify 80%+ coverage
>
> All implementation must conform to these standards throughout.

Specs are carefully designed, but reality can be messy. Your job is to:

- Follow the spec's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the spec as you complete sections

When things don't match the spec exactly, think about why and communicate clearly. The spec is your guide, but your judgment matters too.

If you encounter a mismatch:

- STOP and think deeply about why the spec can't be followed
- Present the issue clearly:

  ```
  Issue in Phase [N]:
  Expected: [what the spec says]
  Found: [actual situation]
  Why this matters: [explanation]
  How should I proceed?
  ```

## Verification Approach

After implementing a phase:

- Run the success criteria checks (usually `make check test` covers everything)
- Fix any issues before proceeding
- Update your progress in both the spec and your todos
- Check off completed items in the spec file itself using Edit
- **Pause for human verification**: After completing all automated verification for a phase, pause and inform the human that the phase is ready for manual testing:

  ```
  Phase [N] Complete - Ready for Manual Verification

  Automated verification passed:
  - [List automated checks that passed]

  Please perform the manual verification steps listed in the spec:
  - [List manual verification items from the spec]

  Let me know when manual testing is complete so I can proceed to Phase [N+1].
  ```

If instructed to execute multiple phases consecutively, skip the pause until the last phase. Otherwise, assume you are just doing one phase.

Do not check off items in the manual testing steps until confirmed by the user.

## If You Get Stuck

When something isn't working as expected:

- First, make sure you've read and understood all the relevant code
- Consider if the codebase has evolved since the spec was written
- Present the mismatch clearly and ask for guidance

Use skills sparingly — mainly for targeted debugging or exploring unfamiliar territory.

## Resuming Work

If the spec has existing checkmarks:

- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.

## Spec State Management

### States

- **draft** — initial state for new or modified specs
- **approved** — finalized and approved for implementation

### Editing Approved Specs

When a user requests changes to an approved spec:

1. Detect `work_state: approved` in YAML frontmatter
2. Ask: "This spec is approved. Modifying it will revert to draft state. Continue?"
3. If confirmed:
   - Revert `work_state` to `draft` in the spec file
   - Remove `approvedAt` from YAML frontmatter
4. If declined: cancel the modification

## Integration with Other Skills

- `/skill:golang` — Go code style and best practices. **Load this before writing any code.**
- `/skill:tdd-workflow` — TDD process, test patterns, and coverage requirements. **Load this before writing any code.**
- `/skill:iterate-plan` — Modify an existing spec. Use this for targeted changes to a spec without full reimplementation.
- `/skill:notes-locator` — Find existing specs, research docs, and related notes.
