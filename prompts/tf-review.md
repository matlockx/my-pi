---
description: Review and fix OpenTofu configurations for SonarCloud compliance, security, and AWS best practices
argument-hint: "<file or directory path>"
---

Load the "terraform-iac" skill first.

Then perform the following steps on the target OpenTofu file(s):

## Step 1: Identify target files

If arguments are provided, review those specific files or directories: $ARGUMENTS

If no arguments are provided, find all `.tf` files in the current project.

## Step 2: Run validation tooling

Run the following tools if available and capture their output:
1. `tofu fmt -check -recursive` - check formatting
2. `tofu validate` - check syntax and configuration validity
3. `tflint --recursive --format=compact` - lint for OpenTofu-specific issues
4. `trivy config . --format=json` - security scan

If a tool is not installed, note this and proceed with manual review.

## Step 3: Review against SonarCloud rules

For each `.tf` file, check every rule from the terraform-iac skill systematically:

**Structure and maintainability:**
- Provider versions are pinned in `required_providers` block
- `required_version` is set on the `terraform` block
- Variables have `description` and `type` attributes
- Outputs have `description` attributes
- Resources use `snake_case` naming
- AWS tags follow PascalCase convention (S6273, S7452)
- No unresolved TODO/FIXME comments (S1135)
- Files parse correctly (S2260)

**IAM and access control (fix immediately):**
- No wildcard `*` actions in IAM policies (S6302 - BLOCKER)
- No wildcard `*` resources in IAM policies (S6304 - BLOCKER)
- No public access policies with `"*"` principals (S6270 - BLOCKER)
- No public S3 bucket ACLs (S6265 - BLOCKER)
- No public APIs without authentication (S6333 - BLOCKER)
- No public network access to databases/caches (S6329 - BLOCKER)
- IAM policies are scoped to specific resources and actions (S6317 - CRITICAL)
- S3 public access block is enabled (S6281 - CRITICAL)
- Admin ports (SSH/RDP) restricted to specific CIDRs (S6321)

**Encryption (fix immediately):**
- TLS 1.2+ enforced on all endpoints (S4423 - CRITICAL)
- HTTPS enforced, no HTTP listeners or clear-text protocols (S5332 - CRITICAL)
- S3 bucket policies deny non-HTTPS access (S6249 - CRITICAL)
- RDS storage encryption enabled (S6303)
- EBS volume encryption enabled (S6275)
- OpenSearch encryption at rest and node-to-node (S6308)
- SageMaker notebook KMS encryption (S6319)
- SNS topic KMS encryption (S6327)
- SQS queue KMS encryption (S6330)
- EFS file system encryption (S6332)

**Logging and durability:**
- Logging enabled on applicable resources (S6258)
- Backup retention >= 7 days (S6364)
- S3 versioning enabled (S6252)
- S3 MFA delete considered for critical buckets (S6255)

## Step 4: Report findings

Provide a summary table of all findings grouped by severity:
- BLOCKER: Must fix immediately - public access, wildcard IAM
- CRITICAL: Must fix - TLS, encryption, public ACLs
- MAJOR: Should fix - missing encryption on specific services, logging, backups
- MINOR / INFO: Nice to fix - tagging, versioning, TODOs

Include the SonarCloud rule ID (e.g., S6317) for each finding.

## Step 5: Apply fixes

Apply all fixes to the OpenTofu files. For each fix:
1. Reference the rule ID
2. Show what changed
3. Ensure the fix does not break existing resource dependencies or state

After applying fixes:
1. Run `tofu fmt -recursive` to ensure consistent formatting
2. Run `tofu validate` to verify the configuration is still valid
3. If tflint/trivy are available, re-run to verify findings are resolved
