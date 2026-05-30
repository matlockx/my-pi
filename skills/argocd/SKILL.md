---
name: argocd
description: Write and review ArgoCD Application and AppProject manifests following security hardening, Checkov rules, and GitOps best practices
---

## What I do

Guide writing and reviewing ArgoCD Application, ApplicationSet, and AppProject manifests that follow security hardening best practices, pass Checkov checks (CKV_ARGO_*), and implement sound GitOps patterns. Also covers ArgoCD server configuration hardening.

## When to use me

Use this skill when:
- Writing new ArgoCD Application or AppProject manifests
- Reviewing ArgoCD configurations for security issues
- Hardening an ArgoCD installation
- Setting up ArgoCD RBAC and access control
- Configuring ArgoCD sync policies and automation
- Fixing Checkov findings in ArgoCD manifests

---

## Checkov ArgoCD rules

### CKV_ARGO_1 — Application must use a named project, not `default` (MEDIUM)

Every ArgoCD Application must reference a specific AppProject, never `default`.

```yaml
# BAD
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  project: default    # default project has no restrictions
  source:
    repoURL: https://github.com/org/repo
    path: k8s/
    targetRevision: HEAD
  destination:
    server: https://kubernetes.default.svc
    namespace: my-app

# GOOD
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  project: my-team-project    # scoped project with restrictions
  source:
    repoURL: https://github.com/org/repo
    path: k8s/
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: my-app
```

### CKV_ARGO_2 — Application must not use wildcard destination server (HIGH)

Do not use `*` as the destination server. Always specify the exact cluster.

```yaml
# BAD
spec:
  destination:
    server: "*"
    namespace: my-app

# GOOD
spec:
  destination:
    server: https://kubernetes.default.svc
    namespace: my-app
# or use cluster name
spec:
  destination:
    name: production-cluster
    namespace: my-app
```

### CKV_ARGO_3 — Application must not use wildcard destination namespace (HIGH)

Do not use `*` as the destination namespace. Always specify an explicit namespace.

```yaml
# BAD
spec:
  destination:
    server: https://kubernetes.default.svc
    namespace: "*"

# GOOD
spec:
  destination:
    server: https://kubernetes.default.svc
    namespace: my-app
```

---

## AppProject security rules

### Restrict source repositories

Only allow specific, trusted repositories.

```yaml
# BAD
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: my-team
  namespace: argocd
spec:
  sourceRepos:
    - "*"    # allows any repository

# GOOD
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: my-team
  namespace: argocd
spec:
  sourceRepos:
    - "https://github.com/my-org/app-repo.git"
    - "https://github.com/my-org/helm-charts.git"
    - "https://charts.example.com"
```

### Restrict destination clusters and namespaces

```yaml
# BAD
spec:
  destinations:
    - server: "*"
      namespace: "*"

# GOOD
spec:
  destinations:
    - server: https://kubernetes.default.svc
      namespace: my-team-staging
    - server: https://kubernetes.default.svc
      namespace: my-team-production
```

### Restrict allowed resource kinds

Prevent teams from deploying cluster-scoped or dangerous resources.

```yaml
spec:
  # Allow only namespace-scoped resources
  namespaceResourceWhitelist:
    - group: ""
      kind: ConfigMap
    - group: ""
      kind: Secret
    - group: ""
      kind: Service
    - group: ""
      kind: ServiceAccount
    - group: apps
      kind: Deployment
    - group: apps
      kind: StatefulSet
    - group: networking.k8s.io
      kind: Ingress
    - group: networking.k8s.io
      kind: NetworkPolicy
    - group: policy
      kind: PodDisruptionBudget
    - group: autoscaling
      kind: HorizontalPodAutoscaler
    - group: batch
      kind: CronJob
    - group: batch
      kind: Job

  # Deny cluster-scoped resources
  clusterResourceWhitelist: []
  # Or selectively allow:
  # clusterResourceWhitelist:
  #   - group: ""
  #     kind: Namespace
```

### Restrict orphaned resource monitoring

```yaml
spec:
  orphanedResources:
    warn: true
    ignore:
      - group: ""
        kind: ConfigMap
        name: "kube-root-ca.crt"
```

### Complete AppProject example

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: my-team
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  description: "My Team's applications"

  sourceRepos:
    - "https://github.com/my-org/app-repo.git"
    - "https://github.com/my-org/helm-charts.git"

  destinations:
    - server: https://kubernetes.default.svc
      namespace: my-team-*

  namespaceResourceWhitelist:
    - group: ""
      kind: ConfigMap
    - group: ""
      kind: Secret
    - group: ""
      kind: Service
    - group: ""
      kind: ServiceAccount
    - group: apps
      kind: Deployment
    - group: apps
      kind: StatefulSet
    - group: networking.k8s.io
      kind: Ingress
    - group: policy
      kind: PodDisruptionBudget

  clusterResourceWhitelist: []

  orphanedResources:
    warn: true

  roles:
    - name: developer
      description: "Read-only access for developers"
      policies:
        - p, proj:my-team:developer, applications, get, my-team/*, allow
        - p, proj:my-team:developer, applications, sync, my-team/*, allow
      groups:
        - my-org:my-team-developers

    - name: admin
      description: "Full access for team admins"
      policies:
        - p, proj:my-team:admin, applications, *, my-team/*, allow
      groups:
        - my-org:my-team-admins
```

---

## Application best practices

### Pin targetRevision — never use HEAD

```yaml
# BAD
spec:
  source:
    targetRevision: HEAD    # tracks latest commit, unpredictable

# GOOD - pin to branch for non-prod
spec:
  source:
    targetRevision: main

# BEST - pin to tag or commit SHA for production
spec:
  source:
    targetRevision: v1.2.3
# or
spec:
  source:
    targetRevision: abc1234def5678
```

### Configure sync policy

```yaml
spec:
  syncPolicy:
    automated:
      prune: true        # remove resources not in Git
      selfHeal: true     # revert manual changes
      allowEmpty: false  # prevent sync if source is empty
    syncOptions:
      - CreateNamespace=false   # don't auto-create namespaces
      - PrunePropagationPolicy=foreground
      - PruneLast=true          # prune after all other syncs
      - ApplyOutOfSyncOnly=true # only apply changed resources
      - Validate=true           # validate manifests before apply
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m0s
```

### Use server-side apply for large resources

```yaml
spec:
  syncPolicy:
    syncOptions:
      - ServerSideApply=true
```

### Configure ignoreDifferences for managed fields

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas   # managed by HPA
    - group: ""
      kind: Service
      jqPathExpressions:
        - .spec.clusterIP
```

### Use multiple sources (Helm + values from Git)

```yaml
spec:
  sources:
    - repoURL: https://charts.example.com
      chart: my-app
      targetRevision: 1.2.3
      helm:
        valueFiles:
          - $values/environments/production/values.yaml
    - repoURL: https://github.com/my-org/app-config.git
      targetRevision: main
      ref: values
```

### Complete Application example

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app-production
  namespace: argocd
  labels:
    app.kubernetes.io/name: my-app
    app.kubernetes.io/instance: production
    app.kubernetes.io/part-of: my-platform
    app.kubernetes.io/managed-by: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: my-team

  sources:
    - repoURL: https://github.com/my-org/helm-charts.git
      path: charts/my-app
      targetRevision: v1.2.3
      helm:
        valueFiles:
          - $values/environments/production/values.yaml
        parameters:
          - name: image.tag
            value: "1.2.3"
    - repoURL: https://github.com/my-org/app-config.git
      targetRevision: main
      ref: values

  destination:
    server: https://kubernetes.default.svc
    namespace: my-app-production

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=false
      - PrunePropagationPolicy=foreground
      - PruneLast=true
      - Validate=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m0s

  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
```

---

## ApplicationSet best practices

### Use generators with explicit filtering

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: my-app
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/my-org/app-config.git
        revision: main
        directories:
          - path: "environments/*"
            exclude: false
          - path: "environments/experimental"
            exclude: true    # explicitly exclude non-production paths

  template:
    metadata:
      name: "my-app-{{path.basename}}"
      labels:
        app.kubernetes.io/name: my-app
        environment: "{{path.basename}}"
    spec:
      project: my-team
      source:
        repoURL: https://github.com/my-org/helm-charts.git
        path: charts/my-app
        targetRevision: main
        helm:
          valueFiles:
            - "../../app-config/{{path}}/values.yaml"
      destination:
        server: https://kubernetes.default.svc
        namespace: "my-app-{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Progressive sync with waves

```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "0"    # namespaces, CRDs
---
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "1"    # config, secrets
---
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "2"    # deployments
---
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "3"    # ingress, monitoring
```

---

## ArgoCD server hardening

### Disable admin account

```yaml
# argocd-cm ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  admin.enabled: "false"    # disable local admin
  accounts.admin.enabled: "false"
```

### Configure SSO/OIDC

```yaml
# argocd-cm ConfigMap
data:
  url: https://argocd.example.com
  oidc.config: |
    name: Okta
    issuer: https://example.okta.com/oauth2/default
    clientID: $oidc.clientID           # from argocd-secret
    clientSecret: $oidc.clientSecret   # from argocd-secret
    requestedScopes:
      - openid
      - profile
      - email
      - groups
```

### Configure RBAC with least privilege

```yaml
# argocd-rbac-cm ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  # Default: no access
  policy.default: role:readonly

  # Explicit role definitions
  policy.csv: |
    # Developers: read-only + sync
    p, role:developer, applications, get, */*, allow
    p, role:developer, applications, sync, */*, allow
    p, role:developer, logs, get, */*, allow

    # Team leads: manage apps in their project
    p, role:team-lead, applications, *, my-team/*, allow
    p, role:team-lead, repositories, get, *, allow

    # Platform team: full access
    p, role:platform-admin, applications, *, */*, allow
    p, role:platform-admin, clusters, *, *, allow
    p, role:platform-admin, repositories, *, *, allow
    p, role:platform-admin, projects, *, *, allow

    # Group mappings
    g, my-org:developers, role:developer
    g, my-org:team-leads, role:team-lead
    g, my-org:platform, role:platform-admin

  # Scoped accounts (for CI/CD)
  policy.matchMode: glob
```

### Enable audit logging

```yaml
# argocd-cmd-params-cm ConfigMap
data:
  server.log.level: info
  server.log.format: json
  controller.log.level: info
  reposerver.log.level: info
```

### Secure argocd-server deployment

```yaml
# Enforce TLS
data:
  server.insecure: "false"    # do NOT set to true

# In argocd-cmd-params-cm
data:
  server.rootpath: ""
  server.basehref: /
  server.enable.gzip: "true"

# Resource limits for ArgoCD components
# Apply to argocd-server, argocd-repo-server, argocd-application-controller
resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

### Network policies for ArgoCD

```yaml
# Restrict argocd-repo-server network access
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: argocd-repo-server
  namespace: argocd
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: argocd-repo-server
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: argocd-server
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: argocd-application-controller
      ports:
        - port: 8081
          protocol: TCP
  egress:
    - to: []
      ports:
        - port: 443    # Git over HTTPS
          protocol: TCP
        - port: 22     # Git over SSH
          protocol: TCP
```

### Secrets management

Never store secrets directly in Git repos synced by ArgoCD. Use:

1. **Sealed Secrets** — encrypt secrets in Git, decrypt in-cluster
2. **External Secrets Operator** — sync from AWS Secrets Manager, Vault, etc.
3. **Vault with ArgoCD Vault Plugin (AVP)** — inject secrets during rendering
4. **SOPS** — encrypt secret files in Git

```yaml
# Example: ArgoCD Vault Plugin annotation
apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  annotations:
    avp.kubernetes.io/path: "secret/data/myapp"
type: Opaque
stringData:
  password: <password>   # replaced by AVP at sync time
```

---

## Custom OPA/Rego policies for ArgoCD

Since Checkov only has 3 built-in rules, use OPA/Conftest for additional checks.

### Policy: targetRevision must not be HEAD

```rego
# policy/argocd/target_revision.rego
package argocd

deny[msg] {
    input.kind == "Application"
    input.spec.source.targetRevision == "HEAD"
    msg := sprintf("Application '%s' uses targetRevision HEAD - pin to a branch, tag, or commit SHA", [input.metadata.name])
}

deny[msg] {
    input.kind == "Application"
    source := input.spec.sources[_]
    source.targetRevision == "HEAD"
    msg := sprintf("Application '%s' has a source with targetRevision HEAD - pin to a branch, tag, or commit SHA", [input.metadata.name])
}
```

### Policy: sourceRepos must not be wildcard

```rego
# policy/argocd/source_repos.rego
package argocd

deny[msg] {
    input.kind == "AppProject"
    input.spec.sourceRepos[_] == "*"
    msg := sprintf("AppProject '%s' allows all source repositories (wildcard *)", [input.metadata.name])
}
```

### Policy: Applications must have sync retry configured

```rego
# policy/argocd/sync_retry.rego
package argocd

deny[msg] {
    input.kind == "Application"
    not input.spec.syncPolicy.retry
    msg := sprintf("Application '%s' has no sync retry policy configured", [input.metadata.name])
}
```

### Policy: Applications must have finalizers

```rego
# policy/argocd/finalizers.rego
package argocd

deny[msg] {
    input.kind == "Application"
    not has_finalizer
    msg := sprintf("Application '%s' is missing resources-finalizer.argocd.argoproj.io", [input.metadata.name])
}

has_finalizer {
    input.metadata.finalizers[_] == "resources-finalizer.argocd.argoproj.io"
}
```

### Running Conftest against ArgoCD manifests

```bash
# Install conftest
brew install conftest

# Test ArgoCD manifests
conftest test argocd-apps/ --policy policy/argocd/ --all-namespaces

# In CI
conftest test argocd-apps/ --policy policy/argocd/ --output json --all-namespaces
```

---

## Tooling integration

### Checkov
```bash
# Scan ArgoCD manifests
checkov -d ./argocd-apps/ --framework kubernetes --check CKV_ARGO_1,CKV_ARGO_2,CKV_ARGO_3

# Scan all Kubernetes + ArgoCD checks
checkov -d ./argocd-apps/ --framework kubernetes
```

### Conftest (OPA)
```bash
conftest test ./argocd-apps/ --policy ./policy/argocd/
```

### Kubescape
```bash
# Scan ArgoCD namespace
kubescape scan framework nsa --include-namespaces argocd

# Scan specific control
kubescape scan control C-0035 --include-namespaces argocd
```

### CI pipeline example
```yaml
- name: Checkov ArgoCD
  run: |
    checkov -d ./argocd-apps/ --framework kubernetes \
      --check CKV_ARGO_1,CKV_ARGO_2,CKV_ARGO_3 \
      --output cli --compact

- name: Conftest ArgoCD Policies
  run: |
    conftest test ./argocd-apps/ \
      --policy ./policy/argocd/ \
      --all-namespaces \
      --output stdout
```

---

## Checklist for ArgoCD configurations

**Applications:**
- [ ] Uses a named project, not `default` (CKV_ARGO_1)
- [ ] Destination server is explicit, not `*` (CKV_ARGO_2)
- [ ] Destination namespace is explicit, not `*` (CKV_ARGO_3)
- [ ] `targetRevision` is pinned (not `HEAD`)
- [ ] Sync policy configured (automated with prune + selfHeal for non-prod, manual for prod)
- [ ] Retry policy configured
- [ ] `resources-finalizer.argocd.argoproj.io` finalizer present
- [ ] `ignoreDifferences` set for HPA-managed replicas and other managed fields
- [ ] Labels applied (app.kubernetes.io/*)
- [ ] `CreateNamespace=false` in syncOptions

**AppProjects:**
- [ ] `sourceRepos` restricted to specific repos (not `*`)
- [ ] `destinations` restricted to specific clusters and namespaces (not `*`)
- [ ] `namespaceResourceWhitelist` restricts allowed resource kinds
- [ ] `clusterResourceWhitelist` is empty or minimal
- [ ] Roles defined with least-privilege policies
- [ ] Orphaned resource monitoring enabled

**Server hardening:**
- [ ] Admin account disabled
- [ ] SSO/OIDC configured
- [ ] RBAC configured with `policy.default: role:readonly`
- [ ] TLS enabled (`server.insecure: "false"`)
- [ ] Audit logging enabled (JSON format)
- [ ] Network policies restrict component communication
- [ ] Resource limits set on all ArgoCD components
- [ ] Secrets managed via Sealed Secrets / External Secrets / Vault

**GitOps practices:**
- [ ] No secrets stored in plain text in Git
- [ ] Sync waves used for dependency ordering
- [ ] ApplicationSets use explicit path filtering
- [ ] Production uses manual sync or pinned revisions
