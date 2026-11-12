import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { ensureVclusterFile, kubeconfigPath } from "./guard.mjs";

function tempDir(t) {
	const dir = fs.mkdtempSync(join(os.tmpdir(), "kubemcp-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("kubeconfigPath lists the yaml files sorted, then vclusters.yaml last", (t) => {
	const dir = tempDir(t);
	for (const f of ["b.yaml", "a.yml", "vclusters.yaml", "notes.txt"]) fs.writeFileSync(join(dir, f), "");

	assert.equal(kubeconfigPath(dir), [join(dir, "a.yml"), join(dir, "b.yaml"), join(dir, "vclusters.yaml")].join(":"));
	assert.equal(kubeconfigPath(join(dir, "missing")), join(dir, "missing", "vclusters.yaml"));
});

test("ensureVclusterFile creates an empty private kubeconfig once and never overwrites it", (t) => {
	const dir = join(tempDir(t), "configs");

	ensureVclusterFile(dir);
	const file = join(dir, "vclusters.yaml");
	assert.match(fs.readFileSync(file, "utf8"), /^apiVersion: v1\nkind: Config\n/);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);

	fs.writeFileSync(file, "kept");
	ensureVclusterFile(dir);
	assert.equal(fs.readFileSync(file, "utf8"), "kept");
});
