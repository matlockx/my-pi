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

console.log("fileguard: all checks passed");
