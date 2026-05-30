---
name: python
description: Write and review Python code following Ruff and SonarCloud SonarPython rules, covering security, reliability, and maintainability best practices
---

## What I do

Guide writing and reviewing Python code that is compliant with Ruff's comprehensive rule set and SonarCloud's default SonarPython analysis rules. This covers security vulnerabilities, reliability bugs, maintainability code smells, type safety, and modern Python idioms.

## When to use me

Use this skill when:
- Writing new Python files (`.py`)
- Reviewing or refactoring existing Python code
- Fixing SonarCloud or Ruff issues in Python projects
- Setting up Python project tooling (ruff, mypy, bandit)
- Preparing Python code for CI/CD pipelines that run SonarCloud or Ruff analysis

## Project setup

Every Python project SHOULD have a `pyproject.toml` with at minimum:

```toml
[project]
name = "my-project"
requires-python = ">=3.10"

[tool.ruff]
target-version = "py310"
line-length = 120

[tool.ruff.lint]
select = [
    "E",    # pycodestyle errors
    "W",    # pycodestyle warnings
    "F",    # pyflakes
    "I",    # isort
    "N",    # pep8-naming
    "UP",   # pyupgrade
    "S",    # flake8-bandit (security)
    "B",    # flake8-bugbear
    "A",    # flake8-builtins
    "C4",   # flake8-comprehensions
    "DTZ",  # flake8-datetimez
    "T20",  # flake8-print
    "SIM",  # flake8-simplify
    "TCH",  # flake8-type-checking
    "ARG",  # flake8-unused-arguments
    "PTH",  # flake8-use-pathlib
    "ERA",  # eradicate (commented-out code)
    "RUF",  # Ruff-specific rules
]

[tool.ruff.format]
quote-style = "double"

[tool.mypy]
python_version = "3.10"
strict = true
warn_return_any = true
warn_unused_configs = true
```

- Always use type hints on function signatures.
- Include a module-level docstring only when the file's purpose isn't obvious from its name and package.
- Use `from __future__ import annotations` for forward references if supporting Python <3.12.

## SonarCloud SonarPython rules - Security

### S2068 - Do not hardcode credentials (BLOCKER)
Never embed passwords, tokens, API keys, or secrets in source code. Use environment variables or secret managers.
```python
# BAD
password = "admin123"
api_key = "sk-abc123..."
connection_string = "postgresql://user:pass@host/db"

# GOOD
import os
password = os.environ["DB_PASSWORD"]
api_key = os.environ["API_KEY"]
```
Ruff equivalent: S105, S106, S107 (hardcoded password in string/function arg/default)

### S4423 - Do not use weak SSL/TLS protocols (CRITICAL)
Never use SSLv2, SSLv3, TLSv1, or TLSv1.1. Always enforce TLSv1.2 or higher.
```python
# BAD
import ssl
context = ssl.SSLContext(ssl.PROTOCOL_TLSv1)
context = ssl.SSLContext(ssl.PROTOCOL_SSLv3)

# GOOD
import ssl
context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
context.minimum_version = ssl.TLSVersion.TLSv1_2
```
Ruff equivalent: S502, S503, S504

### S5527 - Always verify server certificates (CRITICAL)
Never disable SSL certificate verification.
```python
# BAD
import requests
requests.get("https://example.com", verify=False)

import ssl
context = ssl.create_default_context()
context.check_hostname = False
context.verify_mode = ssl.CERT_NONE

import urllib3
urllib3.disable_warnings()

# GOOD
requests.get("https://example.com")  # verify=True is default
context = ssl.create_default_context()  # verification enabled by default
```
Ruff equivalent: S501

### S5131 - Sanitize user input to prevent injection (BLOCKER)
Never pass unsanitized user input to SQL queries, OS commands, file paths, or template engines.
```python
# BAD - SQL injection
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
cursor.execute("SELECT * FROM users WHERE id = " + user_id)

# GOOD - parameterized queries
cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))

# BAD - command injection
import os
os.system(f"ls {user_input}")
import subprocess
subprocess.run(user_input, shell=True)

# GOOD - use list form, no shell
import subprocess
subprocess.run(["ls", user_input], check=True)
```
Ruff equivalent: S602 (subprocess with shell=True), S603, S604, S605, S606, S607

### S4790 - Avoid weak hashing algorithms (CRITICAL)
Do not use MD5 or SHA1 for security purposes. Use SHA-256 or stronger.
```python
# BAD
import hashlib
hashlib.md5(data)
hashlib.sha1(data)

# GOOD
import hashlib
hashlib.sha256(data)
hashlib.sha3_256(data)
```
Ruff equivalent: S303, S304

### S5332 - Do not use clear-text protocols (CRITICAL)
Avoid HTTP, FTP, Telnet. Always prefer HTTPS, SFTP, SSH.
```python
# BAD
url = "http://example.com/api"
ftp_url = "ftp://files.example.com"

# GOOD
url = "https://example.com/api"
sftp_url = "sftp://files.example.com"
```

### S2245 - Do not use standard pseudo-random generators for security (CRITICAL)
The `random` module is not cryptographically secure. Use `secrets` for security-sensitive randomness.
```python
# BAD - for tokens, passwords, session IDs
import random
token = random.randint(0, 999999)
session_id = "".join(random.choices("abcdef0123456789", k=32))

# GOOD
import secrets
token = secrets.token_hex(16)
session_id = secrets.token_urlsafe(32)
```
Ruff equivalent: S311

### S5542 - Do not use weak encryption algorithms (CRITICAL)
Avoid DES, 3DES, Blowfish, RC2, RC4. Use AES-256 or ChaCha20.
```python
# BAD
from Crypto.Cipher import DES, Blowfish

# GOOD
from Crypto.Cipher import AES
cipher = AES.new(key, AES.MODE_GCM)
```

### S5659 - Always verify JWT signatures (CRITICAL)
Never decode JWTs without verifying the signature.
```python
# BAD
import jwt
data = jwt.decode(token, options={"verify_signature": False})

# GOOD
data = jwt.decode(token, key=public_key, algorithms=["RS256"])
```

### S2077 - Use parameterized queries, not string formatting (BLOCKER)
Formatting SQL strings is the root cause of SQL injection.
```python
# BAD
query = f"SELECT * FROM users WHERE name = '{name}'"
query = "SELECT * FROM users WHERE name = '%s'" % name
query = "SELECT * FROM users WHERE name = '" + name + "'"

# GOOD - parameterized
cursor.execute("SELECT * FROM users WHERE name = %s", (name,))
# GOOD - ORM
User.objects.filter(name=name)
```

### S4507 - Do not enable debug features in production (MAJOR)
Disable debug mode and development servers in production deployments.
```python
# BAD
app.run(debug=True)
DEBUG = True

# GOOD
import os
debug_mode = os.environ.get("DEBUG", "false").lower() == "true"
app.run(debug=debug_mode)
```

### S5443 - Do not use world-writable temp directories insecurely (MAJOR)
Use `tempfile` module instead of hardcoding `/tmp` paths.
```python
# BAD
with open("/tmp/myapp_data.txt", "w") as f:
    f.write(data)

# GOOD
import tempfile
with tempfile.NamedTemporaryFile(mode="w", delete=False, prefix="myapp_") as f:
    f.write(data)
```
Ruff equivalent: S108

### S6781 - Do not use insecure deserialization (BLOCKER)
Never unpickle or load YAML from untrusted sources.
```python
# BAD
import pickle
data = pickle.loads(untrusted_data)

import yaml
data = yaml.load(untrusted_data)  # uses unsafe Loader

# GOOD
import json
data = json.loads(untrusted_data)

import yaml
data = yaml.safe_load(untrusted_data)
```
Ruff equivalent: S301 (pickle), S506 (unsafe yaml)

## SonarCloud SonarPython rules - Reliability

### S5754 - Do not use bare except clauses (MAJOR)
Bare `except:` catches everything including `SystemExit` and `KeyboardInterrupt`. Always specify the exception type.
```python
# BAD
try:
    process()
except:
    log("failed")

# BAD - too broad
try:
    process()
except Exception:
    pass

# GOOD
try:
    process()
except ValueError as e:
    log(f"Invalid value: {e}")
except (IOError, OSError) as e:
    log(f"IO error: {e}")
```
Ruff equivalent: E722 (bare except), B001

### S1763 - All code paths should be reachable (MAJOR)
Do not place code after `return`, `raise`, `break`, or `continue`.
```python
# BAD
def process():
    return result
    cleanup()  # unreachable

# GOOD
def process():
    cleanup()
    return result
```
Ruff equivalent: F811 (redefined unused), RUF100

### S1854 - Remove dead stores (MAJOR)
Do not assign values to variables that are never read.
```python
# BAD
def calculate():
    result = compute()  # assigned but overwritten before use
    result = compute_again()
    return result

# GOOD
def calculate():
    result = compute_again()
    return result
```
Ruff equivalent: F841 (local variable assigned but never used)

### S2201 - Do not ignore return values of functions without side effects (MAJOR)
Pure functions like `sorted()`, `str.strip()`, `str.upper()` return new values. Ignoring them is a bug.
```python
# BAD
my_list.sort()  # this is fine, sort() is in-place
sorted(my_list)  # BAD - result discarded
my_string.strip()  # BAD - result discarded

# GOOD
clean_list = sorted(my_list)
clean_string = my_string.strip()
```

### S5547 - Do not use weak cipher algorithms or modes (CRITICAL)
Avoid ECB mode and deprecated ciphers.
```python
# BAD
from Crypto.Cipher import AES
cipher = AES.new(key, AES.MODE_ECB)

# GOOD
cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
```

### S1144 - Remove unused private methods and functions (MAJOR)
Functions prefixed with `_` that are never called should be removed.

### S1186 - Do not leave functions empty (MAJOR)
Empty functions (with only `pass`) should at minimum have a brief docstring or a TODO explaining why.
```python
# BAD
def process_event(event):
    pass

# GOOD - if intentionally empty
def process_event(event):
    """No-op; events logged by middleware."""
```

### S5722 - Do not raise or catch StopIteration inside generators (MAJOR)
In Python 3.7+, `StopIteration` inside a generator causes `RuntimeError`.
```python
# BAD
def my_gen():
    it = iter(some_list)
    while True:
        yield next(it)  # raises StopIteration, causes RuntimeError

# GOOD
def my_gen():
    yield from some_list
```

### S5727 - Do not use `not ... is` or `not ... is not` (MAJOR)
Use `is not` instead of `not ... is`.
```python
# BAD
if not x is None:
    ...

# GOOD
if x is not None:
    ...
```
Ruff equivalent: E714, SIM201

### S5632 - Do not redefine built-in names (MAJOR)
Never shadow built-in functions like `list`, `dict`, `type`, `id`, `input`, `print`, `open`, `str`, `int`, `map`, `filter`, `format`, `set`, `range`.
```python
# BAD
list = [1, 2, 3]
id = get_user_id()
type = "admin"

# GOOD
items = [1, 2, 3]
user_id = get_user_id()
user_type = "admin"
```
Ruff equivalent: A001, A002, A003

### S3516 - Functions should not always return the same value (MAJOR)
If every code path returns the same literal, the return value is meaningless.
```python
# BAD
def validate(data):
    if not data:
        return True
    if len(data) > 100:
        return True
    return True

# GOOD
def validate(data):
    if not data:
        return False
    if len(data) > 100:
        return False
    return True
```

## SonarCloud SonarPython rules - Maintainability

### S100 - Function and method names should follow naming conventions (MINOR)
Use `snake_case` for functions and methods. Use `PascalCase` for classes.
```python
# BAD
def ProcessData():
    ...
def getData():
    ...

# GOOD
def process_data():
    ...
def get_data():
    ...
```
Ruff equivalent: N801 (class), N802 (function), N803 (argument), N806 (variable)

### S107 - Functions should not have too many parameters (MAJOR)
Limit functions to 7 parameters maximum. Use dataclasses, TypedDict, or config objects to group related parameters.
```python
# BAD
def create_user(name, email, age, address, phone, role, department, manager):
    ...

# GOOD
@dataclass
class UserConfig:
    name: str
    email: str
    age: int
    address: str
    phone: str
    role: str
    department: str
    manager: str

def create_user(config: UserConfig):
    ...
```

### S138 - Functions should not be too long (MAJOR)
Functions should not exceed ~50 lines. Break large functions into smaller, focused helper functions.

### S1481 - Remove unused local variables (MINOR)
Do not declare variables that are never read. Clean up dead code.
```python
# BAD
def process():
    unused_var = compute()  # never used
    return other_compute()

# GOOD
def process():
    return other_compute()
```
Ruff equivalent: F841

### S1135 - Track TODO/FIXME comments (INFO)
`TODO` and `FIXME` comments should include a ticket reference. Do not leave unresolved TODOs in production code.
```python
# BAD
# TODO: fix this later

# GOOD
# TODO(PROJ-1234): refactor to use async client
```
Ruff equivalent: FIX001, FIX002, FIX003, FIX004

### S125 - Remove commented-out code (MAJOR)
Commented-out code is dead code. Remove it; version control preserves history.
```python
# BAD
# def old_process():
#     return legacy_compute()

# GOOD - just delete it
```
Ruff equivalent: ERA001

### S1066 - Collapse mergeable if statements (MAJOR)
```python
# BAD
if condition_a:
    if condition_b:
        process()

# GOOD
if condition_a and condition_b:
    process()
```
Ruff equivalent: SIM102

### S3776 - Reduce cognitive complexity (CRITICAL)
Deeply nested and branching code is hard to understand. Refactor functions with high cognitive complexity (threshold: 15).
- Extract helper functions
- Use early returns (guard clauses)
- Replace complex conditions with named booleans
```python
# BAD - deeply nested
def process(data):
    if data:
        for item in data:
            if item.is_valid():
                if item.type == "A":
                    for sub in item.children:
                        if sub.active:
                            handle(sub)

# GOOD - flat with early returns and helpers
def process(data):
    if not data:
        return
    for item in data:
        if item.is_valid():
            process_item(item)

def process_item(item):
    if item.type != "A":
        return
    active_children = [sub for sub in item.children if sub.active]
    for sub in active_children:
        handle(sub)
```
Ruff equivalent: C901

### S1192 - Do not duplicate string literals (MINOR)
If the same string appears 3+ times, assign it to a constant.
```python
# BAD
log("Processing stage: compilation")
notify("Processing stage: compilation")
record("Processing stage: compilation")

# GOOD
STAGE_COMPILATION = "Processing stage: compilation"
log(STAGE_COMPILATION)
notify(STAGE_COMPILATION)
record(STAGE_COMPILATION)
```

### S131 - switch/match statements should have a default case (CRITICAL)
Python 3.10+ `match` statements must include a wildcard `case _:`.
```python
# BAD
match action:
    case "start":
        do_start()
    case "stop":
        do_stop()

# GOOD
match action:
    case "start":
        do_start()
    case "stop":
        do_stop()
    case _:
        raise ValueError(f"Unknown action: {action}")
```

## Ruff-specific rules (beyond SonarCloud)

### UP - pyupgrade: Use modern Python syntax
```python
# BAD (UP006) - use builtin generics in 3.9+
from typing import List, Dict, Tuple, Optional
def process(items: List[str]) -> Dict[str, int]:
    ...

# GOOD
def process(items: list[str]) -> dict[str, int]:
    ...

# BAD (UP007) - use X | Y union syntax in 3.10+
from typing import Union, Optional
def get(key: str) -> Optional[str]:
    ...
def process(value: Union[str, int]) -> None:
    ...

# GOOD
def get(key: str) -> str | None:
    ...
def process(value: str | int) -> None:
    ...

# BAD (UP032) - use f-strings
msg = "Hello {}".format(name)
msg = "Hello %s" % name

# GOOD
msg = f"Hello {name}"
```

### I - isort: Import ordering
Imports must be sorted in the following order, separated by blank lines:
1. Standard library (`os`, `sys`, `pathlib`)
2. Third-party (`requests`, `flask`, `pydantic`)
3. Local/project (`myapp.models`, `.utils`)

```python
# BAD
import requests
import os
from myapp import models
import sys

# GOOD
import os
import sys

import requests

from myapp import models
```
Ruff equivalent: I001 (unsorted imports), I002 (missing required import)

### B - flake8-bugbear: Common Python bugs
```python
# BAD (B006) - mutable default argument
def append_to(item, target=[]):
    target.append(item)
    return target

# GOOD
def append_to(item, target=None):
    if target is None:
        target = []
    target.append(item)
    return target

# BAD (B007) - unused loop variable
for i in range(10):
    print("hello")

# GOOD
for _ in range(10):
    print("hello")

# BAD (B904) - raise without from in except
try:
    process()
except ValueError:
    raise RuntimeError("failed")

# GOOD
try:
    process()
except ValueError as e:
    raise RuntimeError("failed") from e

# BAD (B017) - assertRaises with no specific exception
with self.assertRaises(Exception):
    do_something()

# GOOD
with self.assertRaises(ValueError):
    do_something()
```

### C4 - flake8-comprehensions: Simplify comprehensions
```python
# BAD (C400) - unnecessary generator in list()
list(x for x in items)

# GOOD
[x for x in items]

# BAD (C401) - unnecessary generator in set()
set(x for x in items)

# GOOD
{x for x in items}

# BAD (C408) - unnecessary dict/list/tuple call
dict()
list()

# GOOD
{}
[]
```

### SIM - flake8-simplify: Simplify code
```python
# BAD (SIM108) - use ternary
if condition:
    x = a
else:
    x = b

# GOOD
x = a if condition else b

# BAD (SIM110) - use any()
for item in items:
    if item.is_valid():
        return True
return False

# GOOD
return any(item.is_valid() for item in items)

# BAD (SIM115) - use context manager for open
f = open("file.txt")
data = f.read()
f.close()

# GOOD
with open("file.txt") as f:
    data = f.read()

# BAD (SIM118) - use `in` for dict keys
if key in dict.keys():
    ...

# GOOD
if key in dict:
    ...
```

### PTH - flake8-use-pathlib: Prefer pathlib over os.path
```python
# BAD
import os
path = os.path.join("dir", "file.txt")
exists = os.path.exists(path)
with open(os.path.join(base, "config.json")) as f:
    ...

# GOOD
from pathlib import Path
path = Path("dir") / "file.txt"
exists = path.exists()
with (Path(base) / "config.json").open() as f:
    ...
```

### DTZ - flake8-datetimez: Timezone-aware datetimes
```python
# BAD (DTZ001, DTZ005) - naive datetimes
from datetime import datetime
now = datetime.now()
today = datetime.today()
ts = datetime.utcnow()

# GOOD
from datetime import datetime, timezone
now = datetime.now(tz=timezone.utc)
ts = datetime.now(tz=timezone.utc)
```

### ARG - flake8-unused-arguments: Flag unused function arguments
```python
# BAD (ARG001)
def process(data, logger):  # logger never used
    return transform(data)

# GOOD - use it or prefix with underscore
def process(data, _logger):
    return transform(data)
```

### T20 - flake8-print: No print statements in production
```python
# BAD
print("Debug:", value)

# GOOD
import logging
logger = logging.getLogger(__name__)
logger.debug("Debug: %s", value)
```
Ruff equivalent: T201 (print found), T203 (pprint found)

### RUF - Ruff-specific rules
```python
# BAD (RUF005) - use [*a, *b] instead of concatenation
combined = list_a + list_b  # fine for clarity, but for unpacking:
combined = [*list_a, *list_b]  # preferred when constructing new list

# BAD (RUF010) - use explicit conversion flag
f"{str(value)}"

# GOOD
f"{value!s}"

# BAD (RUF013) - implicit Optional
def get(key: str, default: str = None):  # default is None but type says str
    ...

# GOOD
def get(key: str, default: str | None = None):
    ...
```

## Type safety

### Type hints are required on all public function signatures
```python
# BAD
def process(data, count):
    ...

# GOOD
def process(data: list[dict[str, Any]], count: int) -> list[str]:
    ...
```

### Use `typing` appropriately
```python
from typing import Any, TypeVar, Protocol, TypeAlias
from collections.abc import Sequence, Mapping, Callable, Iterator, Generator

# Type aliases for complex types
UserDict: TypeAlias = dict[str, Any]
Handler: TypeAlias = Callable[[str], bool]
```

### Prefer `collections.abc` over `typing` for abstract types (Python 3.9+)
```python
# BAD
from typing import Sequence, Mapping, Iterable

# GOOD
from collections.abc import Sequence, Mapping, Iterable
```

## Exception handling best practices

### Always use specific exception types
```python
# BAD
raise Exception("something went wrong")

# GOOD
raise ValueError("invalid input: expected positive integer")
raise RuntimeError("connection pool exhausted")
```

### Chain exceptions with `from`
```python
try:
    value = int(raw)
except ValueError as e:
    raise ValidationError(f"Invalid integer: {raw}") from e
```

### Define custom exceptions for your domain
```python
class AppError(Exception):
    """Base exception for the application."""

class NotFoundError(AppError):
    """Raised when a requested resource is not found."""

class ValidationError(AppError):
    """Raised when input validation fails."""
```

## Ruff and tooling integration

### Ruff (primary linter and formatter)
Ruff replaces flake8, isort, pyupgrade, bandit, and more in a single fast tool.

1. **Install**: `pip install ruff`
2. **Lint**: `ruff check .`
3. **Auto-fix**: `ruff check --fix .`
4. **Format**: `ruff format .`
5. **Check format**: `ruff format --check .`

### mypy (type checker)
1. **Install**: `pip install mypy`
2. **Run**: `mypy .` or `mypy src/`
3. **Config** in `pyproject.toml`:
   ```toml
   [tool.mypy]
   python_version = "3.10"
   strict = true
   ```

### bandit (security scanner, optional if using Ruff S rules)
1. **Install**: `pip install bandit`
2. **Run**: `bandit -r src/`

### Pre-commit configuration (recommended)
```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.8.0
    hooks:
      - id: ruff
        args: [--fix]
      - id: ruff-format
  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.13.0
    hooks:
      - id: mypy
        additional_dependencies: []
```

## Checklist for new Python files

When writing a new Python file, verify:

- [ ] Module-level docstring when purpose isn't obvious from name
- [ ] `from __future__ import annotations` if needed for forward refs (<3.12)
- [ ] Imports sorted: stdlib, third-party, local (separated by blank lines)
- [ ] No unused imports
- [ ] All public functions and methods have type hints
- [ ] Public functions document inputs, outputs, side effects only (max 3 lines)
- [ ] Functions use `snake_case`, classes use `PascalCase`
- [ ] Constants use `UPPER_SNAKE_CASE`
- [ ] No mutable default arguments (lists, dicts, sets)
- [ ] No bare `except:` clauses; specific exception types used
- [ ] Exceptions chained with `from` when re-raising
- [ ] `match` statements have `case _:` default
- [ ] No hardcoded credentials or secrets
- [ ] No `print()` statements (use `logging`)
- [ ] No commented-out code
- [ ] Parameterized queries for all SQL (no f-strings/format)
- [ ] `subprocess` calls use list form, no `shell=True`
- [ ] `pathlib.Path` used instead of `os.path`
- [ ] Timezone-aware datetimes (`datetime.now(tz=timezone.utc)`)
- [ ] Context managers (`with`) for file operations
- [ ] No shadowing of built-in names
- [ ] No unused variables or dead stores
- [ ] Functions are not too long (<50 lines)
- [ ] Cognitive complexity is low (<15)
- [ ] `ruff check` passes cleanly
- [ ] `ruff format --check` passes cleanly
- [ ] `mypy` passes cleanly (if configured)

## Checklist for code review

When reviewing Python code, additionally check:

- [ ] No SQL injection vectors (S2077, S5131)
- [ ] No command injection vectors (S5131, Ruff S602-S607)
- [ ] No insecure deserialization (S6781, Ruff S301/S506)
- [ ] SSL/TLS verification not disabled (S5527, Ruff S501)
- [ ] Strong hashing algorithms used for security (S4790)
- [ ] Cryptographically secure random for tokens (S2245)
- [ ] JWT signatures verified (S5659)
- [ ] Debug mode disabled in production (S4507)
- [ ] Temp files use `tempfile` module (S5443)
- [ ] No duplicate string literals (extract to constants)
- [ ] Return values of pure functions not discarded (S2201)
- [ ] All code paths are reachable (S1763)
