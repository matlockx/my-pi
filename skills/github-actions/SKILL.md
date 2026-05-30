---
name: github-actions
description: Write and review GitHub Actions workflows following security hardening, least-privilege permissions, and CI/CD best practices
---

## What I do

Guide writing and reviewing GitHub Actions workflows that follow security hardening best practices, prevent supply chain attacks, enforce least-privilege permissions, and implement reliable CI/CD patterns.

## When to use me

Use this skill when:
- Writing new GitHub Actions workflow files (`.github/workflows/*.yml`)
- Creating composite actions or reusable workflows (`action.yml`)
- Reviewing workflows for security vulnerabilities
- Fixing CI/CD pipeline issues
- Setting up deployment pipelines with environment protection

---

## Security

### Pin actions by full commit SHA — never use tags (BLOCKER)

Tags and branches are mutable. An attacker who compromises an action repository can move a tag to point to malicious code. Always pin to the full 40-character commit SHA.

```yaml
# BAD - tag can be moved to malicious commit
- uses: actions/checkout@v4
- uses: docker/build-push-action@v5

# BAD - branch is mutable
- uses: actions/checkout@main

# GOOD - pinned to immutable commit SHA
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
- uses: docker/build-push-action@471d1dc4e07e5cdedd4c2171150001c434f0b7a4 # v6.15.0
```

Add a comment with the version tag for readability. Use tools like `pinact` or Dependabot to keep SHA pins updated.

### Expression injection prevention (BLOCKER)

GitHub context values like `github.event.issue.title`, `github.event.pull_request.body`, `github.head_ref`, and others ending in `body`, `title`, `message`, `name`, `email`, `head_ref`, `label`, `ref`, `default_branch`, or `page_name` are attacker-controlled. Never interpolate them directly into `run:` blocks.

```yaml
# BAD - attacker can inject arbitrary commands via PR title
- name: Print PR info
  run: echo "PR title: ${{ github.event.pull_request.title }}"

# BAD - attacker can inject via issue body
- name: Process issue
  run: |
    echo "${{ github.event.issue.body }}" > issue.txt
    process_issue issue.txt

# GOOD - use environment variable (shell handles quoting)
- name: Print PR info
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "PR title: ${PR_TITLE}"

# GOOD - use environment variable for issue body
- name: Process issue
  env:
    ISSUE_BODY: ${{ github.event.issue.body }}
  run: |
    echo "${ISSUE_BODY}" > issue.txt
    process_issue issue.txt
```

### Least-privilege GITHUB_TOKEN permissions (CRITICAL)

Always declare explicit `permissions:` at the workflow level. Unspecified permissions default to `none` when permissions are explicitly set.

```yaml
# BAD - implicit broad permissions
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683

# GOOD - explicit minimal permissions
name: CI
on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
```

```yaml
# GOOD - job-level permissions for finer control
name: Release
on:
  push:
    tags: ["v*"]
permissions: {}  # deny all at workflow level
jobs:
  build:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  publish:
    needs: build
    permissions:
      contents: write
      packages: write
    runs-on: ubuntu-latest
    steps:
      - name: Publish release
        run: echo "publishing"
```

### pull_request_target dangers (BLOCKER)

`pull_request_target` runs in the context of the **base** branch with write permissions and access to secrets. If you checkout the PR head code, an attacker's fork PR can execute arbitrary code with elevated privileges.

```yaml
# BAD - checks out attacker-controlled PR code with write token
on: pull_request_target
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: npm install && npm test  # runs attacker's code with secrets

# GOOD - only use pull_request_target for labeling, commenting, etc.
# Never checkout or execute PR head code
on: pull_request_target
jobs:
  label:
    permissions:
      pull-requests: write
    runs-on: ubuntu-latest
    steps:
      - name: Add label
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        with:
          script: |
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              labels: ['needs-review']
            });
```

If you must build PR code in `pull_request_target`, use a two-workflow pattern: one workflow to download the PR code as an artifact (without executing it), another workflow triggered by `workflow_run` to build it in a restricted context.

### OIDC for cloud provider authentication (CRITICAL)

Use OpenID Connect (OIDC) instead of storing long-lived cloud credentials as secrets.

```yaml
# BAD - long-lived credentials stored as secrets
- name: Configure AWS
  uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502
  with:
    aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
    aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

# GOOD - OIDC with short-lived tokens
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions
          aws-region: eu-central-1
```

### Self-hosted runner risks (CRITICAL)

Self-hosted runners should **never** be used for public repositories. Any user can open a pull request against a public repo and execute arbitrary code on the runner, potentially accessing secrets, the `GITHUB_TOKEN`, and the runner environment.

For private/internal repositories, anyone with read access can fork and open PRs that run on self-hosted runners.

Mitigations:
- Use ephemeral (single-use) runners that are destroyed after each job
- Use runner groups to restrict which repositories can target which runners
- Never store credentials or sensitive data on the runner host
- Require approval for first-time contributors' workflow runs

### Secret handling (BLOCKER)

Never expose secrets in logs, step names, command-line arguments, or environment variable dumps.

```yaml
# BAD - secret in step name (visible in UI)
- name: Deploy with key ${{ secrets.API_KEY }}
  run: deploy

# BAD - secret as CLI argument (visible in process list, logs)
- run: curl -H "Authorization: Bearer ${{ secrets.TOKEN }}" https://api.example.com

# BAD - printing environment (may expose secrets)
- run: env

# GOOD - use environment variable
- name: Deploy
  env:
    API_KEY: ${{ secrets.API_KEY }}
  run: deploy --key-from-env

# GOOD - mask values
- name: API call
  env:
    TOKEN: ${{ secrets.TOKEN }}
  run: |
    echo "::add-mask::${TOKEN}"
    curl -H "Authorization: Bearer ${TOKEN}" https://api.example.com
```

### Pin Docker images by digest (MAJOR)

Container images referenced in workflow `container:` or `services:` should use digest pinning.

```yaml
# BAD - mutable tag
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:20

# GOOD - pinned by digest
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:20@sha256:abc123def456...
```

### Verify downloaded artifacts before execution (BLOCKER)

Never pipe curl output directly to a shell. Always verify checksums or signatures.

```yaml
# BAD - pipe to shell
- run: curl -sSL https://example.com/install.sh | bash

# GOOD - download, verify, then execute
- name: Install tool
  run: |
    curl -sSLo install.sh https://example.com/install.sh
    echo "expected_sha256  install.sh" | sha256sum -c -
    bash install.sh
```

### Restrict workflow triggers for sensitive operations (MAJOR)

Limit which events can trigger deployment or release workflows.

```yaml
# BAD - deploys on every push to any branch
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: deploy-to-production

# GOOD - only deploy from specific branches/tags with environment protection
on:
  push:
    branches: [main]
    tags: ["v*"]
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: deploy-to-production
```

---

## Reliability

### Always set timeout-minutes (MAJOR)

Jobs without timeouts can run for up to 6 hours (the default), consuming runner minutes and blocking pipelines.

```yaml
# BAD - no timeout
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test

# GOOD - explicit timeout
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: npm test
```

Set timeouts at both job and step level for long-running operations:

```yaml
steps:
  - name: Integration tests
    timeout-minutes: 10
    run: npm run test:integration
```

### Use if: always() for cleanup steps (MAJOR)

Cleanup steps (cache saving, artifact upload, notification) should run regardless of job outcome.

```yaml
steps:
  - name: Run tests
    run: npm test

  - name: Upload coverage
    if: always()
    uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
    with:
      name: coverage
      path: coverage/

  - name: Notify on failure
    if: failure()
    run: |
      curl -X POST "${{ secrets.SLACK_WEBHOOK }}" \
        -d '{"text": "Build failed"}'
```

### Use hashFiles() for cache keys (MAJOR)

Cache keys should be deterministic and based on file content.

```yaml
# BAD - static key, stale cache
- uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684
  with:
    path: node_modules
    key: node-modules-v1

# GOOD - content-based key
- uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684
  with:
    path: node_modules
    key: node-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
    restore-keys: |
      node-${{ runner.os }}-
```

### Matrix strategy configuration (MAJOR)

```yaml
strategy:
  fail-fast: false  # don't cancel other jobs if one fails
  matrix:
    node-version: [18, 20, 22]
    os: [ubuntu-latest, macos-latest]
```

Use `fail-fast: false` when you need results from all matrix combinations (e.g., compatibility testing). Use `fail-fast: true` (default) for fast feedback.

### Quote expressions to avoid YAML parsing issues (MAJOR)

```yaml
# BAD - YAML may interpret as non-string
- if: github.ref == refs/heads/main

# GOOD - quoted
- if: github.ref == 'refs/heads/main'
```

### Use continue-on-error sparingly (MINOR)

Only use `continue-on-error: true` for explicitly optional steps. Never use it to hide flaky tests.

```yaml
# GOOD - optional step that may not be available
- name: Upload to optional service
  continue-on-error: true
  run: upload-metrics
```

---

## Maintainability

### Name all steps (MAJOR)

Every step should have a descriptive `name:`. Unnamed steps show as "Run <command>" in the UI, making debugging difficult.

```yaml
# BAD
steps:
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  - run: npm ci
  - run: npm test
  - run: npm run build

# GOOD
steps:
  - name: Checkout code
    uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  - name: Install dependencies
    run: npm ci
  - name: Run tests
    run: npm test
  - name: Build application
    run: npm run build
```

### Use reusable workflows and composite actions (MAJOR)

Extract common patterns into reusable workflows or composite actions.

```yaml
# .github/workflows/reusable-build.yml
name: Reusable Build
on:
  workflow_call:
    inputs:
      node-version:
        required: false
        type: string
        default: "20"
    secrets:
      npm-token:
        required: false

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - name: Setup Node
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: ${{ inputs.node-version }}
      - name: Install and build
        run: npm ci && npm run build
```

```yaml
# Caller workflow
jobs:
  build:
    uses: ./.github/workflows/reusable-build.yml
    with:
      node-version: "20"
    secrets:
      npm-token: ${{ secrets.NPM_TOKEN }}
```

### Use env: at workflow/job level for shared values (MINOR)

```yaml
# BAD - duplicated across steps
steps:
  - run: echo "Deploying to us-east-1"
  - run: aws s3 sync . s3://my-bucket --region us-east-1

# GOOD - shared via env
env:
  AWS_REGION: us-east-1
  BUCKET_NAME: my-bucket
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Deploying to ${AWS_REGION}"
      - run: aws s3 sync . "s3://${BUCKET_NAME}" --region "${AWS_REGION}"
```

### Extract complex scripts to files (MAJOR)

Inline scripts longer than ~10 lines should be extracted to shell scripts in the repository.

```yaml
# BAD - complex inline script
- name: Deploy
  run: |
    # 30 lines of complex bash...

# GOOD - script file
- name: Deploy
  run: ./scripts/deploy.sh
  env:
    ENVIRONMENT: production
```

### Concurrency groups (MINOR)

Prevent duplicate workflow runs and save resources.

```yaml
# Cancel in-progress runs for the same branch
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

# For deployments: don't cancel, queue instead
concurrency:
  group: deploy-production
  cancel-in-progress: false
```

### Avoid deprecated commands (MAJOR)

```yaml
# BAD - deprecated
- run: echo "::set-output name=version::1.0.0"
- run: echo "::save-state name=key::value"

# GOOD - use GITHUB_OUTPUT and GITHUB_STATE
- run: echo "version=1.0.0" >> "${GITHUB_OUTPUT}"
- run: echo "key=value" >> "${GITHUB_STATE}"
```

### Use GitHub Actions environment files (MINOR)

```yaml
# Set environment variable for subsequent steps
- name: Set version
  run: echo "APP_VERSION=$(cat VERSION)" >> "${GITHUB_ENV}"

# Set output for subsequent jobs
- name: Detect changes
  id: changes
  run: echo "has_changes=true" >> "${GITHUB_OUTPUT}"

# Use multiline values
- name: Set body
  run: |
    {
      echo "body<<EOF"
      cat CHANGELOG.md
      echo "EOF"
    } >> "${GITHUB_OUTPUT}"
```

---

## Environment protection

### Use environments for deployment gates

```yaml
jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: deploy --env staging

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://app.example.com
    steps:
      - run: deploy --env production
```

Configure environment protection rules in repository settings:
- Required reviewers for production
- Wait timers (e.g., 5 minutes)
- Deployment branch restrictions (only `main` or `release/*`)
- Environment-scoped secrets

---

## Tooling integration

### actionlint

Static checker for GitHub Actions workflow files.

```bash
# Install
brew install actionlint

# Run on all workflows
actionlint

# Run on specific file
actionlint .github/workflows/ci.yml
```

### pinact

Pin GitHub Actions to their full commit SHAs.

```bash
# Install
go install github.com/suzuki-shunsuke/pinact/cmd/pinact@latest

# Pin all actions in workflows
pinact run
```

### zizmor

Security scanner specifically for GitHub Actions workflows.

```bash
# Install
pip install zizmor

# Scan workflows
zizmor .github/workflows/
```

### Dependabot for action updates

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

### Pre-commit hook (recommended)

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/rhysd/actionlint
    rev: v1.7.7
    hooks:
      - id: actionlint
```

---

## Checklist for new workflows

When writing a new GitHub Actions workflow, verify:

**Security:**
- [ ] All actions pinned by full commit SHA (not tags)
- [ ] `permissions:` explicitly declared at workflow level
- [ ] Permissions follow least-privilege (default to `contents: read`)
- [ ] No expression injection (`${{ github.event.*.title }}` etc.) in `run:` blocks
- [ ] No `pull_request_target` with checkout of PR head code
- [ ] OIDC used for cloud provider auth (no long-lived credentials)
- [ ] Secrets not echoed, not in step names, not as CLI arguments
- [ ] Downloaded scripts/binaries verified before execution
- [ ] Docker images pinned by digest where used
- [ ] Self-hosted runners not used for public repositories
- [ ] Deployment workflows use environment protection rules

**Reliability:**
- [ ] `timeout-minutes` set on all jobs
- [ ] Cleanup steps use `if: always()`
- [ ] Cache keys use `hashFiles()`
- [ ] Matrix `fail-fast` configured intentionally
- [ ] Expressions are quoted in YAML

**Maintainability:**
- [ ] All steps have descriptive `name:`
- [ ] Common patterns extracted to reusable workflows or composite actions
- [ ] Shared values use `env:` at workflow/job level
- [ ] Complex scripts extracted to files (no inline scripts >10 lines)
- [ ] Concurrency groups prevent duplicate runs
- [ ] No deprecated commands (`set-output`, `save-state`)
- [ ] `actionlint` passes cleanly

## Checklist for workflow review

When reviewing GitHub Actions workflows, additionally check:

- [ ] No mutable action references (tags, branches)
- [ ] No expression injection vectors in `run:` blocks
- [ ] `pull_request_target` is not misused
- [ ] Permissions are not overly broad
- [ ] Secrets are not exposed in logs or step metadata
- [ ] OIDC preferred over stored credentials
- [ ] Workflow triggers are appropriate for the operations performed
- [ ] Environment protection is used for production deployments
- [ ] No `continue-on-error: true` hiding real failures
