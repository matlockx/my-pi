---
name: github-actions
description: Write and review GitHub Actions workflows following security hardening, least-privilege permissions, and CI/CD best practices
---

## What I do

Guide writing and reviewing GitHub Actions workflows that resist supply-chain and injection
attacks, run with least-privilege tokens, and stay reliable and readable.

Use when writing or reviewing `.github/workflows/*.yml`, composite actions (`action.yml`) or
reusable workflows, fixing CI failures, or setting up deployments.

In the examples, `<sha>` stands for a full 40-character commit SHA and `# vX.Y.Z` for the release
it belongs to. Never copy a SHA from an example; resolve it when writing the workflow (see
"Pin actions by full commit SHA").

---

## Security

### Pin actions by full commit SHA — never tags or branches (BLOCKER)

Tags and branches are mutable; a compromised action repository can move them to malicious code.

```yaml
# BAD
- uses: actions/checkout@v5
- uses: actions/checkout@main

# GOOD
- uses: actions/checkout@<sha> # vX.Y.Z
```

Resolving the SHA, in order of preference:

1. `pinact run` — rewrites every `uses:` in the repository to a SHA plus version comment.
2. GitHub MCP `get_latest_release` for the action's repository, then `get_tag` for that tag; use
   the commit SHA the tag points to.
3. `git ls-remote --tags https://github.com/<owner>/<repo> 'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}'`
   — for an annotated tag, take the `^{}` line (the commit), not the tag object.

Keep pins current with Dependabot (`package-ecosystem: github-actions`) or `pinact run --update`.

### Do not persist the checkout token (CRITICAL)

`actions/checkout` writes `GITHUB_TOKEN` into `.git/config` by default, where every later step,
action and uploaded artifact of the workspace can read it.

```yaml
- name: Checkout
  uses: actions/checkout@<sha> # vX.Y.Z
  with:
    persist-credentials: false
```

Only a job that pushes with that token keeps the default, and says so in a comment.

### Expression injection prevention (BLOCKER)

Context values such as `github.event.issue.title`, `github.event.pull_request.body`,
`github.head_ref`, and anything ending in `body`, `title`, `message`, `name`, `email`, `label`,
`ref`, `default_branch` or `page_name` are attacker-controlled. Never interpolate them into `run:`.

```yaml
# BAD — the PR title is executed as shell
- name: Print PR title
  run: echo "PR title: ${{ github.event.pull_request.title }}"

# GOOD — pass through the environment; the shell quotes it
- name: Print PR title
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "PR title: ${PR_TITLE}"
```

The same applies to `with:` inputs of `actions/github-script` (`script:`) and to any other field
that is evaluated as code.

### Least-privilege GITHUB_TOKEN permissions (CRITICAL)

Declare `permissions:` explicitly. Deny everything at workflow level and grant per job when jobs
need different rights.

```yaml
name: Release
on:
  push:
    tags: ["v*"]
permissions: {}
jobs:
  build:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@<sha> # vX.Y.Z
        with:
          persist-credentials: false
  publish:
    needs: build
    permissions:
      contents: write
      packages: write
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Publish release
        run: ./scripts/publish.sh
```

### pull_request_target dangers (BLOCKER)

`pull_request_target` runs with the base repository's write token and secrets. Checking out and
running the PR head there lets a fork PR run arbitrary code with those rights.

```yaml
# BAD — runs the fork's code with secrets
on: pull_request_target
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # vX.Y.Z
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: npm install && npm test
```

Use `pull_request_target` only for labelling and commenting, without checking out PR code. To
build fork code with privileges, split it: `pull_request` builds and uploads an artifact without
secrets, and a `workflow_run` workflow consumes the artifact as data, never as code.

### OIDC for cloud provider authentication (CRITICAL)

Use OpenID Connect instead of long-lived cloud credentials in secrets.

```yaml
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: production
    steps:
      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@<sha> # vX.Y.Z
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions
          aws-region: eu-central-1
```

Restrict the cloud role's trust policy to the repository, branch or environment (`sub` claim).

### Self-hosted runner risks (CRITICAL)

Never use self-hosted runners for public repositories: any PR can run code on them. For private
repositories use ephemeral runners, runner groups restricted to named repositories, no
credentials on the host, and approval for first-time contributors.

### Secret handling (BLOCKER)

Secrets never appear in step names, command-line arguments, or environment dumps. Pass them
through `env:` and hand them to the tool through stdin, a file or its own environment variable.
`${{ secrets.X }}` inside `run:` puts the value into the generated script.

```yaml
# BAD — in the step name (shown in the UI)
- name: Deploy with key ${{ secrets.API_KEY }}
  run: deploy

# BAD — interpolated into the script, and on curl's command line (process list)
- run: curl -H "Authorization: Bearer ${{ secrets.TOKEN }}" https://api.example.com

# BAD — still on the command line after expansion
- env:
    TOKEN: ${{ secrets.TOKEN }}
  run: curl -H "Authorization: Bearer ${TOKEN}" https://api.example.com

# BAD — dumps every variable
- run: env

# GOOD — header read from stdin, never in argv
- name: Call API
  env:
    TOKEN: ${{ secrets.TOKEN }}
  run: printf 'Authorization: Bearer %s\n' "${TOKEN}" | curl --fail -sS -H @- https://api.example.com

# GOOD — the tool reads its own variable
- name: Deploy
  env:
    API_KEY: ${{ secrets.API_KEY }}
  run: deploy --key-from-env
```

Mask derived values with `echo "::add-mask::${VALUE}"` before anything can print them.

### Pin container images by digest (MAJOR)

`container:` and `services:` images use `image:tag@sha256:<digest>`; resolve the digest when
writing (`docker buildx imagetools inspect <image>:<tag>`).

### Verify downloads before executing them (BLOCKER)

```yaml
# BAD
- run: curl -sSL https://example.com/install.sh | bash

# GOOD
- name: Install tool
  run: |
    curl -sSLo install.sh https://example.com/install.sh
    echo "<expected-sha256>  install.sh" | sha256sum -c -
    bash install.sh
```

### Restrict triggers for sensitive operations (MAJOR)

Deploy and release workflows trigger on protected branches or tags only and run in an
`environment:` with protection rules.

```yaml
on:
  push:
    branches: [main]
    tags: ["v*"]
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: production
    steps:
      - name: Deploy
        run: ./scripts/deploy.sh
```

---

## Reliability

### Always set timeout-minutes (MAJOR)

Jobs default to 6 hours. Set `timeout-minutes` on every job, and on long steps.

### Use if: always() / failure() for cleanup and notification (MAJOR)

```yaml
- name: Upload test report
  if: always()
  uses: actions/upload-artifact@<sha> # vX.Y.Z
  with:
    name: test-report
    path: reports/

- name: Notify on failure
  if: failure()
  env:
    SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}
  run: |
    printf 'url = "%s"\n' "${SLACK_WEBHOOK}" |
      curl --fail -sS -K - -H 'Content-Type: application/json' -d '{"text":"Build failed"}'
```

(`-K -` reads the URL from stdin, so the webhook secret stays out of the command line.)

### Use hashFiles() for cache keys (MAJOR)

```yaml
- uses: actions/cache@<sha> # vX.Y.Z
  with:
    path: ~/.npm
    key: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
    restore-keys: |
      npm-${{ runner.os }}-
```

Prefer the built-in caching of setup actions (`actions/setup-node` `cache: npm`,
`actions/setup-go` `cache: true`, `astral-sh/setup-uv` `enable-cache: true`) over hand-rolled keys.

### Matrix strategy (MAJOR)

```yaml
strategy:
  fail-fast: false
  matrix:
    node-version: [22, 24]  # release lines in support; check nodejs.org/en/about/previous-releases
    os: [ubuntu-latest, macos-latest]
```

Matrix versions are the supported release lines of the runtime at the time of writing, not
end-of-life ones. `fail-fast: false` when every combination's result is wanted; the default for
fast feedback.

### Quote expressions; use continue-on-error sparingly (MAJOR)

`if: github.ref == 'refs/heads/main'` (quoted string). `continue-on-error: true` only for
explicitly optional steps, never to hide flaky tests.

---

## Maintainability

- **Name every step** (`name:`); unnamed steps show as "Run <command>". (MAJOR)
- **Extract shared jobs** into reusable workflows (`on: workflow_call`) or composite actions, and
  scripts longer than about 10 lines into files under `scripts/`. (MAJOR)
- **Shared values in `env:`** at workflow or job level. (MINOR)
- **Concurrency groups**: `cancel-in-progress: true` for CI on branches; `false` for deployments,
  which queue instead. (MINOR)
  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  ```
- **No deprecated commands**: write `name=value` to `"${GITHUB_OUTPUT}"`, `"${GITHUB_ENV}"`,
  `"${GITHUB_STATE}"` instead of `::set-output`/`::save-state`. Multiline values use the
  `name<<EOF … EOF` form. (MAJOR)
- **Environments** for deployment gates: required reviewers, wait timers, branch restrictions and
  environment-scoped secrets, configured in the repository settings.

---

## Tooling

| Tool | Purpose | Install | Run |
| --- | --- | --- | --- |
| `actionlint` | Workflow syntax and shellcheck of `run:` | `brew install actionlint` | `actionlint` |
| `zizmor` | Security audit (injection, pinning, credentials, permissions) | `brew install zizmor` or `uvx zizmor` | `zizmor .github/workflows/` |
| `pinact` | Pin `uses:` to SHAs with version comments | `brew install pinact` | `pinact run` |

Dependabot keeps pins current:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    groups:
      actions:
        patterns: ["*"]
```

For pre-commit, use `rhysd/actionlint` with `rev:` set to the current release tag, looked up when
writing (`pre-commit autoupdate`), never copied from an example.

---

## Checklist for new workflows

**Security**
- [ ] Every `uses:` pinned to a full commit SHA with a `# vX.Y.Z` comment, resolved at write time
- [ ] `actions/checkout` has `persist-credentials: false` unless the job pushes
- [ ] `permissions:` explicit; least privilege per job
- [ ] No attacker-controlled `${{ }}` in `run:` or `script:`
- [ ] No `pull_request_target` that checks out or runs PR code
- [ ] OIDC for cloud access; no long-lived cloud keys in secrets
- [ ] Secrets only via `env:`, never in argv, step names or `${{ }}` inside `run:`
- [ ] Downloads verified; container images pinned by digest
- [ ] Self-hosted runners not used for public repositories
- [ ] Deployments in a protected `environment:`

**Reliability and maintainability**
- [ ] `timeout-minutes` on every job
- [ ] Cleanup and reports use `if: always()`
- [ ] Cache keys from `hashFiles()` or setup-action caching
- [ ] Matrix covers supported runtime versions only
- [ ] Steps named; long scripts in files; concurrency group set
- [ ] No deprecated commands
- [ ] `actionlint` and `zizmor` pass

## Checklist for review

- [ ] Mutable references (tags, branches, image tags without digest)
- [ ] Injection vectors in `run:` and `script:`
- [ ] Token scope: `permissions:`, `persist-credentials`, `pull_request_target`
- [ ] Secrets reaching argv, logs, artifacts or step metadata
- [ ] Triggers appropriate to what the workflow does
- [ ] `continue-on-error` hiding real failures
