/**
 * Shared memory repositories: git checkouts holding one Markdown file per memory at
 * `<repo>/<project>/<id>.md`. Export writes local memories there; import reads every
 * file back into the local store. Git operations (commit, PR, pull) stay manual.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Memory, MemoryStorage, SharedMemory } from "./storage";
import { redactString } from "../secret-redactor/redact.ts";

/** One shared memory repository and the projects exported to it. */
export interface ShareRepo {
	/** Absolute path of the repository checkout. */
	repo: string;
	/** Project names (basename of the working directory) whose memories are exported here. */
	projects: string[];
}

/** Memory types never exported: per-session noise and personal settings. */
export const UNSHARED_TYPES = ["session-summary", "preference"];

const ID = /^[A-Za-z0-9-]+$/;
// No path separator and no leading dot, so `.git` and `..` never name a project.
const PROJECT = /^[^/\\.][^/\\]*$/;
const HEADER_KEYS = ["id", "type", "concepts", "files", "created_at"] as const;

export const shareConfigPath = () => join(process.env.HOME ?? "~", ".pi", "memory", "shared.json");

/**
 * Reads the shared repository list, a JSON array of `{ "repo": path, "projects": [names] }`.
 * Returns undefined when the file does not exist; throws when it is not valid JSON or an
 * entry is malformed.
 */
export function loadShareConfig(path = shareConfigPath()): ShareRepo[] | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!Array.isArray(raw)) throw new Error(`${path}: expected an array of { repo, projects }`);
	return raw.map((entry, i) => {
		const { repo, projects } = (entry ?? {}) as { repo?: unknown; projects?: unknown };
		if (
			typeof repo !== "string" ||
			!Array.isArray(projects) ||
			!projects.every((p) => typeof p === "string" && PROJECT.test(p))
		)
			throw new Error(`${path}: entry ${i} needs a "repo" path and plain "projects" names`);
		return { repo: repo.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"), projects };
	});
}

/** Serialises a memory: a header of JSON-encoded values between `---` lines, then the content. */
export function toFile(m: SharedMemory): string {
	const header = HEADER_KEYS.map((k) => `${k}: ${JSON.stringify(m[k])}`).join("\n");
	return `---\n${header}\n---\n${m.content}\n`;
}

/** Parses a memory file of `project`; returns undefined for a malformed header, a non-plain id or empty content. */
export function parseFile(text: string, project: string): SharedMemory | undefined {
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	if (!match) return undefined;
	const fields: Record<string, unknown> = {};
	for (const line of match[1].split("\n")) {
		const sep = line.indexOf(": ");
		if (sep < 0) return undefined;
		try {
			fields[line.slice(0, sep)] = JSON.parse(line.slice(sep + 2));
		} catch {
			return undefined;
		}
	}
	const { id, type, concepts, files, created_at } = fields;
	const content = match[2].replace(/\n$/, "");
	if (
		typeof id !== "string" ||
		!ID.test(id) ||
		typeof type !== "string" ||
		typeof created_at !== "string" ||
		(concepts !== null && typeof concepts !== "string") ||
		(files !== null && typeof files !== "string") ||
		!content
	)
		return undefined;
	return { id, type, concepts, files, created_at, content, project };
}

export interface ImportResult {
	/** Memories inserted or updated. */
	changed: number;
	/** Imported memories deleted because their file is gone. */
	removed: number;
	/** Files skipped as unparseable or named differently from their id. */
	invalid: string[];
	/** Configured checkouts that do not exist. */
	missing: string[];
}

/**
 * Imports every memory file of the given repositories and deletes earlier imports whose
 * file is gone. Local memories are never changed or deleted.
 */
export function importShared(storage: MemoryStorage, repos: ShareRepo[]): ImportResult {
	const result: ImportResult = { changed: 0, removed: 0, invalid: [], missing: [] };
	const seen = new Set<string>();
	for (const { repo } of repos) {
		if (!existsSync(repo)) {
			result.missing.push(repo);
			continue;
		}
		for (const dir of readdirSync(repo, { withFileTypes: true })) {
			if (!dir.isDirectory() || !PROJECT.test(dir.name)) continue;
			for (const file of readdirSync(join(repo, dir.name))) {
				if (!file.endsWith(".md")) continue;
				const path = join(repo, dir.name, file);
				const m = parseFile(readFileSync(path, "utf8"), dir.name);
				if (!m || file !== `${m.id}.md`) {
					result.invalid.push(path);
					continue;
				}
				seen.add(m.id);
				result.changed += storage.upsertShared(m);
			}
		}
	}
	// DEV-NOTE: a checkout that is not there would read as "every memory removed", so
	// removal waits until all configured checkouts exist.
	if (result.missing.length === 0) result.removed = storage.removeSharedExcept(seen);
	return result;
}

/**
 * Writes every local memory of a configured project that was never exported, except
 * UNSHARED_TYPES, and marks it exported. File paths under $HOME are written as `~/…`.
 * A memory in which the secret-redactor rules find a secret is withheld: not written,
 * not marked, listed by id. A memory deleted from the repository is not written again.
 * Returns the number of files written, the withheld ids and the checkouts that do not exist.
 */
export function exportShared(
	storage: MemoryStorage,
	repos: ShareRepo[],
	now = new Date().toISOString(),
): { written: number; withheld: string[]; missing: string[] } {
	let written = 0;
	const home = process.env.HOME;
	const withheld: string[] = [];
	const missing: string[] = [];
	for (const { repo, projects } of repos) {
		if (!existsSync(repo)) {
			missing.push(repo);
			continue;
		}
		for (const m of storage.pendingExport(projects, UNSHARED_TYPES)) {
			// DEV-NOTE: file lists hold absolute paths of this machine; the home prefix names the user.
			const files = home ? (m.files?.replaceAll(`${home}/`, "~/") ?? null) : m.files;
			const text = toFile({ ...m, files });
			if (redactString(text).count > 0) {
				withheld.push(m.id);
				continue;
			}
			mkdirSync(join(repo, m.project), { recursive: true });
			writeFileSync(join(repo, m.project, `${m.id}.md`), text);
			storage.markExported(m.id, now);
			written++;
		}
	}
	return { written, withheld, missing };
}

/** Deletes the files of a memory from every configured checkout. Returns the number deleted. */
export function removeSharedFile(repos: ShareRepo[], m: Pick<Memory, "id" | "project">): number {
	if (!ID.test(m.id) || !PROJECT.test(m.project)) return 0;
	let removed = 0;
	for (const { repo } of repos) {
		const path = join(repo, m.project, `${m.id}.md`);
		if (!existsSync(path)) continue;
		unlinkSync(path);
		removed++;
	}
	return removed;
}
