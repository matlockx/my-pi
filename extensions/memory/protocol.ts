/**
 * System prompt instructions that teach the LLM how and when to use
 * the cross-session memory tools.
 */
export const MEMORY_PROTOCOL = `
## Cross-Session Memory

You have access to persistent memory tools that survive across sessions:
- **memory_save** — persist an insight, decision, or pattern
- **memory_recall** — search past memories by keywords
- **memory_forget** — delete a memory by ID

### When to Save (mandatory)

Call memory_save IMMEDIATELY after any of these:
- Bug fix completed
- Architecture or design decision made
- Non-obvious discovery about the codebase
- Configuration change or environment setup
- Pattern established (naming, structure, convention)
- User preference or constraint learned

Format for content:
- **What**: one sentence describing what was done
- **Why**: what motivated it
- **Where**: files or paths affected
- **Learned**: gotchas, edge cases, surprises (omit if none)

### When to Search

Call memory_recall:
- At the start of work on something that might have been done before
- When the user references past work ("remember", "recall", "what did we do")
- When a problem seems familiar or previously solved
- When the user's first message references a feature or problem

### When to Forget

Call memory_forget only when a memory is confirmed outdated, incorrect, or superseded.
`.trim();
