/**
 * Self-check for MemoryStorage on both hosts. No framework — run:
 *   node --experimental-strip-types extensions/memory/storage.test.ts   (pi, better-sqlite3)
 *   bun extensions/memory/storage.test.ts                                (omp, bun:sqlite)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DEV-NOTE: storage.ts resolves ~/.pi/memory at import time, so HOME must point
// at a scratch dir before the dynamic import below.
const home = mkdtempSync(join(tmpdir(), "memory-test-"));
process.env.HOME = home;
const { MemoryStorage } = await import("./storage.ts");

try {
	const first = new MemoryStorage();
	const id = first.save({
		content: "golang retries use exponential backoff",
		type: "decision",
		concepts: "retry,backoff",
		files: null,
		project: "svc-a",
		session_id: null,
	});
	first.save({
		content: "python uses ruff",
		type: "fact",
		concepts: null,
		files: null,
		project: "svc-b",
		session_id: null,
	});
	first.close();

	// A second connection on the same file sees the rows (store is persistent).
	const s = new MemoryStorage();

	// FTS matches any term; project filter restricts results.
	assert.deepEqual(
		s.search("backoff ruff").map((m) => m.project).sort(),
		["svc-a", "svc-b"],
	);
	assert.deepEqual(
		s.search("backoff ruff", "svc-a").map((m) => m.id),
		[id],
	);

	// Quote characters in the query must not break the FTS expression.
	assert.equal(s.search(`"backoff'`, "svc-a").length, 1);
	assert.deepEqual(s.search(`"' `), []);

	assert.equal(s.getByProject("svc-b").length, 1);

	// Delete reports whether a row existed and removes it from the FTS index.
	assert.equal(s.delete(id), true);
	assert.equal(s.delete(id), false);
	assert.deepEqual(s.search("backoff"), []);
	s.close();

	console.log(`storage ok (${"Bun" in globalThis ? "bun:sqlite" : "better-sqlite3"})`);
} finally {
	rmSync(home, { recursive: true, force: true });
}
