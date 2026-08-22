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

console.log("fileguard: all checks passed");
