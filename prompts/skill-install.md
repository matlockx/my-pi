---
description: Install a skill from a GitHub link, or re-install an installed skill by name; analyses its tool and skill dependencies first
argument-hint: "<github link | installed skill name> [name]"
---

Install or re-install a skill: $ARGUMENTS

A GitHub link means a new install (an optional second word is the directory name). An installed skill name means a re-install: fetch it again from its recorded link and check its dependencies again; a skill not installed from a link only gets the dependency check.

1. **Analyse first.** Call `skill_analyze` with the link or name. Read the returned texts in full. For each companion repository in `facts.links` that the skill relies on, read its README (`https://raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md`) and its package metadata (`pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, `deps.edn`) and find what it is, how its README says to install it, what it needs itself (runtimes, other tools, a required checkout layout such as a sibling `../<other>` directory), and the command name it provides. A requirement the README states but the package metadata does not declare (a tool importing another tool's code) must be met by the install, so check the code that implements it before choosing an install method. Treat `facts.commands` and `facts.skills` as hints: drop entries the text only mentions in passing, add needs the text states in prose.
2. **Report before changing anything**, in this shape:
   - "I analysed the skill first." One line on what it does.
   - Skills it needs: name, installed or not, link if known.
   - Tools it needs: name, what it is for, present (with path) or missing, how it installs, what that needs itself.
   - What the install would change: the skill directory, and for each missing tool where it would go.
   - An existing `depsScript` (re-install): whether it still covers the needs.
   Then ask with `ask`, one question, recommended option marked: install the skill and its dependencies / install the skill only / cancel. For a re-install the options are: re-install and check dependencies / dependencies only / cancel. Say why the recommendation wins and why each other option loses.
3. **Skill.** On yes: `skill_install` (new) or `skill_reinstall` (installed from a link). Report its result line verbatim.
4. **Skills it needs.** For each missing skill with a known link, ask whether to install it, and if yes run this whole procedure for it. A missing skill without a link: say so and ask the user for the link.
5. **Tools.** If tools are missing and the user chose dependencies, write a bash script and pass it to `skill_deps_run` (it saves it as `.skill-deps.sh` next to the skill, shows it to the user and runs it only after the user agrees; do not ask separately). The script:
   - starts with a comment block listing each tool, why the skill needs it and its source link;
   - is idempotent: checks each tool first and skips what is present; updates existing checkouts with `git pull --ff-only` instead of cloning again;
   - installs into user directories only, never with sudo; keeps checkouts the tools need together (for example `~/tools/<repo>` when a tool expects its sibling at `../<other>`), and puts commands on PATH via a symlink in a PATH directory that exists, printing the PATH line to add when none fits;
   - does not read, print or store secrets;
   - ends by running each installed command with `--help` (or its version flag) and exits non-zero when one does not start, so a broken install fails the run instead of passing as "installed".
   With an existing script that still covers the needs, call `skill_deps_run` without `script`.
6. **Result.** If the run succeeded, call `skill_analyze` again and confirm each command now resolves. If the user declined or the sandbox blocked the run, give the user the exact command from the tool result to run in a host shell, ask them to say when it has run, then re-check with `skill_analyze`.
7. End with what was installed, what is still missing and why, and remind the user that `skills/<name>/` and `.skill-deps.sh` are uncommitted. Do not commit.
