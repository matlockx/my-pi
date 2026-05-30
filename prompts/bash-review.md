---
description: Review and fix Bash/Shell scripts for SonarCloud compliance, security, and best practices
argument-hint: "<script path>"
---

Load the "bash-scripts" skill first.

Then perform the following steps on the target script(s):

## Step 1: Identify target files

If arguments are provided, review those specific files: $ARGUMENTS

If no arguments are provided, find all `.sh` files and scripts with bash/sh shebangs in the current project.

## Step 2: Run shellcheck

Run `shellcheck -x` on each identified script and capture the output. If shellcheck is not installed, note this and proceed with manual review.

## Step 3: Review against SonarCloud rules

For each script, check every rule from the bash-scripts skill systematically:

**Script setup:**
- Shebang is `#!/usr/bin/env bash`
- `set -euo pipefail` is present

**Security (fix immediately):**
- No weak SSL/TLS protocols (S4423)
- Server certificates are verified (S4830)
- No world-accessible file permissions (S2612)
- Downloaded artifacts are verified before execution (S8482)
- No clear-text protocols (S5332)
- No protocol downgrade allowances (S6506)
- No weak hashing for security purposes (S4790)
- Dependencies are version-pinned (S7694)
- Package manager scripts are not blindly executed (S6505/S8541/S8542)

**Reliability (fix immediately):**
- All variables are quoted during expansion (S7674)
- No identical expressions on both sides of operators (S1764)
- No self-assigned variables (S1656)

**Maintainability (fix):**
- `[[ ]]` used instead of `[ ]` (S7688)
- `$()` used instead of backticks (S7689)
- Function params assigned to local named variables (S7679)
- Functions have documentation comments (S7678)
- Functions end with explicit return (S7682)
- Error messages go to stderr (S7677)
- Variable names follow conventions (S7684)
- Variables use braced form `${var}` (S7680)
- Functions named in snake_case (S100)
- `case` has default `*)` clause (S131)
- `if/elif` chains end with `else` (S126)
- Functions are not too long (S138)
- `case` clauses are not too long (S1151)
- Mergeable `if` statements are combined (S1066)
- No unused local variables (S1481)
- No duplicated string literals (S1192)
- Filenames cannot expand into options (S6573)
- Consent flags used for non-interactive execution (S6584)
- TODO/FIXME comments have ticket references (S1135)

## Step 4: Report findings

Provide a summary table of all findings grouped by severity:
- BLOCKER / CRITICAL: Must fix
- MAJOR: Should fix
- MINOR / INFO: Nice to fix

Include the SonarCloud rule ID (e.g., S7674) for each finding.

## Step 5: Apply fixes

Apply all fixes to the scripts. For each fix:
1. Reference the rule ID
2. Show what changed
3. Ensure the fix does not break functionality

After applying fixes, run shellcheck again to verify the scripts pass cleanly.
