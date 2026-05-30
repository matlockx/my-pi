---
description: Review and fix Python code for Ruff and SonarCloud compliance, security, and best practices
argument-hint: "<file or directory path>"
---

Load the "python" skill first.

Then perform the following steps on the target Python file(s):

## Step 1: Identify target files

If arguments are provided, review those specific files: $ARGUMENTS

If no arguments are provided, find all `.py` files in the current project (excluding `.venv/`, `venv/`, `__pycache__/`, `.eggs/`, `*.egg-info/`, `node_modules/`, `.git/`).

## Step 2: Run linting and formatting tools

Run the following tools if available and capture the output:
1. `ruff check .` - lint for all configured rule sets
2. `ruff format --check .` - check formatting compliance
3. `mypy .` or `mypy src/` - type checking (if configured in pyproject.toml)
4. `bandit -r src/` - security scan (if installed and not covered by ruff S rules)

If a tool is not installed, note this and proceed with manual review.

## Step 3: Review against SonarCloud and Ruff rules

For each Python file, check every rule from the python skill systematically:

**Project setup:**
- `pyproject.toml` exists with ruff configuration
- Module-level docstring present
- Imports sorted correctly (stdlib, third-party, local)
- Type hints on all public function signatures

**Security (fix immediately):**
- No hardcoded credentials (S2068 / S105-S107)
- No weak SSL/TLS protocols (S4423 / S502-S504)
- SSL certificate verification not disabled (S5527 / S501)
- No SQL injection via string formatting (S2077, S5131)
- No command injection via shell=True (S5131 / S602-S607)
- No weak hashing for security purposes (S4790 / S303-S304)
- No clear-text protocols (S5332)
- Cryptographically secure random for security use (S2245 / S311)
- No weak encryption algorithms (S5542)
- JWT signatures verified (S5659)
- No insecure deserialization - pickle, unsafe yaml (S6781 / S301, S506)
- Debug mode not hardcoded on (S4507)
- Temp files use tempfile module (S5443 / S108)

**Reliability (fix immediately):**
- No bare except clauses (S5754 / E722)
- All code paths reachable (S1763)
- No dead stores / unused assignments (S1854 / F841)
- Return values of pure functions not discarded (S2201)
- No mutable default arguments (B006)
- Exceptions chained with `from` (B904)
- No shadowing of built-in names (S5632 / A001-A003)
- Functions don't always return the same value (S3516)
- No StopIteration in generators (S5722)

**Maintainability (fix):**
- Functions and methods use snake_case (S100 / N802)
- Classes use PascalCase (N801)
- Variables use snake_case (N806)
- Functions not too many parameters, max 7 (S107)
- Functions not too long, max ~50 lines (S138)
- Cognitive complexity under 15 (S3776 / C901)
- No unused local variables (S1481 / F841)
- No commented-out code (S125 / ERA001)
- No duplicate string literals (S1192)
- Mergeable if statements combined (S1066 / SIM102)
- match/case has default case _ (S131)
- TODO/FIXME comments have ticket references (S1135)
- No print() statements, use logging (T201)
- Use pathlib over os.path (PTH rules)
- Use timezone-aware datetimes (DTZ rules)
- Use modern Python syntax - f-strings, union types, builtin generics (UP rules)
- Use context managers for file operations (SIM115)
- Simplify comprehensions (C4 rules)
- Unused function arguments prefixed with _ (ARG001)

## Step 4: Report findings

Provide a summary table of all findings grouped by severity:
- BLOCKER: Must fix immediately - injection, hardcoded creds, insecure deserialization
- CRITICAL: Must fix - TLS, weak crypto, cognitive complexity, bare except
- MAJOR: Should fix - naming, unused vars, dead code, function length
- MINOR / INFO: Nice to fix - TODOs, string dedup, import order

Include the SonarCloud rule ID (e.g., S2068) and/or Ruff rule code (e.g., S105, F841) for each finding.

## Step 5: Apply fixes

Apply all fixes to the Python files. For each fix:
1. Reference the rule ID (SonarCloud and/or Ruff)
2. Show what changed
3. Ensure the fix does not break functionality

After applying fixes:
1. Run `ruff check .` to verify lint issues are resolved
2. Run `ruff format .` to ensure consistent formatting
3. Run `mypy .` if configured to verify type safety
4. Run `python -m py_compile <file>` on each modified file to verify syntax
