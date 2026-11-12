---
work_state: done
---

# Plan: Kubernetes, AWS and vcluster MCP servers behind the MCP guard

## Goal

The agent can read and change Kubernetes clusters (dev, ppd, prd and any vcluster) and AWS accounts (any
configured profile), and can check whether a vcluster such as `martin` is running and connect to it. Every
call passes the MCP guard (`notes/specs/2026-11-12-mcp-guard.md`). No credential and no upstream port is
reachable from the nono sandbox.

## Decisions (2026-11-12)

- **ppd/prd writes**: allowed after Allow in the native dialog. Hard read-only was rejected: every rollout
  restart or scale during an incident would have to be done by hand outside the agent. A dialog on every
  call was rejected: it trains click-through, the reason "findings only" was chosen for GitHub and Jira.
- **Stdio upstreams**: all three servers run as stdio children of the guard. Neither
  kubernetes-mcp-server nor aws-api-mcp-server has usable local authentication on HTTP, so an HTTP upstream
  would give curl from the sandbox full cluster and account access.
- **Kubernetes server**: `containers/kubernetes-mcp-server` (one process, many kubeconfig contexts; typed
  tools with `readOnlyHint`/`destructiveHint`; the optional `context` argument is a plain string, so a
  context added to the kubeconfig later works without the client re-listing tools).
- **AWS server**: `awslabs.aws-api-mcp-server`; `call_aws` accepts `--profile` per command (awslabs/mcp
  PR #1123), so one server covers every account. Marked "superseded" by the managed AWS MCP Server but still
  released.
- **vcluster**: own small stdio server; no vcluster MCP server exists.

## Facts

- nono denies `~/.kube`, `~/.aws` and `~/.vcluster` (EPERM observed 2026-11-12): kubectl, aws and vcluster
  in the agent shell cannot reach clusters or accounts. The MCP servers are the only path.
- dev-infra connects to a vcluster with `vcluster connect <name> --print --server api.<name>.dev.internal`
  (`.github/actions/vcluster-claim/action.yml`). vclusters live in namespaces `vc-<name>` on
  `intl-dev-stardust-cluster` (account 430896782353, kubeconfig `~/.kube/configs/stardust-staging.yaml`).
- `scripts/vpool-config.yaml` schedules `martin` 08:00-21:00 Europe/Berlin (local checkout of 2026-09-15,
  possibly stale).
- EKS endpoints and `*.dev.internal` need the VPN; EKS tokens need a valid `aws sso login`.

## Approach

### Tiers

`~/.config/mcpguard/tiers.json` (read-only for nono) lists the exact Kubernetes context and AWS profile
names per tier `dev | ppd | prd`, the AWS default profile and the vcluster host (kubeconfig file and
context). Names in the `skip` list are refused by the guard: the agent cannot use that context or profile at
all. Contexts named `vcluster_*` are the vcluster tier without an entry. Any other name not listed is
`prd` (fail closed). Exact names, not patterns: a pattern such as `stag` would also let `stage-prod` through
as ppd. The tier belongs to the context, not the account: account 430896782353 holds both the staging and
the dev EKS cluster.

Written by the MCP setup wizard (`mcp/setup/wizard.mjs`, run by `setup.fish` in a host terminal): it lists
the contexts of `~/.kube/configs/*.yaml` (without `vclusters.yaml`) and `aws configure list-profiles`,
suggests a tier from each name (prod/prd/live -> prd, ppd/preprod/stag/uat -> ppd, dev/test/sandbox -> dev,
else prd), asks per entry (`skip`, `none`, `s`, `-` or `x` put it in the skip list), then asks for the AWS default profile and the vcluster host among the dev
contexts. Shape:

```json
{
  "kube": {
    "dev": ["arn:aws:eks:eu-central-1:430896782353:cluster/intl-dev-stardust-cluster"],
    "ppd": ["<staging context>"],
    "prd": ["<prd contexts>"]
  },
  "aws": { "default": "test", "dev": ["test"], "ppd": [], "prd": [], "skip": ["stage-mfa"] },
  "vcluster": {
    "kubeconfig": "/Users/<user>/.kube/configs/stardust-staging.yaml",
    "context": "arn:aws:eks:eu-central-1:430896782353:cluster/intl-dev-stardust-cluster"
  }
}
```

### Policy

| Call | vcluster | dev | ppd / prd |
|---|---|---|---|
| Read | allow | allow | allow |
| Read a Secret, or a call that returns credentials | allow | dialog | dialog |
| Write, including `pods_exec` and `pods_run` | allow | allow | dialog |
| Destructive (`destructiveHint`, delete/terminate verbs) | allow | dialog | dialog |
| Secret or personal data in the arguments (existing scan) | dialog | dialog | dialog |

## Phases

- [x] **Phase 0: MCP setup wizard** (built 2026-11-12)
  - Files: `mcp/setup/wizard.mjs` and test, `setup.fish`, `bin/my-pi-start`, `extensions/setup/checks.mjs`
    and test.
  - Change: host-only wizard asks per server (GitHub, Jira, jflow) and stores unwanted ones in omp's
    `disabledServers` of `~/.omp/agent/mcp.json`; my-pi-start and the `/setup` check skip them. Installs
    github-mcp-server, runs `acli jira auth login --web`, stores the Jira API token in the keychain, writes
    tiers.json. Phases 3-5 add their server steps to the wizard and to my-pi-start.

- [x] **Phase 1: stdio upstream for the guard**
  - Files: `mcp/guard/stdio.mjs`, `mcp/guard/stdio.test.mjs`, `mcp/guard/guard.mjs` (`serve` variant).
  - Change: the guard serves Streamable HTTP to omp and speaks newline-delimited JSON-RPC to one child.
    JSON-RPC ids are rewritten per client request; the child's `initialize` result is cached and replayed to
    later clients; child notifications are dropped; child requests (elicitation, roots) get an error answer;
    `tools/list` annotations are recorded and passed to the policy. GET answers 405. Host check, body cap,
    audit log, dialog and "Always allow" are reused unchanged. The process exits when the child exits.
  - Verify: `node --test mcp/guard/` with a fake child (allow, deny, batch, two concurrent clients, child
    exit).
  - Risk: medium. omp's HTTP client must accept plain `application/json` replies and 405 on GET.
- [x] **Phase 2: tier map and kube/aws policies**
  - Files: `mcp/guard/tiers.mjs`, `mcp/kube/policy.mjs`, `mcp/aws/policy.mjs`, tests next to each.
  - Change: both policies extend `classify()` from `mcp/guard/policy.mjs`, so the secret and personal-data
    scan stays.
    - **Kube**: tier from the `context` argument (exact name in tiers.json, `vcluster_` prefix); absent
      context is prd. A context in the `skip` list is refused without a dialog; the same holds for an AWS
      profile in `aws.skip`. Read/write/destructive from the
      recorded tool annotations. `kind: Secret` in `resources_get`/`resources_list` is a secret read.
    - **AWS**: each `cli_command` (batches included) is split shell-style into `aws <service> <op>`,
      `--profile`, `--region`; missing `--profile` is the default profile.
      - Reads: `describe-`, `list-`, `get-`, `head-`, `lookup-`, `filter-`, `search-`, `batch-get-`,
        `s3 ls`.
      - Credential calls (dialog except vcluster tier, which AWS has none of): `secretsmanager
        get-secret-value`, `ssm get-parameter(s) --with-decryption`, `kms decrypt`, `sts assume-role`,
        `sts get-session-token`, `iam create-access-key`, `ecr get-login-password`, `eks get-token`.
      - Destructive verbs: delete, terminate, remove, deregister, purge, revoke, detach.
      - Unknown verb or unparsable command: a write on prd.
  - Verify: table tests per tier and verb class.
  - Risk: low (pure functions).
- [x] **Phase 3: kube MCP**
  - Files: `mcp/kube/guard.mjs`, `fish/functions/kubemcp.fish`, `bin/my-pi-start`, `mcp.json` (`kube`,
    127.0.0.1:8085).
  - Change: pinned `kubernetes-mcp-server` as stdio child. TOML: toolsets `core`, `config`;
    `disabled_tools = ["configuration_view"]` (prints the kubeconfig with tokens and client keys);
    `log_file = "stderr"`. `KUBECONFIG` = `~/.kube/configs/*.yaml` plus `~/.kube/configs/vclusters.yaml`,
    created empty when missing.
  - Verify: `pods_list` on the dev context works; prd `resources_delete` raises the dialog; `kubectl get ns`
    in the sandbox still fails with EPERM.
  - Risk: medium. Expired SSO or VPN down: the agent gets the CLI error and cannot fix it.
- [x] **Phase 4: AWS MCP**
  - Files: `mcp/aws/guard.mjs`, `fish/functions/awsmcp.fish`, `bin/my-pi-start`, `mcp.json` (`aws`,
    127.0.0.1:8086).
  - Change: pinned `awslabs.aws-api-mcp-server` through `uvx` with `AWS_API_MCP_PROFILE_NAME` = tiers
    default, `AWS_REGION=eu-central-1`, `AWS_API_MCP_ALLOW_UNRESTRICTED_LOCAL_FILE_ACCESS=no-access`,
    `AWS_API_MCP_TELEMETRY=false`, `AWS_API_MCP_SUPPRESS_DEPRECATION_WARNING=true`; no
    `REQUIRE_MUTATION_CONSENT` (the guard asks).
  - Verify: `sts get-caller-identity --profile <ppd>` passes without dialog; `secretsmanager
    get-secret-value` on dev and any prd write raise the dialog.
  - Risk: medium (deprecated package, see Risks).
- [x] **Phase 5: vcluster MCP**
  - Files: `mcp/vcluster/server.mjs`, `mcp/vcluster/server.test.mjs`, `mcp/vcluster/guard.mjs`, `mcp.json`
    (`vcluster`, 127.0.0.1:8087), `bin/my-pi-start`.
  - Change:
    - `vcluster_list`: `vcluster list --output json` against the host kubeconfig/context from tiers.json;
      returns name, namespace, status, created.
    - `vcluster_connect(name)`: name checked against the DNS-label regex; runs `vcluster connect <name>
      --print --server api.<name>.dev.internal`; merges context `vcluster_<name>` into `vclusters.yaml`
      (temporary file and rename). Returns only the context name, never kubeconfig content.
  - Verify: "is martin running?" answered via `vcluster_list`; `vcluster_connect martin`, then `pods_list`
    with `context=vcluster_martin`.
  - Risk: low. A missing cluster means not running (for example outside 08:00-21:00).
- [x] **Phase 6: docs**
  - Files: this spec (status), `bin/my-pi-start` header, `setup.fish` comments, guard spec cross-reference.
  - Verify: `npm test`; on the host `my-pi-start restart` lists seven servers with pid and log.

## Alternatives not taken

- Own kubectl/aws wrapper: `-f`, `--from-file`, `file://`, `--kubeconfig`, `--token`, `--server` all need
  blocking by hand; each one missed reads host files or redirects credentials.
- Managed AWS MCP Server via `mcp-proxy-for-aws` (has an `aws_profile` parameter): `run_script` runs Python
  in AWS, so the guard cannot inspect the effect; needs IAM permissions for the service.
- HTTP upstreams on 18085-18087: no usable local auth, curl from the sandbox would bypass the guard.
- One server per tier: more processes and ports for what the tier map does in one.

## Status (2026-11-12)

Phases 0-5 built and tested in the sandbox: unit tests per module, plus end-to-end runs of the real
kubernetes-mcp-server 0.1.2 and awslabs.aws-api-mcp-server 1.6.0 through the guard (tools listed, prd
delete and dev secret read raised the dialog, skipped context and profile refused, GET 405). Open on the
host: `fish setup.fish` (wizard steps for kube, aws, vcluster), `my-pi-start restart`, then a real
`vcluster_list` and a `pods_list` against the dev cluster (VPN, SSO login).

Deviations from the phases above:

- No `kubemcp.fish`/`awsmcp.fish`: `my-pi-start` starts all guard scripts through one helper
  (`__my_pi_guard_start`), which also replaced the jflow-only one. Logs `~/.local/state/{kube,aws,vcluster}mcp.log`.
- kubernetes-mcp-server 0.1.2 marks `resources_create_or_update`, `resources_scale` and `pods_exec` with
  `destructiveHint`, so they raise the dialog on dev too; the policy follows the server's annotations.
  Free writes happen in vclusters.
- A `deny` verdict (skipped context or profile) refuses the whole request without a dialog; the guard core
  gained it for this.
- Install: `brew install kubernetes-mcp-server`; the vcluster tools need `vcluster` and `kubectl` on the
  host. The wizard offers the installs.

## Not built

vcluster create/destroy/pause/resume tools, the helm toolset, AWS profile auto-discovery, automatic context
sync for every running vcluster.

## Risks

- aws-api-mcp-server deprecated: pinned; if removed, Phase 4 moves to the managed server and loses inspection
  of `run_script`.
- AWS read output may contain secrets (Lambda environment, ECS task definitions): only secret-redactor
  patterns catch them. Accepted.
- Pod logs and events are third-party text (prompt injection), like Jira tickets. The guard inspects calls,
  not returned text.
- The kubeconfig file list is read at start: a new file under `~/.kube/configs` needs
  `my-pi-start restart`.
- `vclusters.yaml` holds client keys: stays under `~/.kube`, which nono denies to the agent.

## Done when

- 8085-8087 reachable only through the guard; no upstream port exists.
- Any ppd/prd write, any Secret read outside a vcluster and any credential call run only after Allow.
- "Is my vcluster martin running?" is answered by the agent, which can then work inside it.
- Every call appears in `mcpguard.log`.
