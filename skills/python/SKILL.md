---
name: python
description: Write and review Python code with uv, Ruff and mypy; covers project setup and the security and reliability rules the linters do not enforce
---

## What I do

Set up and write Python projects so that Ruff and mypy carry the mechanical rules, and point out
the rules no configured linter checks. SonarCloud rule IDs appear as references; do not run Sonar
scans or coverage gates unless the user explicitly asks.

## Project setup

Projects use `uv` (`uv init`, `uv add`, `uv run`, committed `uv.lock`); never `pip install` into a
system or global environment. Minimum `pyproject.toml`:

```toml
[project]
name = "my-project"
requires-python = ">=3.12"

[tool.ruff]
target-version = "py312"
line-length = 120

[tool.ruff.lint]
select = [
    "E", "W",  # pycodestyle
    "F",       # pyflakes
    "I",       # isort
    "N",       # pep8-naming
    "UP",      # pyupgrade
    "S",       # flake8-bandit (security)
    "B",       # flake8-bugbear
    "A",       # flake8-builtins
    "C4",      # flake8-comprehensions
    "DTZ",     # flake8-datetimez
    "T20",     # flake8-print
    "SIM",     # flake8-simplify
    "TC",      # flake8-type-checking
    "ARG",     # flake8-unused-arguments
    "PTH",     # flake8-use-pathlib
    "ERA",     # eradicate (commented-out code)
    "C90",     # mccabe complexity
    "RUF",     # Ruff-specific rules
]

[tool.ruff.lint.mccabe]
max-complexity = 15

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S101"]  # assert is how pytest asserts

[tool.mypy]
python_version = "3.12"
strict = true
```

Match an existing project's `requires-python` and `target-version` instead of lowering them.
Add tools as dev dependencies (`uv add --dev ruff mypy pytest`) and run them through uv:

```bash
uv run ruff check .          # lint; --fix for safe fixes
uv run ruff format --check . # formatting
uv run mypy .                # types (strict)
uv run pytest
```

For pre-commit, use `astral-sh/ruff-pre-commit` and `pre-commit/mirrors-mypy` with `rev:` set to
the current release tag, looked up when writing the file (`pre-commit autoupdate`), never copied
from an example.

## What the linters already cover

With the config above, Ruff flags: hardcoded passwords (S105-S107), `shell=True` and shell-like
subprocess calls (S602-S607), SQL built by string formatting (S608), unsafe `pickle`/`yaml.load`
(S301, S506), disabled certificate checks (S501), weak hashes and ciphers (S303-S305), `random`
for security values (S311), hardcoded `/tmp` paths (S108), `except: pass` (S110), bare `except:`
(E722), mutable default arguments (B006), `raise` without `from` inside `except` (B904), naive
datetimes (DTZ), `print` (T20), `os.path` (PTH), commented-out code (ERA), unused variables and
imports (F841, F401), shadowed built-ins (A), old syntax (UP). mypy `strict` requires annotations
on every function. Fix these where the tool points; do not restate them in reviews.

## Rules the linters do not enforce

Check these by hand when writing and reviewing:

- **JWT signatures are always verified** (S5659). Pass the key and an explicit `algorithms` list;
  never `options={"verify_signature": False}`.
  ```python
  data = jwt.decode(token, key=public_key, algorithms=["RS256"])
  ```
- **Debug mode is off unless configured on** (S4507). Read it from the environment with a false
  default; never `DEBUG = True` or `app.run(debug=True)` in committed code.
- **No clear-text protocols** (S5332): `https://`, `sftp://`, `ssh`; `http://` only for
  `localhost` and in-cluster addresses that are documented as such.
- **Secrets come from the environment or a secret manager**, are never logged, and never appear
  in exception messages or `repr`. Tokens use `secrets.token_urlsafe()`.
- **`match` has a `case _:`** that handles or raises (S131).
- **Results of pure calls are used** (S2201): `sorted(x)`, `s.strip()`, `s.replace(...)` return
  new values; a bare call statement is a bug.
- **Exceptions are specific.** Raise `ValueError`, `LookupError` or a domain subclass, never bare
  `Exception`. Catch `Exception` only at a process or request boundary, and log it there.
  ```python
  class AppError(Exception):
      """Base class for errors this application raises."""

  class NotFoundError(AppError):
      """Raised when a requested record does not exist."""
  ```
- **Functions stay small**: under about 50 lines and cognitive complexity under 15 (S138, S3776).
  `C901` catches branching, not length or nesting depth.
- **Abstract types come from `collections.abc`** (`Sequence`, `Mapping`, `Callable`, `Iterator`),
  concrete built-ins are used for annotations (`list[str]`, `dict[str, int]`), and `Any` appears
  only at an untyped boundary.
- **Input from outside the process is validated once at the boundary** (pydantic, msgspec or an
  explicit parser) and passed on as a typed value.
- **Files and connections use context managers** (`with open(...)`, `with conn:`).

## Checklist for new or changed Python files

- [ ] `uv run ruff check .`, `uv run ruff format --check .` and `uv run mypy .` pass
- [ ] Every rule in "Rules the linters do not enforce" holds
- [ ] Module docstring only where the purpose is not obvious from the name
- [ ] Constants `UPPER_SNAKE_CASE`, functions `snake_case`, classes `PascalCase`
- [ ] Logging through `logging`, never `print`
- [ ] Tests (pytest) for each new behaviour; `assert` allowed in `tests/` only

## Checklist for review

- [ ] Injection: SQL parameterised, subprocess in list form, no `eval`/`exec` on input
- [ ] Deserialisation: no `pickle`/unsafe YAML on untrusted data
- [ ] Crypto: certificate checks on, JWT verified, strong hashes, `secrets` for tokens
- [ ] Secrets: none in code, logs, exception messages or test fixtures
- [ ] Errors: specific types, `from` when re-raising, no swallowed exceptions
- [ ] Linter suppressions (`# noqa`, `# type: ignore`) carry a code and a reason
