---
name: pr-description
description: Generate or update a pull request description from the repository's PR template and the PR's diff and commits. Use when the user asks for a PR description ("describe PR", "PR desc", "generate PR"). Asks before replacing an existing description.
---

# Generate a PR description

Writes the description of one pull request from the repository's template and the PR's actual
changes, then updates the PR after the user agrees.

GitHub access goes through the GitHub MCP tools (`pull_request_read`, `search_pull_requests`,
`update_pull_request`, `get_file_contents`). The `gh` CLI does not work inside the sandbox; do not
rely on it.

## 1. Identify the repository and the PR

- Owner and repo from `git remote get-url origin`.
- The PR: the number the user gave; otherwise `search_pull_requests` with
  `repo:<owner>/<repo> is:open head:<current branch>`. If there is none, or the branch is `main`,
  list the open PRs and ask which one.

## 2. Find the template

Use the first that exists, read from the working tree (or `get_file_contents` on the base branch):

1. `.github/pull_request_template.md` (any case: `PULL_REQUEST_TEMPLATE.md`)
2. `pull_request_template.md` or `docs/pull_request_template.md`
3. `.github/PULL_REQUEST_TEMPLATE/*.md` — several templates: ask which one applies
4. `notes/prs/pr_description.md`

No template: use **Why**, **What changed**, **Evidence**, **Merge danger**, and say that no
template was found.

## 3. Check the existing description

`pull_request_read` with `method: get`. If the body is not empty and not just the unfilled
template, show it and ask whether to replace it, merge new information into it, or stop. Never
overwrite a written description without that answer.

## 4. Gather the changes

`pull_request_read` with:

- `get` — title, base branch, author, linked issues in the body
- `get_files` — changed files (paginate with `perPage`/`page` on large PRs)
- `get_diff` — the full diff; for files cut from it, read them in the working tree
- `get_commits` — commit messages, which often carry the why
- `get_check_runs` — CI state, for the verification section

Read referenced code that the diff does not show when it is needed to explain the change.

## 5. Analyse

- Why the change exists (issue, bug, decision record), not only what it does.
- User-visible changes apart from internal ones.
- Breaking changes: API or event contracts, schema migrations, config or environment variables,
  removed flags. These go near the top.
- Changed metrics, alerts or dashboards (AGENTS.md: metric changes list their consumers).
- Decision records (`docs/bdr`, `docs/adr`) the change implements or touches, by ID.
- Evidence that it works: a before/after pair (failing then passing test run, command output,
  screenshot for UI), not only "tests pass".
- Merge danger: a **one-way door** (destructive or hard to roll back: data migration, deleted
  data, published event schema, external contract) or a **two-way door** (a revert undoes it),
  and the **blast radius** (which consumers, services or users a fault reaches). Goes into the
  template's risk or rollback section; a template without one gets a short **Merge danger**
  section after its last section. Adapted from mattpocock/skills `pr` (MIT).

## 6. Verification items

For each checklist item in the template's verification section:

- A command this machine can run (`make check`, `go test ./...`, `npm test`): run it; tick it on
  success, leave it unticked with the failing output summarised otherwise.
- A CI result: tick it only if `get_check_runs` shows it passed on the head commit.
- Manual testing: leave unticked and list it for the user.

## 7. Write and confirm

Fill every template section; delete instructional placeholder text. Be concrete and scannable:
the reviewer should learn why, what, risk and how to verify within a minute. Show the full
description to the user and ask before updating the PR.

## 8. Update the PR

`update_pull_request` with `body` set to the description (and `title` only if the user agreed to
a new title). Confirm by reading the PR again, and list any verification items still open.

If the repository keeps descriptions in `notes/prs/`, also write `notes/prs/<number>_description.md`.
