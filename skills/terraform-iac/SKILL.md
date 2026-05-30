---
name: terraform-iac
description: Write and review OpenTofu IaC (AWS-focused) following SonarCloud default rule set, covering security vulnerabilities, hotspots, and maintainability best practices
---

## What I do

Guide writing and reviewing OpenTofu configurations that are compliant with SonarCloud's default Terraform analysis rule set (52 rules). Primary focus is on AWS provider resources. Azure and GCP rules are included for awareness.

## When to use me

Use this skill when:
- Writing new OpenTofu modules or configurations (`.tf` files)
- Reviewing or refactoring existing OpenTofu code
- Fixing SonarCloud issues in OpenTofu projects
- Preparing infrastructure-as-code for CI/CD pipelines running SonarCloud analysis
- Setting up new AWS resources via OpenTofu

## General Terraform best practices

### File structure
```
module/
  main.tf          # Primary resources
  variables.tf     # Input variables with descriptions and types
  outputs.tf       # Output values
  providers.tf     # Provider and terraform version constraints
  locals.tf        # Local values
  data.tf          # Data sources
  versions.tf      # Required provider versions (alternative to providers.tf)
```

### Required providers block
Always pin provider versions:
```hcl
terraform {
  required_version = ">= 1.3.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
```

### Naming conventions
- Resources and data sources: `snake_case`
- Variables and outputs: `snake_case`
- Use descriptive, meaningful names
- Prefix related resources consistently (e.g., `app_db_instance`, `app_db_subnet_group`)

### State management
- Always use remote state (S3 + DynamoDB for AWS)
- Enable state encryption
- Enable state locking

---

## SonarCloud Terraform rules - Vulnerabilities (must fix)

### S4423 - Weak SSL/TLS protocols should not be used (CRITICAL)
**Platforms:** AWS, Azure, GCP

Enforce TLSv1.2 or higher on all resources. Never allow TLSv1.0, TLSv1.1, SSLv3.

```hcl
# BAD - allows TLS 1.0
resource "aws_cloudfront_distribution" "bad" {
  viewer_certificate {
    minimum_protocol_version = "TLSv1"
  }
}

# GOOD - enforces TLS 1.2
resource "aws_cloudfront_distribution" "good" {
  viewer_certificate {
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
```

Also applies to:
- `aws_api_gateway_domain_name` - set `security_policy = "TLS_1_2"`
- `aws_lb_listener` - set `ssl_policy` to a TLS 1.2+ policy
- `aws_elasticsearch_domain` / `aws_opensearch_domain` - set `tls_security_policy = "Policy-Min-TLS-1-2-2019-07"`

### S6317 - IAM policies should limit the scope of permissions (CRITICAL)
**Platform:** AWS

Never use wildcard actions with wildcard resources. IAM policies must follow least-privilege.

```hcl
# BAD - overly broad
data "aws_iam_policy_document" "bad" {
  statement {
    effect    = "Allow"
    actions   = ["s3:*"]
    resources = ["*"]
  }
}

# GOOD - scoped to specific actions and resources
data "aws_iam_policy_document" "good" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.app.arn,
      "${aws_s3_bucket.app.arn}/*"
    ]
  }
}
```

### S6321 - Administration services should be restricted to specific IPs (MINOR)
**Platforms:** AWS, Azure, GCP

Never allow `0.0.0.0/0` or `::/0` on administrative ports (SSH/22, RDP/3389).

```hcl
# BAD - SSH open to the world
resource "aws_security_group_rule" "bad" {
  type        = "ingress"
  from_port   = 22
  to_port     = 22
  protocol    = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
}

# GOOD - restricted to specific CIDR
resource "aws_security_group_rule" "good" {
  type        = "ingress"
  from_port   = 22
  to_port     = 22
  protocol    = "tcp"
  cidr_blocks = [var.admin_cidr_block]
}
```

---

## SonarCloud Terraform rules - Security hotspots: IAM and access control

### S6304 - Do not grant access to all resources of an account (BLOCKER)
**Platform:** AWS

Never use `"Resource": "*"` in IAM policies when specific resource ARNs can be used.

```hcl
# BAD
statement {
  effect    = "Allow"
  actions   = ["s3:GetObject"]
  resources = ["*"]
}

# GOOD
statement {
  effect    = "Allow"
  actions   = ["s3:GetObject"]
  resources = ["arn:aws:s3:::my-bucket/*"]
}
```

### S6302 - Do not grant all privileges (BLOCKER)
**Platforms:** AWS, GCP

Never use `"Action": "*"` or `"Action": ["*"]` in IAM policies.

```hcl
# BAD
statement {
  effect    = "Allow"
  actions   = ["*"]
  resources = ["*"]
}

# GOOD - grant only needed actions
statement {
  effect    = "Allow"
  actions   = ["ec2:DescribeInstances", "ec2:DescribeSecurityGroups"]
  resources = ["*"]  # some ec2 describe actions require *
}
```

### S6270 - Do not authorize public access to resources (BLOCKER)
**Platform:** AWS

Avoid IAM policy principals set to `"*"` or `{"AWS": "*"}`.

```hcl
# BAD
statement {
  effect     = "Allow"
  actions    = ["sqs:SendMessage"]
  resources  = [aws_sqs_queue.queue.arn]
  principals {
    type        = "AWS"
    identifiers = ["*"]
  }
}

# GOOD - restrict to specific account/role
statement {
  effect     = "Allow"
  actions    = ["sqs:SendMessage"]
  resources  = [aws_sqs_queue.queue.arn]
  principals {
    type        = "AWS"
    identifiers = [var.allowed_role_arn]
  }
}
```

### S6265 - Do not grant public access to S3 buckets (BLOCKER)
**Platform:** AWS

Never use `public-read`, `public-read-write`, or `authenticated-read` ACLs.

```hcl
# BAD
resource "aws_s3_bucket_acl" "bad" {
  bucket = aws_s3_bucket.bucket.id
  acl    = "public-read"
}

# GOOD
resource "aws_s3_bucket_acl" "good" {
  bucket = aws_s3_bucket.bucket.id
  acl    = "private"
}
```

### S6281 - Block public ACLs and policies on S3 buckets (CRITICAL)
**Platform:** AWS

Always enable S3 public access block.

```hcl
resource "aws_s3_bucket_public_access_block" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

### S6333 - Do not create public APIs (BLOCKER)
**Platform:** AWS

API Gateway routes and methods should not be publicly accessible without authentication.

```hcl
# BAD
resource "aws_api_gateway_method" "bad" {
  authorization = "NONE"
}

# GOOD
resource "aws_api_gateway_method" "good" {
  authorization = "AWS_IAM"
}
```

### S6329 - Do not allow public network access (BLOCKER)
**Platforms:** AWS, Azure, GCP

Resources like RDS, ElastiCache, and Redshift should not be publicly accessible.

```hcl
# BAD
resource "aws_db_instance" "bad" {
  publicly_accessible = true
}

# GOOD
resource "aws_db_instance" "good" {
  publicly_accessible = false
  db_subnet_group_name = aws_db_subnet_group.private.name
}
```

Also applies to:
- `aws_dms_replication_instance` - `publicly_accessible = false`
- `aws_redshift_cluster` - `publicly_accessible = false`
- `aws_launch_template` - do not associate public IPs to instances in private subnets

---

## SonarCloud Terraform rules - Security hotspots: Encryption

### S5332 - Do not use clear-text protocols (CRITICAL)
**Platforms:** AWS, Azure, GCP

Enforce HTTPS/TLS everywhere. No HTTP listeners, no unencrypted connections.

```hcl
# BAD
resource "aws_lb_listener" "bad" {
  protocol = "HTTP"
}

# GOOD
resource "aws_lb_listener" "good" {
  protocol   = "HTTPS"
  ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
```

### S6249 - Enforce HTTPS on S3 bucket policies (CRITICAL)
**Platform:** AWS

Deny HTTP access to S3 buckets via bucket policy.

```hcl
data "aws_iam_policy_document" "enforce_tls" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [
      aws_s3_bucket.bucket.arn,
      "${aws_s3_bucket.bucket.arn}/*"
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}
```

### S6303 - Encrypt RDS DB instances (MAJOR)
**Platform:** AWS
```hcl
resource "aws_db_instance" "db" {
  storage_encrypted = true
  kms_key_id        = aws_kms_key.db.arn
}
```

### S6308 - Encrypt OpenSearch domains (MAJOR)
**Platform:** AWS
```hcl
resource "aws_opensearch_domain" "domain" {
  encrypt_at_rest {
    enabled    = true
    kms_key_id = aws_kms_key.opensearch.arn
  }

  node_to_node_encryption {
    enabled = true
  }
}
```

### S6275 - Encrypt EBS volumes (MAJOR)
**Platform:** AWS
```hcl
resource "aws_ebs_volume" "vol" {
  encrypted  = true
  kms_key_id = aws_kms_key.ebs.arn
}

# Also set default EBS encryption for the account
resource "aws_ebs_encryption_by_default" "default" {
  enabled = true
}
```

### S6319 - Encrypt SageMaker notebook instances (MAJOR)
**Platform:** AWS
```hcl
resource "aws_sagemaker_notebook_instance" "nb" {
  kms_key_id = aws_kms_key.sagemaker.arn
}
```

### S6327 - Encrypt SNS topics (MAJOR)
**Platform:** AWS
```hcl
resource "aws_sns_topic" "topic" {
  kms_master_key_id = aws_kms_key.sns.arn
}
```

### S6330 - Encrypt SQS queues (MAJOR)
**Platform:** AWS
```hcl
resource "aws_sqs_queue" "queue" {
  kms_master_key_id = aws_kms_key.sqs.arn
}
```

### S6332 - Encrypt EFS file systems (MAJOR)
**Platform:** AWS
```hcl
resource "aws_efs_file_system" "efs" {
  encrypted  = true
  kms_key_id = aws_kms_key.efs.arn
}
```

---

## SonarCloud Terraform rules - Security hotspots: Logging and backups

### S6258 - Enable logging (MAJOR)
**Platforms:** AWS, GCP

Always enable access logging / audit logging on resources.

```hcl
# S3 bucket logging
resource "aws_s3_bucket_logging" "bucket" {
  bucket        = aws_s3_bucket.bucket.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-access-logs/"
}

# CloudTrail
resource "aws_cloudtrail" "trail" {
  name                       = "main-trail"
  s3_bucket_name             = aws_s3_bucket.trail_logs.id
  enable_logging             = true
  is_multi_region_trail      = true
  include_global_service_events = true
}

# VPC flow logs
resource "aws_flow_log" "vpc" {
  vpc_id          = aws_vpc.main.id
  traffic_type    = "ALL"
  log_destination = aws_cloudwatch_log_group.flow_logs.arn
}
```

### S6364 - Backup retention should be at least 7 days (MAJOR)
**Platforms:** AWS, Azure

```hcl
# BAD
resource "aws_db_instance" "bad" {
  backup_retention_period = 1
}

# GOOD
resource "aws_db_instance" "good" {
  backup_retention_period = 7
}
```

Also applies to:
- `aws_rds_cluster` - `backup_retention_period >= 7`
- `aws_elasticache_cluster` - `snapshot_retention_limit >= 7`

### S6252 - Enable S3 bucket versioning (MINOR)
**Platform:** AWS
```hcl
resource "aws_s3_bucket_versioning" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  versioning_configuration {
    status = "Enabled"
  }
}
```

### S6255 - Enable S3 MFA delete (MINOR)
**Platform:** AWS

Consider enabling MFA delete on critical buckets to prevent accidental or malicious deletion.
```hcl
resource "aws_s3_bucket_versioning" "bucket" {
  bucket = aws_s3_bucket.bucket.id

  versioning_configuration {
    status     = "Enabled"
    mfa_delete = "Enabled"
  }
}
```

---

## SonarCloud Terraform rules - Azure (awareness)

These rules apply to Azure resources. Listed for awareness when working in multi-cloud environments.

| Rule | Severity | Description |
|------|----------|-------------|
| S6385 | MAJOR | Azure custom roles should not grant subscription Owner capabilities |
| S6387 | MAJOR | Azure role assignments granting all-resource access are security-sensitive |
| S6380 | MAJOR | Authorizing anonymous access to Azure resources is security-sensitive |
| S6383 | MAJOR | Disabling RBAC on Azure resources is security-sensitive |
| S6382 | MAJOR | Disabling certificate-based authentication is security-sensitive |
| S6381 | MAJOR | Assigning high privilege Azure ARM built-in roles is security-sensitive |
| S6375 | MAJOR | Assigning high privilege Azure AD built-in roles is security-sensitive |
| S6388 | MAJOR | Using unencrypted cloud storage is security-sensitive |
| S6378 | MAJOR | Disabling Managed Identities for Azure resources is security-sensitive |
| S6379 | MAJOR | Enabling Azure resource-specific admin accounts is security-sensitive |

---

## SonarCloud Terraform rules - GCP (awareness)

These rules apply to Google Cloud Platform resources. Listed for awareness.

| Rule | Severity | Description |
|------|----------|-------------|
| S6404 | MAJOR | Granting public access to GCP resources is security-sensitive |
| S6400 | MAJOR | Granting highly privileged GCP resource rights is security-sensitive |
| S6406 | MAJOR | Excessive granting of GCP IAM permissions is security-sensitive |
| S6405 | MAJOR | Enabling project-wide SSH keys to access VM instances is security-sensitive |
| S6408 | MAJOR | Creating custom roles allowing privilege escalation is security-sensitive |
| S6409 | MAJOR | Enabling ABAC for Kubernetes is security-sensitive |
| S6410 | MAJOR | GCP load balancers should not offer weak cipher suites |
| S6401 | MAJOR | Creating keys without a rotation period is security-sensitive |
| S6402 | MAJOR | Creating DNS zones without DNSSEC enabled is security-sensitive |
| S6403 | MAJOR | Creating GCP SQL instances without requiring TLS is security-sensitive |
| S6407 | MAJOR | Creating App Engine handlers without requiring TLS is security-sensitive |
| S6412 | MINOR | Unversioned Google Cloud Storage buckets are security-sensitive |
| S6413 | MAJOR | Defining a short log retention duration is security-sensitive |
| S6414 | MAJOR | Excluding users or groups from audit logs is security-sensitive |

---

## SonarCloud Terraform rules - Maintainability

### S1135 - Track uses of TODO tags (INFO)
`TODO` and `FIXME` comments are tracked by SonarCloud. Ensure they include a ticket reference and action plan. Do not leave unresolved TODOs in production Terraform code.

### S6273 - AWS tag keys should follow naming conventions (MINOR)
**Platform:** AWS

Tag keys should use PascalCase (e.g., `Environment`, `CostCenter`, `ProjectName`).

```hcl
# BAD
tags = {
  environment = "production"
  cost_center = "engineering"
}

# GOOD
tags = {
  Environment = "production"
  CostCenter  = "engineering"
  ProjectName = "my-app"
}
```

### S7452 - AWS resource tags should have valid format (MINOR)
**Platform:** AWS

Ensure tag keys and values comply with AWS limits (128/256 character max, no `aws:` prefix).

### S2260 - Terraform parsing failure (MAJOR)
Ensure all `.tf` files parse correctly. Run `tofu validate` before committing.

---

## Tooling integration

### tflint

[tflint](https://github.com/terraform-linters/tflint) catches Terraform-specific issues including deprecated syntax, invalid resource configurations, and naming convention violations.

1. **Install**: `brew install tflint` (macOS) or see [install docs](https://github.com/terraform-linters/tflint#installation)
2. **Configure** `.tflint.hcl` in project root:
   ```hcl
   plugin "aws" {
     enabled = true
     version = "0.32.0"
     source  = "github.com/terraform-linters/tflint-ruleset-aws"
   }

   rule "terraform_naming_convention" {
     enabled = true
   }

   rule "terraform_documented_variables" {
     enabled = true
   }

   rule "terraform_documented_outputs" {
     enabled = true
   }

   rule "terraform_typed_variables" {
     enabled = true
   }
   ```
3. **Run**: `tflint --recursive`
4. **CI integration**: Add `tflint --recursive --format=compact` to your pipeline

### Trivy

[Trivy](https://github.com/aquasecurity/trivy) performs static security analysis of OpenTofu/Terraform code. It catches many of the same issues as SonarCloud's security rules.

1. **Install**: `brew install trivy` (macOS)
2. **Run**: `trivy config .`
3. **CI integration**: Add `trivy config . --format json --output trivy-results.json` to your pipeline
4. **Pre-commit hook** (recommended):
   ```yaml
   # .pre-commit-config.yaml
   repos:
     - repo: https://github.com/antonbabenko/pre-commit-terraform
       rev: v1.96.1
       hooks:
         - id: terraform_fmt
         - id: terraform_validate
         - id: terraform_tflint
         - id: terraform_trivy
   ```

### tofu validate and fmt
Always run before committing:
```bash
tofu fmt -recursive
tofu validate
```

---

## Checklist for new OpenTofu modules

When writing new OpenTofu configurations, verify:

**Structure:**
- [ ] Provider versions are pinned in `required_providers`
- [ ] `terraform` block specifies `required_version`
- [ ] Variables have `description` and `type`
- [ ] Outputs have `description`
- [ ] Resources use `snake_case` naming
- [ ] Tags follow PascalCase convention (AWS)
- [ ] Remote state with encryption and locking is configured

**Security - IAM (AWS):**
- [ ] No wildcard `*` actions in IAM policies (S6302)
- [ ] No wildcard `*` resources in IAM policies (S6304)
- [ ] Policies are scoped to specific resources (S6317)
- [ ] No public principals in resource policies (S6270)
- [ ] No public S3 bucket ACLs (S6265)
- [ ] S3 public access block is enabled (S6281)
- [ ] API Gateway methods require authentication (S6333)
- [ ] Admin ports restricted to specific CIDRs (S6321)

**Security - Encryption:**
- [ ] TLS 1.2+ enforced on all endpoints (S4423)
- [ ] HTTPS enforced, no HTTP listeners (S5332)
- [ ] S3 buckets enforce HTTPS via bucket policy (S6249)
- [ ] RDS instances have `storage_encrypted = true` (S6303)
- [ ] EBS volumes have `encrypted = true` (S6275)
- [ ] OpenSearch domains have encryption at rest and node-to-node (S6308)
- [ ] SageMaker notebooks have KMS key (S6319)
- [ ] SNS topics have KMS key (S6327)
- [ ] SQS queues have KMS key (S6330)
- [ ] EFS file systems have `encrypted = true` (S6332)

**Security - Network:**
- [ ] RDS/Redshift/DMS instances are not publicly accessible (S6329)
- [ ] Resources are in private subnets where possible

**Logging and durability:**
- [ ] Logging is enabled on all applicable resources (S6258)
- [ ] Backup retention is at least 7 days (S6364)
- [ ] S3 versioning is enabled (S6252)
- [ ] S3 MFA delete is considered for critical buckets (S6255)

**Validation:**
- [ ] `tofu fmt` passes
- [ ] `tofu validate` passes
- [ ] `tflint` passes
- [ ] `trivy config` shows no HIGH/CRITICAL findings
- [ ] No unresolved TODO/FIXME comments (S1135)
