---
description: Critically review the current plan for feasibility and risks
argument-hint: ""
---

Review the plan proposed in this conversation. Do NOT look at git diff. Instead, analyze the plan itself for:

1. **Regression risk** - Could any proposed change break existing behavior? Are existing tests likely to need modification? Flag this.
2. **Scope creep** - Does the plan go beyond what was requested?
3. **Missing steps** - Are there gaps? Missing tests, docs, error handling?
4. **Feasibility** - Are there technical blockers or assumptions that could fail?
5. **Side effects** - Will the proposed changes affect unrelated parts of the codebase?

Return a **PASS** or **FAIL** verdict with detailed findings.
