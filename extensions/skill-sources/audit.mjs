/**
 * Facts for a skills audit: how often each skill in a skills directory was
 * used according to the agent session logs, when it last changed, whether its
 * link source moved on, and which skills have similar descriptions.
 *
 * Usage is counted per session: a session uses a skill when it reads the
 * skill's SKILL.md or a file under skill://<name>, or when the skill body is
 * injected into a user message (`/skill:<name>`). Repeated reads in one session
 * count once.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { check, frontMatter, listInstalled } from "./sources.mjs";

export const USAGE_WINDOW_DAYS = 90;
export const SIMILARITY_THRESHOLD = 0.3;

const MARKERS = ["SKILL.md", "skill://", "<skill name=", "[Skill directory:", "/skill:"];
const SKILL_FILE = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/;
const SKILL_DIR = /(?:^|\/)skills\/([^/\]]+)\/?$/;

/** Lists the skills in skillsDir as { dir, name, description, text, files }; directories without SKILL.md are skipped. */
export function listSkills(skillsDir) {
	if (!fs.existsSync(skillsDir)) return [];
	const out = [];
	for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
		const file = join(skillsDir, d.name, "SKILL.md");
		if (!d.isDirectory() || !fs.existsSync(file)) continue;
		const text = fs.readFileSync(file, "utf8");
		const fm = frontMatter(text) ?? {};
		const files = fs
			.readdirSync(join(skillsDir, d.name), { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile() && e.name !== ".source.json").length;
		out.push({ dir: d.name, name: fm.name ?? d.name, description: fm.description ?? "", text, files });
	}
	return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

function sessionFiles(dirs) {
	const out = [];
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const rel of fs.readdirSync(dir, { recursive: true }))
			if (String(rel).endsWith(".jsonl")) out.push(join(dir, String(rel)));
	}
	return out;
}

function textsOf(content) {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
}

/** Returns the skill keys (dir names) one session log record refers to. */
export function skillRefs(record, resolve) {
	const msg = record?.type === "message" ? record.message : null;
	if (!msg) return [];
	const refs = [];
	const byPath = (p) => {
		if (typeof p !== "string" || p.includes("node_modules")) return;
		const uri = /^skill:\/\/([^/]+)/.exec(p);
		if (uri) return refs.push(resolve.name(uri[1]));
		const m = SKILL_FILE.exec(p);
		if (m) refs.push(resolve.dir(m[1]));
	};
	if (msg.role === "assistant" && Array.isArray(msg.content)) {
		for (const c of msg.content) if (c?.type === "toolCall" && c.name === "read") byPath(c.arguments?.path);
	}
	if (msg.role === "user") {
		for (const t of textsOf(msg.content)) {
			for (const m of t.matchAll(/<skill name="([^"]+)"/g)) refs.push(resolve.name(m[1]));
			for (const m of t.matchAll(/\[Skill directory: ([^\]\n]+)\]/g)) {
				const d = SKILL_DIR.exec(m[1].trim());
				if (d) refs.push(resolve.dir(d[1]));
			}
			const cmd = /^\/skill:([a-z0-9._-]+)/.exec(t.trimStart());
			if (cmd) refs.push(resolve.name(cmd[1]));
		}
	}
	return refs.filter(Boolean);
}

/**
 * Scans the session logs under sessionDirs and returns { usage, logs }:
 * usage maps each skill dir to { sessions, recent, lastUsed } (recent counts
 * sessions with a use at or after since); logs gives the number of files read,
 * the number skipped because they vanished or could not be read, and the
 * oldest file modification time.
 */
export async function skillUsage(sessionDirs, skills, since) {
	const dirs = new Set(skills.map((s) => s.dir));
	const names = new Map(skills.map((s) => [s.name, s.dir]));
	const resolve = { dir: (d) => (dirs.has(d) ? d : null), name: (n) => names.get(n) ?? (dirs.has(n) ? n : null) };
	const usage = new Map(skills.map((s) => [s.dir, { sessions: 0, recent: 0, lastUsed: null }]));
	const files = sessionFiles(sessionDirs);
	let oldest = null;
	let skipped = 0;
	for (const file of files) {
		const last = new Map();
		let mtime;
		// DEV-NOTE: running sessions write and delete their logs while the scan runs;
		// one vanished or unreadable file must not abort the audit.
		try {
			mtime = fs.statSync(file).mtime;
			const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
			for await (const line of lines) {
				if (!MARKERS.some((m) => line.includes(m))) continue;
				let record;
				try {
					record = JSON.parse(line);
				} catch {
					continue;
				}
				const ts = record.timestamp ? new Date(record.timestamp) : mtime;
				for (const dir of skillRefs(record, resolve)) if (!last.has(dir) || last.get(dir) < ts) last.set(dir, ts);
			}
		} catch {
			skipped++;
			continue;
		}
		if (!oldest || mtime < oldest) oldest = mtime;
		for (const [dir, ts] of last) {
			const u = usage.get(dir);
			u.sessions++;
			if (ts >= since) u.recent++;
			if (!u.lastUsed || ts > u.lastUsed) u.lastUsed = ts;
		}
	}
	return { usage, logs: { files: files.length - skipped, skipped, oldest } };
}

const STOP = new Set(
	"the and for with when use used uses using this that from into your you are any all not but its via than then also only each such how what which who per can may must should does do over under about after before".split(
		" ",
	),
);

/** Returns pairs of skills whose description word sets overlap by at least threshold (Jaccard), highest first. */
export function similarPairs(skills, threshold = SIMILARITY_THRESHOLD) {
	const sets = skills.map((s) => [
		s.dir,
		new Set((s.description.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w))),
	]);
	const out = [];
	for (let i = 0; i < sets.length; i++)
		for (let j = i + 1; j < sets.length; j++) {
			const [a, wa] = sets[i];
			const [b, wb] = sets[j];
			const inter = [...wa].filter((w) => wb.has(w)).length;
			const union = wa.size + wb.size - inter;
			const score = union ? inter / union : 0;
			if (score >= threshold) out.push({ a, b, score: Math.round(score * 100) / 100 });
		}
	return out.sort((x, y) => y.score - x.score);
}

/** Returns the date (YYYY-MM-DD) of the last commit touching path in repo, or null when it has none. */
export function gitLastChanged(repo, path) {
	return new Promise((done) =>
		execFile("git", ["-C", repo, "log", "-1", "--format=%cs", "--", path], (err, out) =>
			done(err ? null : out.trim() || null),
		),
	);
}

/**
 * Collects the audit facts for every skill in skillsDir. deps carries fetch,
 * token and signal for the upstream checks of link-installed skills, now, and
 * lastChanged(dir) returning the last commit date of a skill directory.
 */
export async function auditData({ skillsDir, sessionDirs, windowDays = USAGE_WINDOW_DAYS, lastChanged, ...deps }) {
	const now = deps.now?.() ?? new Date();
	const since = new Date(now.getTime() - windowDays * 86_400_000);
	const skills = listSkills(skillsDir);
	const { usage, logs } = await skillUsage(sessionDirs, skills, since);
	const installed = new Map(listInstalled(skillsDir).map((e) => [e.name, e]));
	const rows = [];
	for (const s of skills) {
		const entry = installed.get(s.dir);
		let source = null;
		if (entry?.error) source = { status: `error: ${entry.error}` };
		else if (entry) {
			try {
				const c = await check(entry, deps);
				source = { url: entry.source.url, status: c.status, localEdits: c.edits };
			} catch (err) {
				source = { url: entry.source.url, status: `error: ${err.message}` };
			}
		}
		const u = usage.get(s.dir);
		rows.push({
			skill: s.dir,
			name: s.name,
			description: s.description,
			words: s.text.split(/\s+/).filter(Boolean).length,
			files: s.files,
			lastChanged: (await lastChanged?.(s.dir)) ?? null,
			source,
			usage: {
				sessions: u.sessions,
				[`last${windowDays}Days`]: u.recent,
				lastUsed: u.lastUsed?.toISOString().slice(0, 10) ?? null,
			},
		});
	}
	return {
		generatedAt: now.toISOString(),
		sessionLogs: {
			dirs: sessionDirs,
			files: logs.files,
			skipped: logs.skipped,
			oldestFile: logs.oldest?.toISOString().slice(0, 10) ?? null,
		},
		skills: rows,
		similarDescriptions: similarPairs(skills),
	};
}
