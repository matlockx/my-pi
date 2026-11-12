/**
 * Self-check for fileguard. No framework — run:
 *   node --experimental-strip-types fileguard.test.ts
 */

import assert from "node:assert/strict";
import { checkToolCall, isSecretFile } from "./fileguard.ts";

// blocked
for (const p of [
	".env",
	"app/.env.production",
	"terraform.tfvars",
	"infra/prod.auto.tfvars.json",
	"~/.ssh/id_ed25519",
	"certs/server.pem",
	".npmrc",
	"~/.config/jflow/config.yaml",
	"/Users/x/.config/jflow/config.yaml",
	"~/.config/jflow",
	"~/.config/jflow/",
]) {
	assert.equal(isSecretFile(p), true, `should block ${p}`);
}

// allowed
for (const p of [
	".env.example",
	"env.template",
	"variables.tf",
	"main.go",
	"README.md",
	"envoy.yaml",
	"terraform.tfvars.example",
	"config.yaml",
	"~/.config/other/config.yaml",
	"~/.config/jflow/cache/issues.json",
]) {
	assert.equal(isSecretFile(p), false, `should allow ${p}`);
}

// tool wiring
assert.ok(checkToolCall("read", { path: "svc/.env" }));
assert.equal(checkToolCall("read", { path: "svc/.env.example" }), undefined);
assert.ok(checkToolCall("bash", { command: "cat .env | head" }));
assert.ok(checkToolCall("bash", { command: "rg AWS infra/prod.tfvars" }));
assert.equal(checkToolCall("bash", { command: "ls -la" }), undefined);
assert.ok(checkToolCall("read", { paths: ["a.go", "b/.env"] }));
assert.ok(
	checkToolCall("eval", {
		code: "yaml.safe_load(open(os.path.expanduser('~/.config/jflow/config.yaml')))",
	}),
);
assert.equal(checkToolCall("eval", { code: "print(1)" }), undefined);
assert.ok(checkToolCall("bash", { command: "rg sig= ~/.config/jflow" }));
assert.ok(checkToolCall("bash", { command: "cat ~/.config/jflow/*.yaml" }));
assert.ok(checkToolCall("grep", { path: "$HOME/.config/jflow/" }));

// keychain reads that print the secret
for (const command of [
	'security find-generic-password -s jira-mcp -a "$e" -w 2>/dev/null',
	"security find-internet-password -gs github.com",
	"security dump-keychain -d login.keychain",
]) {
	assert.ok(checkToolCall("bash", { command }), `should block ${command}`);
}
assert.ok(
	checkToolCall("eval", {
		code: 'subprocess.run(["security", "find-generic-password", "-s", "x", "-w"])',
	}),
);
// continued lines and multi-line argv lists still name -w
assert.ok(checkToolCall("bash", { command: "security find-generic-password -s x \\\n  -w" }));
assert.ok(
	checkToolCall("eval", {
		code: 'subprocess.run([\n  "security",\n  "find-generic-password",\n  "-s", "x",\n  "-w",\n])',
	}),
);
// metadata only: no secret printed
assert.equal(
	checkToolCall("bash", { command: "security find-generic-password -s jira-mcp" }),
	undefined,
);
assert.equal(checkToolCall("bash", { command: "security dump-keychain" }), undefined);

// irreversible acli commands, including quoting and wrapper workarounds
for (const command of [
	"acli jira workitem delete --key AB-1 --yes",
	"/opt/homebrew/bin/acli jira project archive --key AB",
	"env FOO=1 acli jira workitem watcher remove --key AB-1",
	'bash -c "acli jira sprint delete --id 1"',
	"ac''li jira workitem delete --key AB-1",
	"a\\cli jira workitem delete --key AB-1",
	"acli jira workitem \\\n  delete --key AB-1",
	"acli admin user deactivate --email x@example.com",
	"acli rovodev run",
]) {
	assert.ok(checkToolCall("bash", { command }), `should block ${command}`);
}
for (const code of [
	'subprocess.run(["acli", "jira", "workitem", "delete", "--key", "AB-1"])',
	'subprocess.run([\n  "acli",\n  "jira", "workitem",\n  "delete",\n])',
	"await Bun.$`acli jira field delete --id 1`",
]) {
	assert.ok(checkToolCall("eval", { code }), `should block ${code}`);
}
for (const command of [
	"acli jira workitem view AB-1",
	"acli jira workitem unarchive --key AB-1",
	"acli jira workitem search --jql 'project = AB' | grep -c delete",
	"acli jira auth status",
]) {
	assert.equal(checkToolCall("bash", { command }), undefined, `should allow ${command}`);
}
assert.equal(
	checkToolCall("eval", {
		code: 'subprocess.run(["acli", "jira", "workitem", "create", "--summary", "remove old cache"])',
	}),
	undefined,
);

// gh: irreversible or MCP-confirmed commands, API writes and token reads
for (const command of [
	"gh repo delete org/x --yes",
	"gh repo archive org/x",
	"gh repo create org/new --private",
	"gh repo fork org/x",
	"gh repo edit org/x --visibility public --accept-visibility-change-consequences",
	"gh pr merge 12 --squash",
	"gh issue delete 3 --yes",
	"gh issue transfer 3 org/other",
	"gh release delete-asset v1 a.zip",
	"gh project item-delete 1 --id X",
	"gh workflow run deploy.yml",
	"gh run rerun 99",
	"/opt/homebrew/bin/gh secret delete TOKEN",
	"g''h label delete bug",
	"gh api -X DELETE repos/org/x",
	"gh api --method=PUT repos/org/x/pulls/1/merge",
	"gh api repos/org/x/dispatches -f event_type=go",
	"gh api graphql -f query='mutation { deleteIssue(input: {issueId: \"I\"}) { clientMutationId } }'",
	"gh auth token",
	"gh auth status --show-token",
]) {
	assert.ok(checkToolCall("bash", { command }), `should block ${command}`);
}
assert.ok(checkToolCall("eval", { code: 'subprocess.run(["gh", "pr", "merge", "12"])' }));
for (const command of [
	"gh pr view 12 --json mergeable,title",
	"gh pr list --state merged",
	"gh issue create --title 'delete stale cache'",
	"gh run view 99",
	"gh repo edit org/x --description new",
	"gh api repos/org/x/pulls",
	"gh api -X GET search/issues -f q=bug",
	"gh api graphql -f query='query { viewer { login } }'",
	"gh auth status",
]) {
	assert.equal(checkToolCall("bash", { command }), undefined, `should allow ${command}`);
}

console.log("fileguard: all checks passed");
