/**
 * Self-check for shared memory repositories on both hosts. No framework — run:
 *   node --experimental-strip-types extensions/memory/share.test.ts   (pi, better-sqlite3)
 *   bun extensions/memory/share.test.ts                                (omp, bun:sqlite)
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportShared, importShared, loadShareConfig, parseFile, removeSharedFile, toFile } from "./share.ts";

// DEV-NOTE: storage.ts resolves ~/.pi/memory at import time, so HOME must point
// at a scratch dir before the dynamic import below.
const home = mkdtempSync(join(tmpdir(), "memory-share-test-"));
process.env.HOME = home;
const { MemoryStorage } = await import("./storage.ts");

const local = (content: string, type: string, project: string) => ({
	content,
	type,
	concepts: "c1,c2",
	files: `${home}/projects/svc/a.go`,
	project,
	session_id: "/tmp/session.jsonl",
});

try {
	const repo = join(home, "team-memory");
	mkdirSync(repo);
	const repos = [{ repo, projects: ["svc-a"] }];
	const s = new MemoryStorage();

	// --- Export: mapped project, shared types only, once ---
	const decision = s.save(local("retries use backoff\n---\nnot a header", "decision", "svc-a"));
	s.save(local("my editor is helix", "preference", "svc-a"));
	s.save(local("Session summary — Goal: x", "session-summary", "svc-a"));
	s.save(local("client B internals", "decision", "svc-b"));

	const leaky = s.save(local(`deploy token is ghp_${"a".repeat(36)}`, "fact", "svc-a"));
	assert.deepEqual(exportShared(s, repos, "2026-10-27T00:00:00.000Z"), { written: 1, withheld: [leaky], missing: [] });
	assert.equal(existsSync(join(repo, "svc-a", `${leaky}.md`)), false, "secret never reaches the repository");
	assert.equal(s.get(leaky)?.exported_at, null, "withheld memory stays pending");
	assert.deepEqual(exportShared(s, repos).withheld, [leaky], "and is reported again");
	s.delete(leaky);
	assert.deepEqual(readdirSync(repo), ["svc-a"], "unmapped project svc-b stays out");
	const file = join(repo, "svc-a", `${decision}.md`);
	const exported = parseFile(readFileSync(file, "utf8"), "svc-a");
	assert.equal(exported?.content, "retries use backoff\n---\nnot a header", "content with --- survives");
	assert.equal(exported?.concepts, "c1,c2");
	assert.equal(exported?.files, "~/projects/svc/a.go", "home prefix is not exported");
	assert.doesNotMatch(readFileSync(file, "utf8"), /session/, "session file path is not exported");
	assert.equal(s.get(decision)?.exported_at, "2026-10-27T00:00:00.000Z");

	// A memory pruned from the repository in review is not written again.
	unlinkSync(file);
	assert.equal(exportShared(s, repos).written, 0);

	// --- Import: a coworker's memory arrives, updates, and leaves with its file ---
	const theirs = { id: "c0ffee00-0000-4000-8000-000000000001", content: "ledger is append-only", type: "architecture", concepts: null, files: "a.go", project: "svc-a", created_at: "2026-10-01T00:00:00.000Z" };
	const theirFile = join(repo, "svc-a", `${theirs.id}.md`);
	writeFileSync(theirFile, toFile(theirs));
	writeFileSync(join(repo, "svc-a", "renamed.md"), toFile({ ...theirs, id: "c0ffee00-0000-4000-8000-000000000002" }));
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, ".git", "x.md"), toFile(theirs));

	let r = importShared(s, repos);
	assert.equal(r.changed, 1);
	assert.deepEqual(r.invalid, [join(repo, "svc-a", "renamed.md")], "file name must match its id");
	assert.equal(s.get(theirs.id)?.origin, "shared");
	assert.deepEqual(s.search("append-only").map((m) => m.id), [theirs.id], "imports are searchable");
	assert.equal(importShared(s, repos).changed, 0, "unchanged file writes nothing");

	writeFileSync(theirFile, toFile({ ...theirs, content: "ledger is append-only, corrections are reversals" }));
	assert.equal(importShared(s, repos).changed, 1);
	assert.match(s.get(theirs.id)?.content ?? "", /reversals/);

	// A file carrying a local memory's id never overwrites it.
	writeFileSync(join(repo, "svc-a", `${decision}.md`), toFile({ ...exported!, content: "edited in review" }));
	importShared(s, repos);
	assert.equal(s.get(decision)?.content, "retries use backoff\n---\nnot a header");
	assert.equal(s.get(decision)?.origin, "local");

	// A missing checkout pauses removal instead of wiping its imports.
	unlinkSync(theirFile);
	r = importShared(s, [...repos, { repo: join(home, "absent"), projects: [] }]);
	assert.deepEqual([r.removed, r.missing], [0, [join(home, "absent")]]);
	assert.ok(s.get(theirs.id));

	r = importShared(s, repos);
	assert.equal(r.removed, 1);
	assert.equal(s.get(theirs.id), undefined);
	assert.ok(s.get(decision), "local memories survive removal of their file");

	// --- Forget deletes the shared file ---
	assert.equal(removeSharedFile(repos, { id: decision, project: "svc-a" }), 1);
	assert.equal(existsSync(join(repo, "svc-a", `${decision}.md`)), false);
	assert.equal(removeSharedFile(repos, { id: "../../x", project: "svc-a" }), 0, "no path traversal");

	// --- Export to a missing checkout writes nothing and creates no directory ---
	s.save(local("new fact", "fact", "svc-a"));
	assert.deepEqual(exportShared(s, [{ repo: join(home, "absent"), projects: ["svc-a"] }]), { written: 0, withheld: [], missing: [join(home, "absent")] });
	assert.equal(existsSync(join(home, "absent")), false);

	// --- Malformed files ---
	assert.equal(parseFile("no header", "p"), undefined);
	assert.equal(parseFile('---\nid: "../x"\ntype: "fact"\ncreated_at: "t"\n---\nbody\n', "p"), undefined);
	assert.equal(parseFile('---\nid: "a"\ntype: "fact"\ncreated_at: "t"\n---\n\n', "p"), undefined, "empty content");
	assert.equal(parseFile('---\nid: "a"\ntype: fact\ncreated_at: "t"\n---\nbody\n', "p"), undefined, "unquoted value");
	s.close();

	// --- Config ---
	const config = join(home, "shared.json");
	assert.equal(loadShareConfig(config), undefined);
	writeFileSync(config, JSON.stringify([{ repo: "~/m", projects: ["svc-a"] }]));
	assert.deepEqual(loadShareConfig(config), [{ repo: join(home, "m"), projects: ["svc-a"] }]);
	for (const bad of [{ repo: "~/m", projects: ["../x"] }, { repo: "~/m", projects: [".git"] }, { projects: [] }]) {
		writeFileSync(config, JSON.stringify([bad]));
		assert.throws(() => loadShareConfig(config), /entry 0/);
	}
	writeFileSync(config, "{");
	assert.throws(() => loadShareConfig(config), SyntaxError);

	console.log(`share ok (${"Bun" in globalThis ? "bun:sqlite" : "better-sqlite3"})`);
} finally {
	rmSync(home, { recursive: true, force: true });
}
