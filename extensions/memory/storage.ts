import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface Memory {
	id: string;
	content: string;
	type: string;
	concepts: string | null;
	files: string | null;
	project: string;
	created_at: string;
	session_id: string | null;
}

export type MemoryInput = Omit<Memory, "id" | "created_at">;

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
	private db: Database.Database;

	constructor() {
		if (!existsSync(MEMORY_DIR)) {
			mkdirSync(MEMORY_DIR, { recursive: true });
		}
		this.db = new Database(DB_PATH);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(SCHEMA);
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

	delete(id: string): boolean {
		const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
		return result.changes > 0;
	}

	close(): void {
		this.db.close();
	}
}
