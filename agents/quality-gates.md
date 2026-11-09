# Quality gates

The coverage gate (AGENTS.md G-15) and the duplication gate (G-18) in full. Read when a push is
blocked by the push gate, before running the gates, or when the user asks for them.

## When they run

Once before the work is pushed, not after every task: before `jflow_pr` creates or updates a PR,
before `jflow_review_resolve` pushes fixes, before any other push, and whenever the user asks. The
coverage gate reruns the whole test suite with coverage and dryer rescans the whole repo, which is
slow and CPU-heavy, and their findings only matter to what gets pushed.

The `push-gate` extension (my-pi `extensions/push-gate`) enforces this. It blocks the push until a
coverage command (crapper, or in a Sonar repo the coverage tool) and `dryer` have run through
bash in this session on exactly the content being pushed: tracked and untracked files, `.metrics/`
and `target/coverage/` excluded. Committing after the gate run does not invalidate it; editing a
file does. Gates run outside the session (another terminal, CI) are not seen. Repos with no source
file crapper or dryer scores are not gated. The user, never the agent, waives the gates for one
push with `/push-gate skip`; `/push-gate status` shows which gates are current.

At the gate run, fix what the gates report before pushing, as the sections below describe.

## New code coverage is at least 80 % (repos with a SonarQube gate)

Applies only when the repo has a SonarQube gate: a `sonar-project.properties` file, or a Sonar
step (`sonarqube-scan-action`, `sonarcloud-github-action`, `sonar-scanner`) in `.github/workflows`.
Without one, skip this section.

The gate fails a PR when coverage on new code is below **80 %**. Coverage on new code combines
line and branch (condition) coverage over every added or changed line, the test exemptions in
AGENTS.md "New code is tested by default"
included: an untested accessor or wiring file still counts against the gate.

- At the gate run, run the repo's coverage tool (`go test -coverprofile`,
  `pytest --cov`, `vitest --coverage`, …) and check the changed lines and branches, not the
  package total. Report the figure for the changed files.
- Below 80 % → add tests for the uncovered branches until the changed code reaches it. Error
  paths and `if err != nil` branches are the usual gap.
- Reach it with real assertions. Never add assertion-free tests, never extend
  `sonar.exclusions`/`sonar.coverage.exclusions`, and never move logic into excluded files to
  pass the gate. Generated code is the one exclusion that needs no approval.
- Not reachable without infrastructure the repo cannot run → say so with the measured figure,
  and ask the user before the PR is opened.

## Complexity-weighted coverage (CRAP), repos without a SonarQube gate

Every function added or changed on the branch scores **CRAP ≤ 10**, as computed by `crapper`
(from the ub-mode skill's tools): CRAP = complexity² × (1 − coverage)³ + complexity. A function
with complexity 1–2 passes without a test; a branching function needs tests in proportion to its
branches; complexity above 10 fails even when fully covered and has to be split.

- At the gate run, run `crapper --threshold 10 <files>` from the repo root, passing the files the
  branch added or modified (`git diff --name-only --diff-filter=AM origin/<base>...HEAD`, where
  `<base>` is the PR's base branch, usually `main`, plus any uncommitted ones). It runs the tests
  with coverage and scores every function in those files;
  non-source files are ignored. `--changed` reads `git status` only, so it scores nothing once
  the work is committed. `--use-existing-coverage` re-scores without rerunning the tests.
- The gate is the functions the branch added or changed. The exit code (2 when any scored
  function is over the threshold) also counts older functions in the same files, so read the
  report rather than the exit code. Report the worst score among the branch's functions, and list
  older ones over 10 without fixing them unasked.
- Over 10 → add tests for the uncovered branches, or split the function, until it passes. Real
  assertions only, as above. The exemptions in AGENTS.md "New code is tested by default" still apply when
  named (wiring such as an extension's registration function scores high at 0 % coverage).
- JavaScript/TypeScript: crapper runs `npm run coverage` when that script exists, else Vitest or
  `c8 npm test`. A `node:test` project needs a `coverage` script that writes LCOV to
  `target/coverage/typescript/lcov.info` (`node --test --experimental-test-coverage
  --test-reporter=lcov --test-reporter-destination=…`); my-pi's `package.json` has one.
- crapper writes `.metrics/` and `target/coverage/` into the repo; add them to `.gitignore` when
  they are not ignored yet, and never commit them.
- `crapper` not on PATH → say so and point to `/skill-install ub-mode`, which installs it.
- Languages crapper does not score (shell, SQL, YAML, Terraform) are exempt; say so.

## Duplication (dryer), every repo

New or changed code does not duplicate existing code: no `dryer` candidate at **similarity ≥ 0.8**
may have a side in code the branch added or changed. This applies on top of the coverage gate, with
or without SonarQube. dryer comes with the ub-mode skill's tools, like crapper.

- At the gate run, run `dryer --threshold 0.8` from the repo root. Never gate with
  `--changed`: it compares the changed files only with each other, so code copied from an
  untouched file passes unseen.
- dryer exits 0 whether or not it finds candidates, so read the report. A candidate counts when
  one of its two line ranges overlaps the branch's changes. Report each such pair, and list older
  pairs outside the change without fixing them unasked.
- Hit → extract the shared logic into one function and call it from both places, or reuse the
  existing one. Two forms that match in shape but not in meaning (mappers for unrelated records)
  stay apart; name the pair and the reason in the report.
- dryer skips test directories and test files (`*_test.go`, `*.spec.ts`, `test_*.py`, …), so
  tests are not gated.
- Languages: Clojure, Java, Go, TypeScript, Rust, Python. Plain JavaScript (`.js`, `.mjs`),
  shell, SQL, YAML and Terraform are exempt; say so.
- dryer writes `.metrics/dry.edn` into the repo; add `.metrics/` to `.gitignore` when it is not
  ignored yet (Sonar repos included), and never commit it.
- `dryer` not on PATH → say so and point to `/skill-install ub-mode`, which installs it.
