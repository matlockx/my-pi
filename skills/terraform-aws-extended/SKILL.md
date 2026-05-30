---
name: terraform-aws-extended
description: Write and review OpenTofu AWS configurations following Checkov and Trivy rule sets beyond SonarCloud, covering 1000+ security, compliance, and best practice checks
---

## What I do

Guide writing and reviewing OpenTofu AWS configurations that pass Checkov (~1000+ rules) and Trivy (~350+ rules) checks. This skill extends the `terraform-iac` skill (SonarCloud rules) with comprehensive coverage of AWS security misconfigurations, CIS benchmarks, and infrastructure best practices.

## When to use me

Use this skill when:
- Writing new AWS Terraform configurations and want comprehensive security coverage
- Fixing Checkov (CKV_AWS_*) or Trivy (AVD-AWS-*) findings
- Preparing for CIS AWS Benchmark compliance
- Going beyond SonarCloud's limited AWS rule set
- Reviewing Terraform for production readiness

## Relationship to terraform-iac skill

The `terraform-iac` skill covers SonarCloud's 52 rules. This skill covers the **additional** rules from Checkov and Trivy that SonarCloud does not check. Use both skills together for maximum coverage.

---

## EKS / Kubernetes on AWS

### CKV_AWS_37 / AVD-AWS-0038 — EKS control plane logging enabled (HIGH)

```hcl
# BAD
resource "aws_eks_cluster" "cluster" {
  name     = "my-cluster"
  role_arn = aws_iam_role.cluster.arn
}

# GOOD
resource "aws_eks_cluster" "cluster" {
  name     = "my-cluster"
  role_arn = aws_iam_role.cluster.arn

  enabled_cluster_log_types = [
    "api",
    "audit",
    "authenticator",
    "controllerManager",
    "scheduler",
  ]
}
```

### CKV_AWS_38 / AVD-AWS-0040 — EKS public endpoint disabled (HIGH)

```hcl
# BAD
resource "aws_eks_cluster" "cluster" {
  vpc_config {
    endpoint_public_access = true
  }
}

# GOOD
resource "aws_eks_cluster" "cluster" {
  vpc_config {
    endpoint_public_access  = false
    endpoint_private_access = true
    subnet_ids              = var.private_subnet_ids
  }
}

# ACCEPTABLE - public access restricted to specific CIDRs
resource "aws_eks_cluster" "cluster" {
  vpc_config {
    endpoint_public_access  = true
    public_access_cidrs     = [var.vpn_cidr]
    endpoint_private_access = true
  }
}
```

### CKV_AWS_58 / AVD-AWS-0039 — EKS secrets encryption (HIGH)

```hcl
resource "aws_eks_cluster" "cluster" {
  encryption_config {
    provider {
      key_arn = aws_kms_key.eks.arn
    }
    resources = ["secrets"]
  }
}
```

### CKV_AWS_39 — EKS security group restrictions (HIGH)

Do not allow 0.0.0.0/0 ingress on EKS cluster security groups.

```hcl
# GOOD
resource "aws_eks_cluster" "cluster" {
  vpc_config {
    security_group_ids = [aws_security_group.eks_cluster.id]
  }
}

resource "aws_security_group" "eks_cluster" {
  vpc_id = var.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]    # restrict to VPC CIDR
  }
}
```

---

## EC2 and compute

### CKV_AWS_79 / AVD-AWS-0028 — IMDSv2 required (HIGH)

Instance Metadata Service v2 prevents SSRF attacks.

```hcl
# BAD
resource "aws_instance" "server" {
  ami           = var.ami_id
  instance_type = "t3.medium"
}

# GOOD
resource "aws_instance" "server" {
  ami           = var.ami_id
  instance_type = "t3.medium"

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"    # enforces IMDSv2
    http_put_response_hop_limit = 1
  }
}

# Also for launch templates
resource "aws_launch_template" "app" {
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
}
```

### CKV_AWS_88 / AVD-AWS-0012 — EC2 instances should not have public IPs (HIGH)

```hcl
# BAD
resource "aws_instance" "server" {
  associate_public_ip_address = true
}

# GOOD
resource "aws_instance" "server" {
  associate_public_ip_address = false
  subnet_id                   = var.private_subnet_id
}
```

### CKV_AWS_126 — EC2 detailed monitoring enabled (MEDIUM)

```hcl
resource "aws_instance" "server" {
  monitoring = true
}
```

### CKV_AWS_135 — EBS optimized instances (LOW)

```hcl
resource "aws_instance" "server" {
  ebs_optimized = true
}
```

### CKV_AWS_8 / AVD-AWS-0027 — EBS encryption with CMK (HIGH)

```hcl
resource "aws_instance" "server" {
  root_block_device {
    encrypted  = true
    kms_key_id = aws_kms_key.ebs.arn
  }

  ebs_block_device {
    device_name = "/dev/sdf"
    encrypted   = true
    kms_key_id  = aws_kms_key.ebs.arn
  }
}
```

---

## VPC and networking

### CKV_AWS_130 — VPC subnets should not auto-assign public IPs (HIGH)

```hcl
# BAD
resource "aws_subnet" "public" {
  map_public_ip_on_launch = true
}

# GOOD - only for explicitly public subnets
resource "aws_subnet" "private" {
  map_public_ip_on_launch = false
}
```

### CKV2_AWS_11 — VPC flow logs enabled (HIGH)

```hcl
resource "aws_flow_log" "vpc" {
  vpc_id                   = aws_vpc.main.id
  traffic_type             = "ALL"
  log_destination          = aws_cloudwatch_log_group.flow_logs.arn
  log_destination_type     = "cloud-watch-logs"
  iam_role_arn             = aws_iam_role.flow_logs.arn
  max_aggregation_interval = 60

  tags = {
    Name = "vpc-flow-logs"
  }
}
```

### CKV2_AWS_12 — Default VPC security group restricts all traffic (MEDIUM)

```hcl
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id

  # No ingress or egress rules = deny all
  # This ensures the default SG is locked down
}
```

### CKV_AWS_23 — Security groups attached to resources (INFO)

Every security group should be attached to at least one resource to avoid orphaned rules.

### CKV2_AWS_19 — Ensure VPC has verified flow logs (HIGH)

Flow logs should use CloudWatch Logs or S3 with proper retention.

### AVD-AWS-0102 — No unrestricted egress in security groups (MEDIUM)

```hcl
# BAD
resource "aws_security_group_rule" "egress" {
  type        = "egress"
  from_port   = 0
  to_port     = 0
  protocol    = "-1"
  cidr_blocks = ["0.0.0.0/0"]
}

# GOOD - restrict egress to needed destinations
resource "aws_security_group_rule" "egress_https" {
  type        = "egress"
  from_port   = 443
  to_port     = 443
  protocol    = "tcp"
  cidr_blocks = ["0.0.0.0/0"]    # or specific CIDRs
}
```

---

## IAM advanced rules

### CKV_AWS_40 — IAM policies should not be attached to users (HIGH)

Attach policies to roles or groups, never directly to users.

```hcl
# BAD
resource "aws_iam_user_policy_attachment" "user" {
  user       = aws_iam_user.admin.name
  policy_arn = aws_iam_policy.admin.arn
}

# GOOD - attach to group
resource "aws_iam_group_policy_attachment" "admins" {
  group      = aws_iam_group.admins.name
  policy_arn = aws_iam_policy.admin.arn
}
```

### CKV_AWS_61 — IAM policies should not allow assume role to all principals (HIGH)

```hcl
# BAD
data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
}

# GOOD
data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [var.trusted_role_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalOrgID"
      values   = [var.org_id]
    }
  }
}
```

### CKV_AWS_111 — IAM policies should not allow write access without constraints (HIGH)

IAM policies with write actions should have conditions.

```hcl
# GOOD - write policy with condition
data "aws_iam_policy_document" "s3_write" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.uploads.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
}
```

### CKV_AWS_109 / CKV_AWS_110 — IAM policies should not allow privilege escalation (CRITICAL)

Never grant actions that allow creating new admin policies or roles:

Dangerous action combinations to avoid:
- `iam:CreatePolicyVersion` — can create a new admin policy version
- `iam:SetDefaultPolicyVersion` — can activate a permissive policy version
- `iam:PassRole` + `lambda:CreateFunction` + `lambda:InvokeFunction` — escalation via Lambda
- `iam:PassRole` + `ec2:RunInstances` — escalation via EC2 instance profile
- `iam:AttachUserPolicy` / `iam:AttachGroupPolicy` / `iam:AttachRolePolicy` — direct escalation
- `iam:PutUserPolicy` / `iam:PutGroupPolicy` / `iam:PutRolePolicy` — inline policy escalation

### CKV2_AWS_21 — IAM users should have MFA (HIGH)

```hcl
# Enforce MFA via policy condition
data "aws_iam_policy_document" "require_mfa" {
  statement {
    sid       = "DenyAllExceptMFA"
    effect    = "Deny"
    not_actions = [
      "iam:CreateVirtualMFADevice",
      "iam:EnableMFADevice",
      "iam:GetUser",
      "iam:ListMFADevices",
      "iam:ListVirtualMFADevices",
      "iam:ResyncMFADevice",
      "sts:GetSessionToken",
    ]
    resources = ["*"]

    condition {
      test     = "BoolIfExists"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["false"]
    }
  }
}
```

### CKV_AWS_273 — Do not use access keys for IAM users (HIGH)

Prefer IAM roles with temporary credentials via STS.

---

## S3 advanced rules

### CKV_AWS_18 — S3 access logging enabled (MEDIUM)

```hcl
resource "aws_s3_bucket_logging" "bucket" {
  bucket        = aws_s3_bucket.app.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-logs/${aws_s3_bucket.app.id}/"
}
```

### CKV_AWS_19 / CKV_AWS_145 — S3 encryption with CMK (HIGH)

```hcl
# Basic (SSE-S3) — acceptable
resource "aws_s3_bucket_server_side_encryption_configuration" "bucket" {
  bucket = aws_s3_bucket.app.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}
```

### CKV2_AWS_6 — S3 bucket has public access block (CRITICAL)

```hcl
resource "aws_s3_bucket_public_access_block" "bucket" {
  bucket = aws_s3_bucket.app.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

### CKV2_AWS_61 — S3 bucket lifecycle configuration (MEDIUM)

```hcl
resource "aws_s3_bucket_lifecycle_configuration" "bucket" {
  bucket = aws_s3_bucket.app.id

  rule {
    id     = "transition-to-ia"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}
```

### CKV2_AWS_62 — S3 event notifications configured (LOW)

Enable event notifications for audit and monitoring.

### CKV_AWS_70 — S3 object lock (HIGH for compliance)

```hcl
resource "aws_s3_bucket" "compliance" {
  bucket              = "compliance-logs"
  object_lock_enabled = true
}

resource "aws_s3_bucket_object_lock_configuration" "compliance" {
  bucket = aws_s3_bucket.compliance.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 365
    }
  }
}
```

---

## RDS / Aurora advanced rules

### CKV_AWS_118 — RDS enhanced monitoring (MEDIUM)

```hcl
resource "aws_db_instance" "db" {
  monitoring_interval = 60    # seconds
  monitoring_role_arn = aws_iam_role.rds_monitoring.arn
}
```

### CKV_AWS_157 — RDS multi-AZ (HIGH)

```hcl
resource "aws_db_instance" "db" {
  multi_az = true
}
```

### CKV_AWS_161 — RDS IAM authentication (MEDIUM)

```hcl
resource "aws_db_instance" "db" {
  iam_database_authentication_enabled = true
}
```

### CKV_AWS_226 — RDS auto minor version upgrade (MEDIUM)

```hcl
resource "aws_db_instance" "db" {
  auto_minor_version_upgrade = true
}
```

### CKV_AWS_133 — RDS deletion protection (HIGH)

```hcl
resource "aws_db_instance" "db" {
  deletion_protection = true
}
```

### CKV_AWS_16 — RDS encryption at rest (HIGH)

```hcl
resource "aws_db_instance" "db" {
  storage_encrypted = true
  kms_key_id        = aws_kms_key.rds.arn
}
```

### CKV2_AWS_30 — RDS not publicly accessible (CRITICAL)

```hcl
resource "aws_db_instance" "db" {
  publicly_accessible    = false
  db_subnet_group_name   = aws_db_subnet_group.private.name
}
```

### CKV_AWS_354 — RDS Performance Insights encryption (MEDIUM)

```hcl
resource "aws_db_instance" "db" {
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.rds_pi.arn
  performance_insights_retention_period = 7
}
```

### Complete RDS example

```hcl
resource "aws_db_instance" "production" {
  identifier = "my-app-db"

  engine         = "postgres"
  engine_version = "15.4"
  instance_class = "db.r6g.large"

  allocated_storage     = 100
  max_allocated_storage = 500
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.rds.arn

  db_name  = "myapp"
  username = "admin"
  manage_master_user_password = true    # AWS Secrets Manager managed

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.private.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  backup_retention_period = 14
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "my-app-db-final"
  copy_tags_to_snapshot     = true

  auto_minor_version_upgrade          = true
  iam_database_authentication_enabled = true
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoring.arn

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.rds_pi.arn
  performance_insights_retention_period = 7

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = {
    Name        = "my-app-db"
    Environment = "production"
  }
}
```

---

## CloudTrail

### CKV_AWS_35 — CloudTrail encryption with CMK (HIGH)

```hcl
resource "aws_cloudtrail" "main" {
  kms_key_id = aws_kms_key.cloudtrail.arn
}
```

### CKV_AWS_36 — CloudTrail log file validation (HIGH)

```hcl
resource "aws_cloudtrail" "main" {
  enable_log_file_validation = true
}
```

### CKV_AWS_67 — CloudTrail multi-region (HIGH)

```hcl
resource "aws_cloudtrail" "main" {
  is_multi_region_trail         = true
  include_global_service_events = true
}
```

### Complete CloudTrail example

```hcl
resource "aws_cloudtrail" "organization" {
  name                          = "org-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  s3_key_prefix                 = "cloudtrail"
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_logging                = true
  enable_log_file_validation    = true
  kms_key_id                    = aws_kms_key.cloudtrail.arn

  cloud_watch_logs_group_arn = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn  = aws_iam_role.cloudtrail_cw.arn

  event_selector {
    read_write_type           = "All"
    include_management_events = true

    data_resource {
      type   = "AWS::S3::Object"
      values = ["arn:aws:s3"]
    }

    data_resource {
      type   = "AWS::Lambda::Function"
      values = ["arn:aws:lambda"]
    }
  }

  insight_selector {
    insight_type = "ApiCallRateInsight"
  }

  insight_selector {
    insight_type = "ApiErrorRateInsight"
  }
}
```

---

## Lambda

### CKV_AWS_45 — Lambda environment variables not containing secrets (CRITICAL)

Never put secrets directly in Lambda environment variables.

```hcl
# BAD
resource "aws_lambda_function" "app" {
  environment {
    variables = {
      DB_PASSWORD = "my-secret-password"
    }
  }
}

# GOOD - reference Secrets Manager
resource "aws_lambda_function" "app" {
  environment {
    variables = {
      DB_SECRET_ARN = aws_secretsmanager_secret.db.arn
    }
  }
}
```

### CKV_AWS_115 — Lambda concurrency limits (MEDIUM)

```hcl
resource "aws_lambda_function" "app" {
  reserved_concurrent_executions = 100
}
```

### CKV_AWS_116 — Lambda DLQ configured (MEDIUM)

```hcl
resource "aws_lambda_function" "app" {
  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }
}
```

### CKV_AWS_117 — Lambda in VPC (MEDIUM)

```hcl
resource "aws_lambda_function" "app" {
  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }
}
```

### CKV_AWS_272 — Lambda code signing (HIGH)

```hcl
resource "aws_lambda_function" "app" {
  code_signing_config_arn = aws_lambda_code_signing_config.config.arn
}
```

### CKV_AWS_173 — Lambda env vars encrypted with CMK (MEDIUM)

```hcl
resource "aws_lambda_function" "app" {
  kms_key_arn = aws_kms_key.lambda.arn
}
```

---

## CloudWatch and monitoring

### CKV_AWS_158 — CloudWatch Log Group encryption (MEDIUM)

```hcl
resource "aws_cloudwatch_log_group" "app" {
  name              = "/app/my-app"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.logs.arn
}
```

### CKV_AWS_66 — CloudWatch Log Group retention (MEDIUM)

Always set retention. Never keep logs forever.

```hcl
resource "aws_cloudwatch_log_group" "app" {
  retention_in_days = 90    # 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653
}
```

---

## DynamoDB

### CKV_AWS_28 — DynamoDB point-in-time recovery (HIGH)

```hcl
resource "aws_dynamodb_table" "table" {
  point_in_time_recovery {
    enabled = true
  }
}
```

### CKV_AWS_119 — DynamoDB encryption with CMK (MEDIUM)

```hcl
resource "aws_dynamodb_table" "table" {
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.dynamodb.arn
  }
}
```

---

## ECR

### CKV_AWS_163 — ECR image scanning (HIGH)

```hcl
resource "aws_ecr_repository" "app" {
  image_scanning_configuration {
    scan_on_push = true
  }
}
```

### CKV_AWS_136 — ECR immutable tags (HIGH)

```hcl
resource "aws_ecr_repository" "app" {
  image_tag_mutability = "IMMUTABLE"
}
```

### CKV_AWS_51 — ECR encryption with CMK (MEDIUM)

```hcl
resource "aws_ecr_repository" "app" {
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.ecr.arn
  }
}
```

### ECR lifecycle policy

```hcl
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 30 images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v"]
          countType     = "imageCountMoreThan"
          countNumber   = 30
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
```

---

## KMS

### CKV_AWS_7 — KMS key rotation enabled (HIGH)

```hcl
resource "aws_kms_key" "key" {
  description             = "KMS key for encrypting application data"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = data.aws_iam_policy_document.kms_policy.json
}
```

### KMS key policy best practice

```hcl
data "aws_iam_policy_document" "kms_policy" {
  # Allow account root to administer the key
  statement {
    sid    = "EnableRootAccountPermissions"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  # Allow specific roles to use the key
  statement {
    sid    = "AllowKeyUsage"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.app.arn]
    }
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = ["*"]
  }
}
```

---

## ALB / ELB

### CKV_AWS_91 — ELB access logging (MEDIUM)

```hcl
resource "aws_lb" "app" {
  access_logs {
    bucket  = aws_s3_bucket.lb_logs.id
    prefix  = "alb-logs"
    enabled = true
  }
}
```

### CKV_AWS_150 — ALB deletion protection (MEDIUM)

```hcl
resource "aws_lb" "app" {
  enable_deletion_protection = true
}
```

### CKV_AWS_131 — ALB drop invalid headers (MEDIUM)

```hcl
resource "aws_lb" "app" {
  drop_invalid_header_fields = true
}
```

### AVD-AWS-0053 — ALB listener uses HTTPS (HIGH)

```hcl
# Redirect HTTP to HTTPS
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.app.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
```

### CKV_AWS_103 — Use TLS 1.2+ SSL policy (HIGH)

Approved SSL policies (TLS 1.2+):
- `ELBSecurityPolicy-TLS13-1-2-2021-06` (recommended)
- `ELBSecurityPolicy-TLS-1-2-2017-01`
- `ELBSecurityPolicy-TLS-1-2-Ext-2018-06`

---

## WAF

### CKV_AWS_176 — WAFv2 associated with resources (HIGH)

```hcl
resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.app.arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}
```

### WAFv2 with managed rules

```hcl
resource "aws_wafv2_web_acl" "main" {
  name  = "app-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  # AWS Managed Rules - Core Rule Set
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1
    override_action { none {} }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules - Known Bad Inputs
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2
    override_action { none {} }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesKnownBadInputsRuleSet"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "app-waf"
    sampled_requests_enabled   = true
  }
}
```

---

## Secrets Manager

### CKV_AWS_149 — Secrets Manager CMK encryption (MEDIUM)

```hcl
resource "aws_secretsmanager_secret" "db" {
  name       = "my-app/db-password"
  kms_key_id = aws_kms_key.secrets.arn

  # Automatic rotation
  # rotation_lambda_arn = aws_lambda_function.rotate_secret.arn
  # rotation_rules {
  #   automatically_after_days = 30
  # }
}
```

---

## Config and GuardDuty

### CKV2_AWS_16 — AWS Config enabled (HIGH)

```hcl
resource "aws_config_configuration_recorder" "main" {
  name     = "default"
  role_arn = aws_iam_role.config.arn

  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

resource "aws_config_configuration_recorder_status" "main" {
  name       = aws_config_configuration_recorder.main.name
  is_enabled = true
}
```

### CKV2_AWS_3 — GuardDuty enabled (HIGH)

```hcl
resource "aws_guardduty_detector" "main" {
  enable = true

  datasources {
    s3_logs {
      enable = true
    }
    kubernetes {
      audit_logs {
        enable = true
      }
    }
    malware_protection {
      scan_ec2_instance_with_findings {
        ebs_volumes {
          enable = true
        }
      }
    }
  }
}
```

---

## Tooling integration

### Checkov
```bash
# Install
pip install checkov

# Scan entire directory
checkov -d . --framework terraform

# Scan with specific checks
checkov -d . --framework terraform --check CKV_AWS_79,CKV_AWS_88,CKV_AWS_130

# Skip specific checks (with justification)
checkov -d . --framework terraform --skip-check CKV_AWS_135

# Output formats for CI
checkov -d . --framework terraform --output json --output-file checkov-results.json
checkov -d . --framework terraform --output sarif --output-file checkov-results.sarif

# Scan plan file for graph-based checks
tofu plan -out=plan.tfplan
tofu show -json plan.tfplan > plan.json
checkov -f plan.json --framework terraform_plan
```

### Trivy
```bash
# Install
brew install trivy

# Scan Terraform directory
trivy config . --severity HIGH,CRITICAL

# Output formats
trivy config . --format sarif --output trivy-results.sarif
trivy config . --format json --output trivy-results.json
```

### TFLint with AWS plugin
```hcl
# .tflint.hcl
plugin "aws" {
  enabled = true
  version = "0.32.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
```

### Recommended CI pipeline
```yaml
- name: OpenTofu Format
  run: tofu fmt -check -recursive

- name: OpenTofu Validate
  run: tofu validate

- name: TFLint
  run: tflint --recursive --format compact

- name: Checkov
  run: |
    checkov -d . --framework terraform \
      --output cli --compact \
      --soft-fail-on CKV_AWS_135,CKV_AWS_126

- name: Trivy
  run: |
    trivy config . \
      --severity HIGH,CRITICAL \
      --exit-code 1
```

---

## Checklist for AWS OpenTofu configurations

**Compute (EC2/EKS/Lambda):**
- [ ] IMDSv2 required on all instances (CKV_AWS_79)
- [ ] No public IPs on instances (CKV_AWS_88)
- [ ] EBS volumes encrypted with CMK (CKV_AWS_8)
- [ ] EKS public endpoint disabled or restricted (CKV_AWS_38)
- [ ] EKS control plane logging enabled (CKV_AWS_37)
- [ ] EKS secrets encryption enabled (CKV_AWS_58)
- [ ] Lambda in VPC (CKV_AWS_117)
- [ ] Lambda DLQ configured (CKV_AWS_116)
- [ ] Lambda concurrency limits set (CKV_AWS_115)
- [ ] Lambda env vars encrypted with CMK (CKV_AWS_173)
- [ ] No secrets in Lambda env vars (CKV_AWS_45)

**Networking:**
- [ ] VPC flow logs enabled (CKV2_AWS_11)
- [ ] Default security group restricts all traffic (CKV2_AWS_12)
- [ ] Private subnets don't auto-assign public IPs (CKV_AWS_130)
- [ ] Security group egress restricted (AVD-AWS-0102)

**IAM:**
- [ ] Policies attached to groups/roles, not users (CKV_AWS_40)
- [ ] No wildcard principals in assume role (CKV_AWS_61)
- [ ] No privilege escalation paths (CKV_AWS_109/110)
- [ ] Write actions have conditions (CKV_AWS_111)
- [ ] MFA enforced for users (CKV2_AWS_21)
- [ ] No access keys for IAM users (CKV_AWS_273)

**Storage (S3/EBS/EFS):**
- [ ] S3 access logging enabled (CKV_AWS_18)
- [ ] S3 encrypted with CMK (CKV_AWS_145)
- [ ] S3 public access block enabled (CKV2_AWS_6)
- [ ] S3 lifecycle configuration set (CKV2_AWS_61)
- [ ] S3 versioning enabled
- [ ] S3 HTTPS enforced via bucket policy

**Database (RDS/DynamoDB):**
- [ ] RDS multi-AZ (CKV_AWS_157)
- [ ] RDS encryption at rest (CKV_AWS_16)
- [ ] RDS not publicly accessible (CKV2_AWS_30)
- [ ] RDS deletion protection (CKV_AWS_133)
- [ ] RDS IAM auth enabled (CKV_AWS_161)
- [ ] RDS enhanced monitoring (CKV_AWS_118)
- [ ] RDS Performance Insights with CMK (CKV_AWS_354)
- [ ] RDS backup retention >= 7 days
- [ ] DynamoDB PITR enabled (CKV_AWS_28)
- [ ] DynamoDB CMK encryption (CKV_AWS_119)

**Logging and monitoring:**
- [ ] CloudTrail multi-region with log validation (CKV_AWS_67/36)
- [ ] CloudTrail encrypted with CMK (CKV_AWS_35)
- [ ] CloudWatch Log Groups encrypted (CKV_AWS_158)
- [ ] CloudWatch Log Groups have retention (CKV_AWS_66)
- [ ] AWS Config enabled (CKV2_AWS_16)
- [ ] GuardDuty enabled (CKV2_AWS_3)

**Load balancing:**
- [ ] ALB access logging enabled (CKV_AWS_91)
- [ ] ALB deletion protection (CKV_AWS_150)
- [ ] ALB drops invalid headers (CKV_AWS_131)
- [ ] ALB uses TLS 1.2+ policy (CKV_AWS_103)
- [ ] HTTP to HTTPS redirect configured
- [ ] WAFv2 associated with ALB (CKV_AWS_176)

**Encryption:**
- [ ] KMS key rotation enabled (CKV_AWS_7)
- [ ] Secrets Manager uses CMK (CKV_AWS_149)
- [ ] ECR encryption with CMK (CKV_AWS_51)

**Container registry (ECR):**
- [ ] Image scanning on push (CKV_AWS_163)
- [ ] Immutable tags (CKV_AWS_136)
- [ ] Lifecycle policy configured
