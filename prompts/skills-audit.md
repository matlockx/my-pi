---
description: Audit the skills in my-pi/skills for redundancy, outdated or weak content, and lack of use; propose delete, merge or rewrite
argument-hint: "[skill names to focus on]"
---

Audit the skills in my-pi/skills. Focus: $ARGUMENTS (all skills when empty).

1. Call `skill_audit_data` once. It returns per skill: description, word count, last commit date, link source state (`current`, `behind`, `gone`, `excluded`, local edits), and usage from the omp and pi session logs, plus `similarDescriptions` (word overlap of descriptions; a hint, not a verdict).
2. Read every skill in scope in full via `skill://<name>`. For a skill that lists other files it relies on, read those too.
3. Judge each skill on these points, with evidence (a quoted line, a file, a count):
   - **Unused**: zero sessions, or none in the last 90 days. Usage counts only sessions on this Mac whose agent read or invoked the skill; a rule duplicated in AGENTS.md is applied without reading the skill, so check AGENTS.md before calling it dead.
   - **Redundant**: another skill, AGENTS.md (`~/.omp/agent/AGENTS.md`), a prompt in my-pi/prompts, or an extension already says the same. Name the overlapping skill or file and the sections.
   - **Outdated**: refers to tools, commands, flags, files, settings or harnesses that no longer exist or changed (pi vs omp, removed extensions, renamed skills, policies AGENTS.md has replaced). Check each claim against the repo or the installed tool before reporting it. A `behind` or `gone` link source counts here too.
   - **Weak**: vague advice the model follows anyway, contradictions with AGENTS.md, a description that would not trigger the skill when it is needed, or size out of proportion to its value.
4. Report one table: skill, verdict (keep, rewrite, merge into <skill>, archive, delete), reason with evidence. Archive moves the directory to my-pi/skills-archive, which is not loaded but keeps the skill restorable; prefer it to delete for own skills that may come back. Then, per non-keep verdict, one short paragraph with the concrete change, including references to the skill in other skills, prompts or AGENTS.md that must change with it. Skills with no finding appear as keep with a one-line reason.
5. Change nothing yet. End by asking which proposals to apply. On the user's answer: delete with `skill_remove` (it shows its own confirmation dialog, so do not ask again), archive with `git mv skills/<name> skills-archive/<name>`, edit files for rewrites, merges and references, and leave the commit to the user.
