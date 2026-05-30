---
name: bash-scripts
description: Write and review Bash scripts following SonarCloud default rule set for Shell analysis, covering security, reliability, and maintainability best practices
---

## What I do

Guide writing and reviewing Bash scripts that are compliant with SonarCloud's default Shell analysis rule set (41 rules). This covers security vulnerabilities, reliability bugs, and maintainability code smells.

## When to use me

Use this skill when:
- Writing new Bash scripts (`.sh` files)
- Reviewing or refactoring existing Bash scripts
- Fixing SonarCloud issues in shell scripts
- Preparing scripts for CI/CD pipelines that run SonarCloud analysis

## Script setup

Every Bash script MUST start with:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

- Use `#!/usr/bin/env bash` as the shebang (not `#!/bin/bash`) for portability.
- `set -e` exits on error, `-u` treats unset variables as errors, `-o pipefail` catches pipe failures.
- Add a 1-line file header comment describing the script's purpose.

## SonarCloud Shell rules - Security

### S4423 - Do not use weak SSL/TLS protocols (CRITICAL)
Never use SSLv2, SSLv3, TLSv1, or TLSv1.1. Always enforce TLSv1.2 or higher.
```bash
# BAD
curl --tlsv1.0 https://example.com
# GOOD
curl --tlsv1.2 https://example.com
```

### S4830 - Always verify server certificates (CRITICAL)
Never disable SSL certificate verification.
```bash
# BAD
curl -k https://example.com
curl --insecure https://example.com
wget --no-check-certificate https://example.com
# GOOD
curl https://example.com
```

### S2612 - Do not set world-accessible file permissions (MAJOR)
Never use `chmod 777`, `chmod 666`, or any permission granting world write/execute. Use restrictive permissions.
```bash
# BAD
chmod 777 script.sh
chmod 666 config.txt
# GOOD
chmod 700 script.sh
chmod 600 config.txt
```

### S8482 - Verify downloaded artifacts before executing (BLOCKER)
Always verify checksums or signatures of downloaded files before executing them. Never pipe curl/wget directly to a shell.
```bash
# BAD
curl -s https://example.com/install.sh | bash
# GOOD
curl -o install.sh https://example.com/install.sh
echo "expected_sha256  install.sh" | sha256sum -c -
bash install.sh
```

### S5332 - Do not use clear-text protocols (CRITICAL, hotspot)
Avoid HTTP, FTP, Telnet, and other unencrypted protocols. Always prefer HTTPS, SFTP, SSH.
```bash
# BAD
curl http://example.com/data
ftp example.com
# GOOD
curl https://example.com/data
sftp example.com
```

### S6506 - Do not allow protocol downgrades (MAJOR, hotspot)
Never pass flags that allow fallback from HTTPS to HTTP (e.g., `--proto-default http`).

### S4790 - Avoid weak hashing algorithms (CRITICAL, hotspot)
Do not use MD5 or SHA1 for security purposes. Use SHA-256 or stronger.
```bash
# BAD
md5sum file.bin
sha1sum file.bin
# GOOD
sha256sum file.bin
```

### S7694 - Pin dependency versions (MAJOR, hotspot)
When installing dependencies, always use lock files or pin exact versions. Avoid unversioned installs in scripts.
```bash
# BAD
pip install requests
npm install lodash
# GOOD
pip install requests==2.31.0
pip install -r requirements.txt  # with pinned versions
npm ci                           # uses package-lock.json
```

### S6505, S8541, S8542 - Do not execute package manager scripts during install (MAJOR)
Avoid running arbitrary lifecycle scripts when installing packages (npm/pip/composer). Use flags like `--ignore-scripts`.
```bash
# BAD
npm install  # runs postinstall scripts by default
# GOOD
npm install --ignore-scripts
```

## SonarCloud Shell rules - Reliability

### S7674 - Always quote variables during expansion (MAJOR, HIGH impact)
Unquoted variable expansions cause word splitting and globbing bugs. Always double-quote variables.
```bash
# BAD
cp $file $dest
rm $path
if [ -f $config ]; then
# GOOD
cp "${file}" "${dest}"
rm "${path}"
if [[ -f "${config}" ]]; then
```
Exceptions: Inside `[[ ]]` on the left side of `=`, arithmetic contexts `$(( ))`, and array indices.

### S1764 - Do not use identical expressions on both sides of an operator (MAJOR)
This is almost always a copy-paste bug.
```bash
# BAD
if [[ "${x}" == "${x}" ]]; then
result=$((x + x))  # fine if intentional, but review if copy-paste
```

### S1656 - Do not self-assign variables (MAJOR)
```bash
# BAD
foo="${foo}"
# GOOD (if transforming)
foo="${foo:-default}"
```

## SonarCloud Shell rules - Maintainability

### S7688 - Use `[[` instead of `[` for conditional tests (MAJOR, HIGH reliability)
In Bash scripts, always use `[[ ]]` instead of `[ ]`. It prevents word splitting, supports regex, and handles empty variables safely.
```bash
# BAD
if [ -z "$var" ]; then
if [ "$a" = "$b" ]; then
# GOOD
if [[ -z "${var}" ]]; then
if [[ "${a}" == "${b}" ]]; then
```

### S7689 - Use `$()` instead of backticks for command substitution (MINOR)
```bash
# BAD
result=`date +%s`
# GOOD
result=$(date +%s)
```

### S7679 - Assign function parameters to named local variables (MAJOR)
Do not use `$1`, `$2`, etc. directly throughout function bodies. Assign them to descriptive local variables at the top.
```bash
# BAD
process_file() {
  if [[ -f "$1" ]]; then
    grep "$2" "$1"
  fi
}
# GOOD
process_file() {
  local file="$1"
  local pattern="$2"
  if [[ -f "${file}" ]]; then
    grep "${pattern}" "${file}"
  fi
}
```

### S7678 - Document functions with comments (MAJOR)
Comment only non-obvious logic, edge cases, and external dependencies. Max 3 lines per comment block. Prefer descriptive function/parameter names over comments.
```bash
# Reads key from INI-style config; exits 1 if key missing.
process_config() {
  local config_file="$1"
  local key="$2"
  # ...
}
```

### S7682 - Functions should end with explicit return (MAJOR)
Always include an explicit `return` statement at the end of every function. Without it, the function implicitly returns the exit code of the last executed command, which can be unpredictable and masks real failures.

This is one of the most frequently flagged rules in SonarCloud Shell analysis. Every function path must end with `return`.

```bash
# BAD - no explicit return
greet() {
  echo "Hello"
}

# BAD - return only in one branch
process_file() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    echo "File not found: ${file}" >&2
    return 1
  fi
  cat "${file}"
  # Missing return here - implicit exit code of cat
}

# BAD - return missing after loop
process_all() {
  local dir="$1"
  for file in "${dir}"/*; do
    echo "Processing ${file}"
  done
  # Missing return after loop
}

# GOOD - explicit return on all paths
greet() {
  echo "Hello"
  return 0
}

# GOOD - explicit return on every code path
process_file() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    echo "File not found: ${file}" >&2
    return 1
  fi
  cat "${file}"
  return 0
}

# GOOD - return after loop
process_all() {
  local dir="$1"
  for file in "${dir}"/*; do
    echo "Processing ${file}"
  done
  return 0
}

# GOOD - function with multiple branches
deploy() {
  local environment="$1"
  case "${environment}" in
    staging)
      deploy_staging
      return $?
      ;;
    production)
      deploy_production
      return $?
      ;;
    *)
      echo "Unknown environment: ${environment}" >&2
      return 1
      ;;
  esac
}

# GOOD - function with early returns and final return
validate_input() {
  local input="$1"
  if [[ -z "${input}" ]]; then
    echo "Input is empty" >&2
    return 1
  fi
  if [[ "${#input}" -gt 255 ]]; then
    echo "Input exceeds maximum length" >&2
    return 1
  fi
  echo "Input is valid"
  return 0
}
```

**Rule of thumb:** Before closing any function with `}`, check that every reachable path ends with an explicit `return 0` (success) or `return 1` / `return $?` (failure/propagation).

### S7677 - Send error messages to stderr (MAJOR)
Error and warning messages must go to stderr, not stdout.
```bash
# BAD
echo "Error: file not found"
# GOOD
echo "Error: file not found" >&2
```

### S7684 - Follow shell variable naming conventions (MAJOR)
- Local variables: `lower_snake_case`
- Constants / environment exports: `UPPER_SNAKE_CASE`
- Avoid camelCase or PascalCase.

### S7680 - Use braced variable form `${var}` (MAJOR)
Always use `${variable}` instead of `$variable` for clarity and to avoid ambiguity.
```bash
# BAD
echo $name
echo "$name_file"  # ambiguous - is it $name_file or ${name}_file?
# GOOD
echo "${name}"
echo "${name}_file"
```

### S100 - Name functions in snake_case (MINOR)
```bash
# BAD
processFile() { ... }
ProcessFile() { ... }
# GOOD
process_file() { ... }
```

### S131 - `case` statements must have a default `*)` clause (CRITICAL)
```bash
# BAD
case "${action}" in
  start) do_start ;;
  stop) do_stop ;;
esac
# GOOD
case "${action}" in
  start) do_start ;;
  stop) do_stop ;;
  *)
    echo "Unknown action: ${action}" >&2
    return 1
    ;;
esac
```

### S126 - `if/elif` chains must end with `else` (CRITICAL)
```bash
# BAD
if [[ "${mode}" == "fast" ]]; then
  run_fast
elif [[ "${mode}" == "slow" ]]; then
  run_slow
fi
# GOOD
if [[ "${mode}" == "fast" ]]; then
  run_fast
elif [[ "${mode}" == "slow" ]]; then
  run_slow
else
  echo "Unknown mode: ${mode}" >&2
  return 1
fi
```
Note: Simple `if/fi` without `elif` does not require an `else`.

### S138 - Keep functions short (MAJOR)
Functions should not exceed ~50 lines of code. Break large functions into smaller, focused helper functions.

### S1151 - Keep `case` clauses short (MAJOR)
Individual `case` pattern clauses should not have too many lines. Extract logic into functions if a clause grows large.

### S1066 - Combine mergeable `if` statements (MAJOR)
```bash
# BAD
if [[ -f "${file}" ]]; then
  if [[ -r "${file}" ]]; then
    process "${file}"
  fi
fi
# GOOD
if [[ -f "${file}" ]] && [[ -r "${file}" ]]; then
  process "${file}"
fi
```

### S1481 - Remove unused local variables (MINOR)
Do not declare variables that are never read. Clean up dead code. SonarCloud flags every `local` variable that is assigned but never referenced afterwards. This is a frequent source of warnings, especially after refactoring.

```bash
# BAD - 'result' is assigned but never used
process() {
  local input="$1"
  local result=""           # unused - SonarCloud will flag this
  local timestamp
  timestamp=$(date +%s)     # unused - SonarCloud will flag this
  echo "Processing ${input}"
  return 0
}

# BAD - variable used only in assignment to another unused variable
build() {
  local src_dir="$1"
  local output_dir="/tmp/build"    # unused if only referenced in another unused var
  local full_path="${output_dir}/app"  # unused
  echo "Building from ${src_dir}"
  return 0
}

# BAD - variable only used inside a commented-out block
cleanup() {
  local temp_dir="/tmp/myapp"    # will be flagged
  # rm -rf "${temp_dir}"         # commented out, so temp_dir is unused
  echo "Cleanup skipped"
  return 0
}

# GOOD - all variables are used
process() {
  local input="$1"
  echo "Processing ${input}"
  return 0
}

# GOOD - removed the unused variables entirely
build() {
  local src_dir="$1"
  echo "Building from ${src_dir}"
  return 0
}
```

**Common causes and fixes:**

| Cause | Fix |
|-------|-----|
| Leftover variable after refactoring | Delete the declaration |
| Variable for future use | Remove it; add it when actually needed |
| Debug variable left in | Remove or guard with a debug flag |
| Captured command output not used | Remove the variable, run the command directly |
| Copy-paste from another function | Remove variables not relevant to this function |

```bash
# BAD - captured output never used
setup() {
  local current_dir
  current_dir=$(pwd)    # assigned but never referenced
  mkdir -p /tmp/work
  return 0
}

# GOOD - either use it or don't capture it
setup() {
  mkdir -p /tmp/work
  return 0
}
```

### S1192 - Do not duplicate string literals (MINOR)
If the same string appears multiple times, assign it to a constant variable.
```bash
# BAD
echo "Processing stage: compilation"
log "Processing stage: compilation"
# GOOD
readonly STAGE_MSG="Processing stage: compilation"
echo "${STAGE_MSG}"
log "${STAGE_MSG}"
```

### S6573 - Prevent filename expansion becoming options (MAJOR)
Use `--` to separate options from arguments when filenames could start with `-`.
```bash
# BAD
rm $file        # if file is "-rf /", disaster
# GOOD
rm -- "${file}"
```

### S6584 - Use consent flags to avoid manual input (MAJOR)
In scripts, always pass `-y`, `--yes`, `--non-interactive`, or equivalent flags to commands that would otherwise prompt for input.
```bash
# BAD
apt-get install nginx
# GOOD
apt-get install -y nginx
```

### S1135 - Track TODO comments (INFO)
`TODO` and `FIXME` comments are tracked. Ensure they include a ticket reference or action plan. Do not leave unresolved TODOs in production scripts.

## ShellCheck integration

SonarCloud's Shell analysis uses ShellCheck under the hood for many of these rules. For local development:

1. **Install shellcheck**: `brew install shellcheck` (macOS) or `apt-get install shellcheck` (Debian/Ubuntu)
2. **Run before committing**: `shellcheck -x script.sh`
3. **CI integration**: Add shellcheck to your CI pipeline
4. **Pre-commit hook** (recommended):
   ```yaml
   # .pre-commit-config.yaml
   repos:
     - repo: https://github.com/koalaman/shellcheck-precommit
       rev: v0.10.0
       hooks:
         - id: shellcheck
           args: ["-x"]
   ```

ShellCheck directives can suppress specific warnings when there is a justified reason:
```bash
# shellcheck disable=SC2034  # Variable used in sourced file
readonly MY_CONST="value"
```
Always add a comment explaining why the directive is needed.

## Checklist for new scripts

When writing a new Bash script, verify:

- [ ] Shebang is `#!/usr/bin/env bash`
- [ ] `set -euo pipefail` is set
- [ ] All variables are quoted with `"${var}"` syntax
- [ ] Functions use `snake_case` names
- [ ] Function params are assigned to `local` named variables
- [ ] Functions have brief comments for non-obvious logic
- [ ] Functions end with explicit `return`
- [ ] Error messages go to stderr (`>&2`)
- [ ] `[[ ]]` is used instead of `[ ]`
- [ ] `$()` is used instead of backticks
- [ ] `case` has a default `*)` clause
- [ ] `if/elif` chains end with `else`
- [ ] No world-accessible file permissions
- [ ] Downloads are verified before execution
- [ ] HTTPS is used instead of HTTP
- [ ] TLSv1.2+ is enforced
- [ ] Interactive prompts use consent flags (`-y`, etc.)
- [ ] `--` separates options from filename arguments
- [ ] No unused variables
- [ ] No duplicated string literals (use constants)
- [ ] shellcheck passes cleanly
