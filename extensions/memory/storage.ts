import { mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Subset of the better-sqlite3 / bun:sqlite API shared by both drivers. */
interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...params: unknown[]): { changes: number };
		all(...params: unknown[]): unknown[];
	};
	close(): void;
}

// DEV-NOTE: omp runs extensions inside its compiled Bun binary, which cannot load
// the better-sqlite3 native addon; pi runs on Node, which has no bun:sqlite.
// Both drivers open the same memories.db, so pi and omp share one memory store.
function openDatabase(path: string): SqliteDatabase {
	const require = createRequire(import.meta.url);
	if ("Bun" in globalThis) {
		const { Database } = require("bun:sqlite");
		return new Database(path);
	}
	const Database = require("better-sqlite3");
	return new Database(path);
}

export interface Memory {
	id: string;
	content: string;
	type: string;
	concepts: string | null;
	files: string | null;
	project: string;
	created_at: string;
	session_id: string | null;
	/** `local` for memories saved on this machine, `shared` for memories imported from a shared repository. */
	origin: "local" | "shared";
	/** ISO timestamp of the first export to a shared repository; null for memories never exported. */
	exported_at: string | null;
}

export type MemoryInput = Omit<Memory, "id" | "created_at" | "origin" | "exported_at">;

/** The fields a shared repository file carries. */
export type SharedMemory = Pick<Memory, "id" | "content" | "type" | "concepts" | "files" | "project" | "created_at">;

const MEMORY_DIR = join(process.env.HOME ?? "~", ".pi", "memory");
const DB_PATH = join(MEMORY_DIR, "memories.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'fact',
  concepts TEXT,
  files TEXT,
  project TEXT NOT NULL,
  created_at TEXT NOT NULL,
  session_id TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, concepts, type,
  content=memories, content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, concepts, type)
  VALUES (new.rowid, new.content, new.concepts, new.type);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, concepts, type)
  VALUES ('delete', old.rowid, old.content, old.concepts, old.type);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, concepts, type)
  VALUES ('delete', old.rowid, old.content, old.concepts, old.type);
  INSERT INTO memories_fts(rowid, content, concepts, type)
  VALUES (new.rowid, new.content, new.concepts, new.type);
END;
`;

export class MemoryStorage {
	private db: SqliteDatabase;

	constructor() {
		if (!existsSync(MEMORY_DIR)) {
			mkdirSync(MEMORY_DIR, { recursive: true });
		}
		this.db = openDatabase(DB_PATH);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.addColumn("origin", "TEXT NOT NULL DEFAULT 'local'");
		this.addColumn("exported_at", "TEXT");
	}

	// DEV-NOTE: databases created before shared repositories lack these columns; pi and
	// omp may open the same file at once, so a concurrent ADD COLUMN is tolerated.
	private addColumn(name: string, definition: string): void {
		const columns = this.db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
		if (columns.some((c) => c.name === name)) return;
		try {
			this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
		} catch (error) {
			if (!/duplicate column/i.test((error as Error).message)) throw error;
		}
	}

	save(input: MemoryInput): string {
		const id = crypto.randomUUID();
		const created_at = new Date().toISOString();

		this.db
			.prepare(
				`INSERT INTO memories (id, content, type, concepts, files, project, created_at, session_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, input.content, input.type, input.concepts, input.files, input.project, created_at, input.session_id);

		return id;
	}

	search(query: string, project?: string, limit = 10): Memory[] {
		// FTS5 requires special characters to be escaped
		const safeQuery = query
			.replace(/['"]/g, "")
			.split(/\s+/)
			.filter(Boolean)
			.map((term) => `"${term}"`)
			.join(" OR ");

		if (!safeQuery) return [];

		const sql = project
			? `SELECT m.* FROM memories m
			   JOIN memories_fts f ON m.rowid = f.rowid
			   WHERE memories_fts MATCH ? AND m.project = ?
			   ORDER BY rank
			   LIMIT ?`
			: `SELECT m.* FROM memories m
			   JOIN memories_fts f ON m.rowid = f.rowid
			   WHERE memories_fts MATCH ?
			   ORDER BY rank
			   LIMIT ?`;

		const params = project ? [safeQuery, project, limit] : [safeQuery, limit];
		return this.db.prepare(sql).all(...params) as Memory[];
	}

	getByProject(project: string, limit = 5): Memory[] {
		return this.db
			.prepare("SELECT * FROM memories WHERE project = ? ORDER BY created_at DESC LIMIT ?")
			.all(project, limit) as Memory[];
	}

	get(id: string): Memory | undefined {
		return this.db.prepare("SELECT * FROM memories WHERE id = ?").all(id)[0] as Memory | undefined;
	}

	/** Local memories of the given projects never exported, oldest first, excluding the given types. */
	pendingExport(projects: string[], excludedTypes: string[]): Memory[] {
		// SQLite accepts an empty IN () list.
		return this.db
			.prepare(
				`SELECT * FROM memories
				 WHERE origin = 'local' AND exported_at IS NULL
				   AND project IN (${projects.map(() => "?").join(",")})
				   AND type NOT IN (${excludedTypes.map(() => "?").join(",")})
				 ORDER BY created_at`,
			)
			.all(...projects, ...excludedTypes) as Memory[];
	}

	markExported(id: string, at: string): void {
		this.db.prepare("UPDATE memories SET exported_at = ? WHERE id = ?").run(at, id);
	}

	/**
	 * Inserts a memory read from a shared repository, or updates an earlier import of it.
	 * A local memory with the same id is left unchanged. Returns 1 when a row was written.
	 */
	upsertShared(m: SharedMemory): number {
		return this.db
			.prepare(
				`INSERT INTO memories (id, content, type, concepts, files, project, created_at, session_id, origin)
				 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'shared')
				 ON CONFLICT(id) DO UPDATE SET
				   content = excluded.content, type = excluded.type, concepts = excluded.concepts,
				   files = excluded.files, project = excluded.project, created_at = excluded.created_at
				 WHERE memories.origin = 'shared' AND (
				   memories.content IS NOT excluded.content OR memories.type IS NOT excluded.type OR
				   memories.concepts IS NOT excluded.concepts OR memories.files IS NOT excluded.files OR
				   memories.project IS NOT excluded.project OR memories.created_at IS NOT excluded.created_at)
				 RETURNING id`,
			)
			// DEV-NOTE: bun:sqlite's run().changes counts the FTS trigger writes too; RETURNING
			// yields exactly the rows this statement wrote on both drivers.
			.all(m.id, m.content, m.type, m.concepts, m.files, m.project, m.created_at).length;
	}

	/** Deletes imported memories whose id is not in `keep`. Returns the number deleted. */
	removeSharedExcept(keep: Set<string>): number {
		const ids = this.db.prepare("SELECT id FROM memories WHERE origin = 'shared'").all() as { id: string }[];
		let removed = 0;
		for (const { id } of ids) if (!keep.has(id) && this.delete(id)) removed++;
		return removed;
	}

	delete(id: string): boolean {
		const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
		return result.changes > 0;
	}

	close(): void {
		this.db.close();
	}
}
