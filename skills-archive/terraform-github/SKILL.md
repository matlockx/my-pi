---
name: terraform-github
description: Write and review OpenTofu GitHub provider configurations following Checkov rules, security best practices, and organizational standards
---

## What I do

Guide writing and reviewing OpenTofu configurations for the GitHub provider (`integrations/github`) that pass Checkov checks (CKV_GIT_*), follow security best practices, and implement sound organizational policies for repositories, branch protection, teams, and GitHub Actions.

## When to use me

Use this skill when:
- Writing OpenTofu to manage GitHub repositories, teams, or organizations
- Configuring branch protection rules via OpenTofu
- Setting up GitHub Actions permissions and secrets via OpenTofu
- Reviewing GitHub OpenTofu configurations for security issues
- Fixing Checkov findings in GitHub OpenTofu code

---

## Provider setup

### Pin provider version

```hcl
terraform {
  required_version = ">= 1.3.0"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

provider "github" {
  owner = var.github_organization
  # Token from GITHUB_TOKEN env var or GitHub App authentication
}
```

### Authentication best practices

Never hardcode tokens in Terraform files. Use one of:

```hcl
# Option 1: Environment variable (simplest)
# export GITHUB_TOKEN="ghp_..."
provider "github" {
  owner = var.github_organization
}

# Option 2: GitHub App (recommended for organizations)
provider "github" {
  owner = var.github_organization
  app_auth {
    id              = var.github_app_id
    installation_id = var.github_app_installation_id
    pem_file        = var.github_app_pem_file  # path, not contents
  }
}
```

---

## Checkov GitHub rules

### CKV_GIT_1 — Repositories should be private (MEDIUM)

Public repositories expose code to the world. Default to private unless the project is intentionally open-source.

```hcl
# BAD
resource "github_repository" "repo" {
  name       = "my-app"
  visibility = "public"
}

# GOOD
resource "github_repository" "repo" {
  name       = "my-app"
  visibility = "private"
}
```

If a repository must be public (open source), suppress the check with documentation:

```hcl
# checkov:skip=CKV_GIT_1: Intentionally public - open source project
resource "github_repository" "oss_project" {
  name       = "my-oss-lib"
  visibility = "public"
}
```

### CKV_GIT_2 — Repositories should have vulnerability alerts enabled (HIGH)

Dependabot vulnerability alerts must be enabled.

```hcl
# BAD
resource "github_repository" "repo" {
  name                   = "my-app"
  vulnerability_alerts   = false
}

# GOOD
resource "github_repository" "repo" {
  name                 = "my-app"
  vulnerability_alerts = true
}
```

### CKV_GIT_3 — Repositories should have branch protection (HIGH)

Branch protection must be configured on default branches.

```hcl
# GOOD - branch protection rule for main
resource "github_branch_protection" "main" {
  repository_id = github_repository.repo.node_id
  pattern       = "main"

  required_status_checks {
    strict   = true
    contexts = ["ci/build", "ci/test"]
  }

  required_pull_request_reviews {
    required_approving_review_count = 1
    dismiss_stale_reviews           = true
    require_code_owner_reviews      = true
    restrict_dismissals             = true
  }

  enforce_admins = true

  restrict_pushes {
    blocks_creations = true
  }
}
```

### CKV_GIT_4 — GitHub Actions secrets should be encrypted (MEDIUM)

Use `encrypted_value` instead of `plaintext_value` for GitHub Actions secrets.

```hcl
# BAD
resource "github_actions_secret" "token" {
  repository      = "my-app"
  secret_name     = "API_TOKEN"
  plaintext_value = var.api_token   # stored in state as plain text
}

# GOOD
resource "github_actions_secret" "token" {
  repository      = "my-app"
  secret_name     = "API_TOKEN"
  encrypted_value = var.api_token_encrypted   # pre-encrypted with repo public key
}
```

Note: Even with `encrypted_value`, the value is in Terraform state. Use a secrets manager integration or ensure state is encrypted.

### CKV_GIT_5 — Repositories should require signed commits (MEDIUM)

Require commit signature verification on protected branches.

```hcl
# GOOD
resource "github_branch_protection" "main" {
  repository_id          = github_repository.repo.node_id
  pattern                = "main"
  require_signed_commits = true
}
```

---

## Repository configuration best practices

### Complete repository resource

```hcl
resource "github_repository" "repo" {
  name        = "my-app"
  description = "My application - brief description of purpose"
  visibility  = "private"

  # Repository settings
  has_issues      = true
  has_projects    = false
  has_wiki        = false
  has_downloads   = false
  has_discussions = false

  # Security
  vulnerability_alerts = true

  # Merge settings
  allow_merge_commit     = false    # prefer squash or rebase
  allow_squash_merge     = true
  allow_rebase_merge     = true
  allow_auto_merge       = true
  delete_branch_on_merge = true
  squash_merge_commit_title   = "PR_TITLE"
  squash_merge_commit_message = "PR_BODY"

  # Protection
  archive_on_destroy = true    # archive instead of delete

  # Template (for new repos)
  # template {
  #   owner      = var.github_organization
  #   repository = "template-repo"
  # }

  lifecycle {
    prevent_destroy = true    # prevent accidental deletion
  }
}
```

### Default branch configuration

```hcl
resource "github_branch_default" "main" {
  repository = github_repository.repo.name
  branch     = "main"
}
```

### Repository topics/tags

```hcl
resource "github_repository_topics" "repo" {
  repository = github_repository.repo.name
  topics     = ["terraform-managed", "team-platform", "go"]
}
```

---

## Branch protection best practices

### Comprehensive branch protection

```hcl
resource "github_branch_protection" "main" {
  repository_id = github_repository.repo.node_id
  pattern       = "main"

  # Require PR reviews
  required_pull_request_reviews {
    required_approving_review_count = 2
    dismiss_stale_reviews           = true
    require_code_owner_reviews      = true
    restrict_dismissals             = true
    pull_request_bypassers          = []    # no bypass
  }

  # Require CI checks to pass
  required_status_checks {
    strict   = true    # branch must be up to date before merging
    contexts = [
      "ci/build",
      "ci/test",
      "ci/lint",
      "security/trivy",
    ]
  }

  # Enforce on admins too
  enforce_admins = true

  # Require signed commits
  require_signed_commits = true

  # Require conversation resolution
  require_conversation_resolution = true

  # Restrict who can push
  restrict_pushes {
    blocks_creations = true
  }

  # Require linear history (no merge commits)
  required_linear_history = true

  # Do not allow force pushes
  allows_force_pushes = false

  # Do not allow deletions
  allows_deletions = false

  # Lock branch (fully read-only, use only for release branches)
  # lock_branch = true
}
```

### Release branch protection

```hcl
resource "github_branch_protection" "release" {
  repository_id = github_repository.repo.node_id
  pattern       = "release/*"

  required_pull_request_reviews {
    required_approving_review_count = 2
    dismiss_stale_reviews           = true
    require_code_owner_reviews      = true
  }

  required_status_checks {
    strict   = true
    contexts = ["ci/build", "ci/test", "ci/integration-test"]
  }

  enforce_admins         = true
  require_signed_commits = true
  allows_force_pushes    = false
  allows_deletions       = false
}
```

### Tag protection

```hcl
resource "github_repository_tag_protection" "semver" {
  repository = github_repository.repo.name
  pattern    = "v*"
}
```

---

## Teams and access control

### Team structure

```hcl
resource "github_team" "platform" {
  name        = "platform"
  description = "Platform engineering team"
  privacy     = "closed"    # visible to org members, but membership is controlled
}

resource "github_team" "developers" {
  name           = "developers"
  description    = "Application developers"
  privacy        = "closed"
  parent_team_id = github_team.platform.id    # nested team
}
```

### Repository access — use least privilege

```hcl
# BAD - admin access to everyone
resource "github_team_repository" "bad" {
  team_id    = github_team.developers.id
  repository = github_repository.repo.name
  permission = "admin"
}

# GOOD - appropriate access levels
resource "github_team_repository" "developers" {
  team_id    = github_team.developers.id
  repository = github_repository.repo.name
  permission = "push"    # write access
}

resource "github_team_repository" "platform" {
  team_id    = github_team.platform.id
  repository = github_repository.repo.name
  permission = "admin"    # admin only for platform team
}
```

### Permission levels reference

| Permission | Capabilities |
|-----------|-------------|
| `pull` | Read-only access |
| `triage` | Read + manage issues/PRs (no code push) |
| `push` | Read + write (push code, manage issues) |
| `maintain` | Push + manage repo settings (no destructive actions) |
| `admin` | Full access including destructive actions |

---

## GitHub Actions security

### Restrict Actions permissions

```hcl
resource "github_actions_repository_permissions" "repo" {
  repository = github_repository.repo.name

  # Only allow Actions from the org and verified creators
  allowed_actions = "selected"
  allowed_actions_config {
    github_owned_allowed = true
    verified_allowed     = true
    patterns_allowed     = [
      "actions/checkout@*",
      "actions/setup-node@*",
      "docker/build-push-action@*",
    ]
  }
}
```

### Organization-level Actions permissions

```hcl
resource "github_organization_settings" "org" {
  name = var.github_organization

  # Require approval for first-time contributors
  default_repository_permission = "read"

  # Enforce 2FA
  two_factor_requirement = true

  # Restrict member privileges
  members_can_create_public_repositories  = false
  members_can_create_private_repositories = false
  members_can_create_internal_repositories = false
  members_can_fork_private_repositories   = false
}
```

### Environments with protection rules

```hcl
resource "github_repository_environment" "production" {
  environment = "production"
  repository  = github_repository.repo.name

  reviewers {
    teams = [github_team.platform.id]
  }

  deployment_branch_policy {
    protected_branches     = true
    custom_branch_policies = false
  }

  wait_timer = 5    # 5 minute wait before deployment
}

# Environment-scoped secrets
resource "github_actions_environment_secret" "db_password" {
  repository      = github_repository.repo.name
  environment     = github_repository_environment.production.environment
  secret_name     = "DB_PASSWORD"
  encrypted_value = var.db_password_encrypted
}
```

### OIDC for cloud provider authentication

```hcl
# Configure OIDC trust with AWS (no long-lived credentials)
resource "github_actions_repository_oidc_subject_claim_customization_template" "repo" {
  repository = github_repository.repo.name
  use_default = false
  include_claim_keys = [
    "repo",
    "context",
    "ref",
  ]
}
```

---

## Webhooks

### Use secrets for webhook validation

```hcl
# BAD - no secret
resource "github_repository_webhook" "ci" {
  repository = github_repository.repo.name
  configuration {
    url          = "https://ci.example.com/webhook"
    content_type = "json"
  }
  events = ["push", "pull_request"]
}

# GOOD - with secret for payload validation
resource "github_repository_webhook" "ci" {
  repository = github_repository.repo.name
  configuration {
    url          = "https://ci.example.com/webhook"
    content_type = "json"
    secret       = var.webhook_secret    # HMAC validation
    insecure_ssl = false
  }
  events = ["push", "pull_request"]
}
```

---

## CODEOWNERS

While not Terraform-managed, ensure CODEOWNERS exists:

```hcl
resource "github_repository_file" "codeowners" {
  repository          = github_repository.repo.name
  branch              = "main"
  file                = ".github/CODEOWNERS"
  content             = file("${path.module}/files/CODEOWNERS")
  commit_message      = "chore: update CODEOWNERS"
  overwrite_on_create = true
}
```

---

## Deploy keys

### Use deploy keys instead of personal tokens

```hcl
resource "github_repository_deploy_key" "ci" {
  title      = "CI/CD read-only"
  repository = github_repository.repo.name
  key        = var.deploy_public_key
  read_only  = true    # always read-only unless write is required
}
```

---

## Module pattern for standardized repos

Create a reusable module for consistent repository setup:

```hcl
# modules/github-repo/main.tf
variable "name" {
  type        = string
  description = "Repository name"
}

variable "description" {
  type        = string
  description = "Repository description"
}

variable "visibility" {
  type        = string
  default     = "private"
  description = "Repository visibility (private or public)"
}

variable "team_access" {
  type = map(object({
    team_id    = string
    permission = string
  }))
  default     = {}
  description = "Map of team access configurations"
}

variable "required_status_checks" {
  type        = list(string)
  default     = ["ci/build", "ci/test"]
  description = "Required CI status checks for branch protection"
}

resource "github_repository" "this" {
  name                   = var.name
  description            = var.description
  visibility             = var.visibility
  vulnerability_alerts   = true
  has_issues             = true
  has_wiki               = false
  allow_merge_commit     = false
  allow_squash_merge     = true
  allow_rebase_merge     = true
  delete_branch_on_merge = true
  archive_on_destroy     = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_branch_default" "main" {
  repository = github_repository.this.name
  branch     = "main"
}

resource "github_branch_protection" "main" {
  repository_id = github_repository.this.node_id
  pattern       = "main"

  required_pull_request_reviews {
    required_approving_review_count = 1
    dismiss_stale_reviews           = true
    require_code_owner_reviews      = true
  }

  required_status_checks {
    strict   = true
    contexts = var.required_status_checks
  }

  enforce_admins                  = true
  require_signed_commits          = true
  require_conversation_resolution = true
  allows_force_pushes             = false
  allows_deletions                = false
}

resource "github_team_repository" "access" {
  for_each   = var.team_access
  team_id    = each.value.team_id
  repository = github_repository.this.name
  permission = each.value.permission
}

output "repository_name" {
  value = github_repository.this.name
}

output "repository_full_name" {
  value = github_repository.this.full_name
}

output "repository_html_url" {
  value = github_repository.this.html_url
}
```

Usage:

```hcl
module "my_app_repo" {
  source      = "./modules/github-repo"
  name        = "my-app"
  description = "My application"

  team_access = {
    developers = {
      team_id    = github_team.developers.id
      permission = "push"
    }
    platform = {
      team_id    = github_team.platform.id
      permission = "admin"
    }
  }

  required_status_checks = ["ci/build", "ci/test", "ci/lint"]
}
```

---

## Tooling integration

### Checkov
```bash
# Scan GitHub OpenTofu configs
checkov -d . --framework terraform --check CKV_GIT_1,CKV_GIT_2,CKV_GIT_3,CKV_GIT_4,CKV_GIT_5

# Or scan all checks
checkov -d . --framework terraform
```

### TFLint
```bash
# No built-in GitHub plugin, but general OpenTofu rules apply
tflint --recursive
```

### Custom OPA policies for GitHub resources
```bash
# Convert plan to JSON
tofu plan -out=plan.tfplan
tofu show -json plan.tfplan > plan.json

# Test with conftest
conftest test plan.json --policy policy/github/
```

Example OPA policy — enforce private repos:
```rego
# policy/github/repo_visibility.rego
package github

deny[msg] {
    resource := input.resource_changes[_]
    resource.type == "github_repository"
    resource.change.after.visibility == "public"
    msg := sprintf("Repository '%s' is set to public - must be private unless approved", [resource.change.after.name])
}
```

### CI pipeline example
```yaml
- name: OpenTofu Validate
  run: tofu validate

- name: TFLint
  run: tflint --recursive

- name: Checkov GitHub Checks
  run: |
    checkov -d . --framework terraform \
      --check CKV_GIT_1,CKV_GIT_2,CKV_GIT_3,CKV_GIT_4,CKV_GIT_5 \
      --compact --output cli
```

---

## Checklist for GitHub OpenTofu configurations

**Repositories:**
- [ ] Visibility is `private` unless intentionally public (CKV_GIT_1)
- [ ] Vulnerability alerts enabled (CKV_GIT_2)
- [ ] Branch protection configured on default branch (CKV_GIT_3)
- [ ] Signed commits required (CKV_GIT_5)
- [ ] `delete_branch_on_merge = true`
- [ ] `archive_on_destroy = true`
- [ ] `lifecycle { prevent_destroy = true }` set
- [ ] Merge strategy configured (prefer squash/rebase over merge commits)
- [ ] Description and topics set
- [ ] CODEOWNERS file managed

**Branch protection:**
- [ ] PR reviews required with minimum reviewer count
- [ ] Stale review dismissal enabled
- [ ] Code owner reviews required
- [ ] Required status checks configured
- [ ] `strict = true` (branch must be up to date)
- [ ] `enforce_admins = true`
- [ ] Force pushes disabled
- [ ] Branch deletion disabled
- [ ] Conversation resolution required

**Access control:**
- [ ] Teams use least-privilege permissions (pull/push/maintain/admin)
- [ ] No individual collaborator access (use teams)
- [ ] Deploy keys are read-only unless write is needed

**GitHub Actions:**
- [ ] Actions restricted to org-owned and verified (CKV_GIT_4)
- [ ] Secrets use `encrypted_value` not `plaintext_value`
- [ ] Production environment has reviewers and wait timer
- [ ] OIDC used for cloud authentication (no long-lived tokens)

**Webhooks:**
- [ ] Webhook secrets configured for payload validation
- [ ] `insecure_ssl = false`
- [ ] Only HTTPS URLs used

**Organization:**
- [ ] 2FA requirement enabled
- [ ] Default repository permission is `read`
- [ ] Members cannot create public repositories
- [ ] Fork restrictions configured

**Terraform:**
- [ ] Provider version pinned
- [ ] Authentication via env var or GitHub App (no hardcoded tokens)
- [ ] `tofu fmt` passes
- [ ] `tofu validate` passes
- [ ] Checkov passes
