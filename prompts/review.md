---
description: Run a critical review of all uncommitted changes
argument-hint: ""
---

Review all uncommitted changes in this project. Run `git diff` and `git diff --cached` to see all changes.

Check for:
1. **Regressions** - Could any change break existing behavior?
2. **Scope creep** - Do the changes go beyond what was requested?
3. **Side effects** - Will changes affect unrelated parts of the codebase?
4. **Test coverage** - Are new code paths tested? Are existing tests still valid?
5. **Security** - Any hardcoded secrets, injection vectors, or insecure patterns?
6. **Error handling** - Are errors properly handled and propagated?

Return a **PASS** or **FAIL** verdict with detailed findings for each category.
