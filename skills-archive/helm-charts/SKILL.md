---
name: helm-charts
description: Write and review Helm charts following security, reliability, and best practice rules from kube-linter, Polaris, Checkov, and Trivy
---

## What I do

Guide writing and reviewing Helm charts that pass security and best-practice checks from kube-linter, Polaris, Checkov (CKV_K8S_*), and Trivy. Covers pod security, resource management, networking, image hygiene, and Kubernetes API compatibility.

## When to use me

Use this skill when:
- Writing new Helm charts or templates
- Reviewing or refactoring existing Helm charts
- Fixing kube-linter, Polaris, Checkov, or Trivy findings in Helm charts
- Preparing Helm charts for CI/CD pipelines with security scanning
- Upgrading Helm charts for new Kubernetes versions

---

## Chart structure best practices

### Standard layout
```
mychart/
  Chart.yaml            # Chart metadata (required)
  Chart.lock            # Dependency lock file
  values.yaml           # Default configuration values
  values.schema.json    # JSON Schema for values validation
  templates/
    _helpers.tpl        # Template helpers/partials
    deployment.yaml
    service.yaml
    serviceaccount.yaml
    ingress.yaml
    hpa.yaml
    pdb.yaml
    networkpolicy.yaml
    configmap.yaml
    secret.yaml
    NOTES.txt           # Post-install notes
  tests/
    test-connection.yaml
  ci/
    ci-values.yaml      # Values for CI testing
```

### Chart.yaml requirements
```yaml
apiVersion: v2
name: mychart
description: A concise description of the chart
type: application
version: 1.0.0           # SemVer - bump on every change
appVersion: "1.0.0"       # Version of the app being deployed
maintainers:
  - name: Team Name
    email: team@example.com
```

### values.yaml conventions
- Provide sensible, secure defaults
- Comment only non-obvious values
- Never include secrets in default values
- Use `null` or empty string for optional values that should be explicitly set

---

## Pod security rules

### CKV_K8S_1 / kube-linter no-privileged / Polaris privilegeEscalationAllowed — No privileged containers (CRITICAL)

Containers must not run in privileged mode.

```yaml
# BAD
containers:
  - name: app
    securityContext:
      privileged: true

# GOOD
containers:
  - name: app
    securityContext:
      privileged: false
      allowPrivilegeEscalation: false
```

### CKV_K8S_20 / Polaris runAsRootAllowed — Do not run as root (HIGH)

Containers should run as a non-root user.

```yaml
# BAD
containers:
  - name: app
    securityContext:
      runAsUser: 0

# GOOD
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    fsGroup: 65534
  containers:
    - name: app
      securityContext:
        runAsNonRoot: true
        allowPrivilegeEscalation: false
```

### CKV_K8S_6 / CKV_K8S_22 / kube-linter no-read-only-root-fs / Polaris notReadOnlyRootFilesystem — Read-only root filesystem (HIGH)

Use a read-only root filesystem. Mount writable volumes only where needed.

```yaml
# BAD
containers:
  - name: app
    securityContext: {}

# GOOD
containers:
  - name: app
    securityContext:
      readOnlyRootFilesystem: true
    volumeMounts:
      - name: tmp
        mountPath: /tmp
      - name: cache
        mountPath: /var/cache
volumes:
  - name: tmp
    emptyDir: {}
  - name: cache
    emptyDir: {}
```

### CKV_K8S_28 / CKV_K8S_37 / kube-linter drop-net-raw-capability — Drop all capabilities (HIGH)

Drop all Linux capabilities and add back only what is strictly needed.

```yaml
# BAD
containers:
  - name: app
    securityContext:
      capabilities:
        add: ["NET_ADMIN", "SYS_ADMIN"]

# GOOD
containers:
  - name: app
    securityContext:
      capabilities:
        drop: ["ALL"]
        # add: ["NET_BIND_SERVICE"]  # only if truly needed
```

### Polaris hostNetworkSet / hostPIDSet / hostPortSet — No host namespace sharing (HIGH)

Do not use host network, host PID, or host ports.

```yaml
# BAD
spec:
  hostNetwork: true
  hostPID: true
  containers:
    - name: app
      ports:
        - containerPort: 80
          hostPort: 80

# GOOD
spec:
  hostNetwork: false
  hostPID: false
  containers:
    - name: app
      ports:
        - containerPort: 80
```

### CKV_K8S_3 — Do not use default service account (MEDIUM)

Create and use a dedicated service account. Disable token auto-mounting unless required.

```yaml
# BAD - uses default service account
spec:
  containers:
    - name: app

# GOOD
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "mychart.serviceAccountName" . }}
  annotations:
    # Add cloud provider annotations if needed
automountServiceAccountToken: false
---
spec:
  serviceAccountName: {{ include "mychart.serviceAccountName" . }}
  automountServiceAccountToken: false  # or true only if API access needed
```

### CKV_K8S_21 — Do not use the default namespace (MEDIUM)

Always deploy to a specific namespace, never `default`.

```yaml
# BAD
metadata:
  namespace: default

# GOOD
metadata:
  namespace: {{ .Release.Namespace }}
```

### Complete secure pod spec template

```yaml
spec:
  serviceAccountName: {{ include "mychart.serviceAccountName" . }}
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    fsGroup: 65534
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: {{ .Chart.Name }}
      image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      securityContext:
        allowPrivilegeEscalation: false
        privileged: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      ports:
        - name: http
          containerPort: {{ .Values.service.port }}
          protocol: TCP
      resources:
        requests:
          cpu: {{ .Values.resources.requests.cpu }}
          memory: {{ .Values.resources.requests.memory }}
        limits:
          cpu: {{ .Values.resources.limits.cpu }}
          memory: {{ .Values.resources.limits.memory }}
      livenessProbe:
        httpGet:
          path: /healthz
          port: http
        initialDelaySeconds: 15
        periodSeconds: 10
      readinessProbe:
        httpGet:
          path: /readyz
          port: http
        initialDelaySeconds: 5
        periodSeconds: 5
      volumeMounts:
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tmp
      emptyDir: {}
```

---

## Resource management rules

### CKV_K8S_11 / CKV_K8S_12 / CKV_K8S_13 / Polaris cpuRequestsMissing / memoryLimitsMissing / kube-linter cpu-requirements / memory-requirements — Set resource requests and limits (HIGH)

Every container must have CPU and memory requests and limits defined.

```yaml
# BAD
containers:
  - name: app
    image: myapp:1.0.0

# GOOD
containers:
  - name: app
    image: myapp:1.0.0
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

In `values.yaml`, always provide defaults:
```yaml
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

---

## Health check rules

### CKV_K8S_8 / Polaris livenessProbeMissing / kube-linter liveness-probe — Liveness probe required (HIGH)

### CKV_K8S_9 / Polaris readinessProbeMissing / kube-linter readiness-probe — Readiness probe required (HIGH)

Every container must have both liveness and readiness probes.

```yaml
# BAD
containers:
  - name: app

# GOOD
containers:
  - name: app
    livenessProbe:
      httpGet:
        path: /healthz
        port: http
      initialDelaySeconds: 15
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3
    readinessProbe:
      httpGet:
        path: /readyz
        port: http
      initialDelaySeconds: 5
      periodSeconds: 5
      timeoutSeconds: 3
      failureThreshold: 3
    startupProbe:             # recommended for slow-starting apps
      httpGet:
        path: /healthz
        port: http
      failureThreshold: 30
      periodSeconds: 10
```

---

## Image hygiene rules

### CKV_K8S_14 / Polaris tagNotSpecified / kube-linter no-latest-tag — Pin image tags (HIGH)

Never use `latest` or omit the image tag. Always pin to a specific version.

```yaml
# BAD
image: nginx
image: nginx:latest
image: myapp

# GOOD
image: nginx:1.25.3
image: myapp:1.0.0-sha-abc1234
```

In templates:
```yaml
image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
```

### CKV_K8S_43 — Use image digests (MEDIUM, recommended)

For maximum reproducibility, use image digests.

```yaml
# BEST
image: nginx@sha256:abc123def456...
```

### Polaris pullPolicyNotAlways — Set imagePullPolicy (MEDIUM)

Explicitly set `imagePullPolicy`. Use `Always` for mutable tags, `IfNotPresent` for immutable tags.

```yaml
# GOOD
containers:
  - name: app
    image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
    imagePullPolicy: {{ .Values.image.pullPolicy | default "IfNotPresent" }}
```

---

## Networking rules

### kube-linter dangling-service — No dangling services (MEDIUM)

Services must have matching pods via label selectors.

```yaml
# Ensure service selector matches pod labels
apiVersion: v1
kind: Service
metadata:
  name: {{ include "mychart.fullname" . }}
  labels:
    {{- include "mychart.labels" . | nindent 4 }}
spec:
  selector:
    {{- include "mychart.selectorLabels" . | nindent 4 }}
```

### kube-linter ssh-port — No SSH port exposed (MEDIUM)

Do not expose port 22 (SSH) in containers. Use `kubectl exec` or debug containers instead.

```yaml
# BAD
ports:
  - containerPort: 22

# GOOD - no SSH port
ports:
  - containerPort: 8080
    name: http
```

### Network policies

Always include a NetworkPolicy to restrict traffic.

```yaml
{{- if .Values.networkPolicy.enabled }}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "mychart.fullname" . }}
spec:
  podSelector:
    matchLabels:
      {{- include "mychart.selectorLabels" . | nindent 6 }}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - port: {{ .Values.service.port }}
          protocol: TCP
  egress:
    - to: []   # customize per application needs
      ports:
        - port: 443
          protocol: TCP
{{- end }}
```

---

## Availability and resilience rules

### PodDisruptionBudget

Always include a PDB for production workloads.

```yaml
{{- if .Values.podDisruptionBudget.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "mychart.fullname" . }}
spec:
  selector:
    matchLabels:
      {{- include "mychart.selectorLabels" . | nindent 6 }}
  {{- if .Values.podDisruptionBudget.minAvailable }}
  minAvailable: {{ .Values.podDisruptionBudget.minAvailable }}
  {{- else }}
  maxUnavailable: {{ .Values.podDisruptionBudget.maxUnavailable | default 1 }}
  {{- end }}
{{- end }}
```

### Topology spread constraints

Spread pods across nodes and zones.

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          {{- include "mychart.selectorLabels" . | nindent 10 }}
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          {{- include "mychart.selectorLabels" . | nindent 10 }}
```

---

## Labeling standards

### Required labels (Kubernetes recommended)

```yaml
metadata:
  labels:
    app.kubernetes.io/name: {{ include "mychart.name" . }}
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
    app.kubernetes.io/component: "web"           # or api, worker, db, etc.
    app.kubernetes.io/part-of: "my-application"
    app.kubernetes.io/managed-by: {{ .Release.Service }}
    helm.sh/chart: {{ include "mychart.chart" . }}
```

---

## Secrets management

### Never hardcode secrets in templates or values

```yaml
# BAD - secret in values.yaml
database:
  password: "my-secret-password"

# GOOD - reference external secret
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "mychart.fullname" . }}-db
type: Opaque
data:
  password: {{ .Values.database.existingPasswordSecret | b64enc | quote }}

# BEST - use External Secrets Operator or Sealed Secrets
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {{ include "mychart.fullname" . }}-db
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: {{ include "mychart.fullname" . }}-db
  data:
    - secretKey: password
      remoteRef:
        key: /myapp/database/password
```

---

## Deprecated API detection (Pluto)

Always use current, stable API versions:

| Deprecated API | Replacement | Removed In |
|---------------|-------------|------------|
| `extensions/v1beta1 Ingress` | `networking.k8s.io/v1 Ingress` | 1.22 |
| `policy/v1beta1 PodDisruptionBudget` | `policy/v1 PodDisruptionBudget` | 1.25 |
| `policy/v1beta1 PodSecurityPolicy` | Removed (use Pod Security Admission) | 1.25 |
| `autoscaling/v2beta1 HPA` | `autoscaling/v2 HPA` | 1.26 |
| `flowcontrol.apiserver.k8s.io/v1beta2` | `flowcontrol.apiserver.k8s.io/v1beta3` | 1.29 |
| `batch/v1beta1 CronJob` | `batch/v1 CronJob` | 1.25 |

Use `pluto detect-helm` or `pluto detect-files` in CI to catch these.

---

## Tooling integration

### helm lint
```bash
helm lint ./mychart --strict --values ./mychart/ci/ci-values.yaml
```

### kube-linter
```bash
# Install
brew install kube-linter

# Scan chart
kube-linter lint ./mychart

# With config
kube-linter lint ./mychart --config .kube-linter.yaml
```

`.kube-linter.yaml` example:
```yaml
checks:
  addAllBuiltIn: true
  exclude:
    - "unset-cpu-requirements"  # only if justified
```

### Polaris
```bash
# Install
brew install FairwindsOps/tap/polaris

# Scan chart (renders then audits)
polaris audit --helm-chart ./mychart --format=pretty

# CI mode (exit code on failures)
polaris audit --helm-chart ./mychart --set-exit-code-on-danger --format=score
```

### Checkov
```bash
# Scan Helm chart directory
checkov -d ./mychart --framework helm

# With specific checks
checkov -d ./mychart --framework helm --check CKV_K8S_1,CKV_K8S_8,CKV_K8S_20
```

### Trivy
```bash
# Scan Helm chart for misconfigurations
trivy config ./mychart

# Scan with severity filter
trivy config ./mychart --severity HIGH,CRITICAL
```

### Pluto
```bash
# Detect deprecated APIs in chart
pluto detect-files -d ./mychart/templates

# Check against a target Kubernetes version
pluto detect-files -d ./mychart/templates --target-versions k8s=v1.29.0
```

### Recommended CI pipeline
```yaml
# GitHub Actions example
- name: Helm Lint
  run: helm lint ./mychart --strict

- name: Kube-linter
  uses: stackrox/kube-linter-action@v1
  with:
    directory: ./mychart

- name: Trivy Config Scan
  uses: aquasecurity/trivy-action@master
  with:
    scan-type: config
    scan-ref: ./mychart
    severity: HIGH,CRITICAL
    exit-code: 1

- name: Pluto Deprecation Check
  run: |
    pluto detect-files -d ./mychart/templates --target-versions k8s=v1.29.0 --output=exit-code
```

---

## Checklist for new Helm charts

**Structure:**
- [ ] `Chart.yaml` has `apiVersion: v2`, version, appVersion, description, maintainers
- [ ] `values.yaml` has defaults; non-obvious values have brief comments
- [ ] `values.schema.json` validates input values
- [ ] `_helpers.tpl` defines reusable template functions
- [ ] `NOTES.txt` provides post-install instructions
- [ ] CI values file exists for automated testing

**Security - Pod:**
- [ ] No privileged containers (CKV_K8S_1)
- [ ] `allowPrivilegeEscalation: false` (CKV_K8S_37)
- [ ] `runAsNonRoot: true` and non-root UID (CKV_K8S_20)
- [ ] `readOnlyRootFilesystem: true` (CKV_K8S_22)
- [ ] All capabilities dropped, only needed ones added (CKV_K8S_28)
- [ ] `seccompProfile.type: RuntimeDefault` set
- [ ] No host network, host PID, or host ports
- [ ] Dedicated service account, not `default` (CKV_K8S_3)
- [ ] `automountServiceAccountToken: false` unless needed
- [ ] Not deployed to `default` namespace (CKV_K8S_21)

**Security - Images:**
- [ ] Image tags pinned to specific version, not `latest` (CKV_K8S_14)
- [ ] `imagePullPolicy` explicitly set
- [ ] Image digests used where possible (CKV_K8S_43)

**Security - Network:**
- [ ] NetworkPolicy defined
- [ ] No SSH port (22) exposed
- [ ] Services have matching pod selectors

**Security - Secrets:**
- [ ] No hardcoded secrets in templates or values
- [ ] External Secrets or Sealed Secrets used for sensitive data

**Reliability:**
- [ ] Resource requests and limits set for all containers (CKV_K8S_11/12/13)
- [ ] Liveness probe defined (CKV_K8S_8)
- [ ] Readiness probe defined (CKV_K8S_9)
- [ ] PodDisruptionBudget defined for production workloads
- [ ] Topology spread constraints configured

**Maintainability:**
- [ ] Standard Kubernetes labels applied
- [ ] `helm lint --strict` passes
- [ ] No deprecated API versions (checked with Pluto)
- [ ] kube-linter passes
- [ ] Trivy config scan shows no HIGH/CRITICAL findings
