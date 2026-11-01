/**
 * Skills installed from GitHub links.
 *
 * An installed skill lives in <skillsDir>/<name>/ and carries SOURCE_FILE: the
 * link, the resolved owner, repo, ref and path, and the git blob SHA of every
 * installed file as reported by the GitHub trees API. An update compares those
 * SHAs with the current upstream tree, downloads only changed files, checks
 * each download against its blob SHA, and writes nothing until every download
 * has passed. Directories without SOURCE_FILE are never read or written.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, join, posix } from "node:path";

export const SOURCE_FILE = ".source.json";
/** Dependency install script written next to a skill; local only, never taken from or replaced by upstream. */
export const DEPS_FILE = ".skill-deps.sh";
const LOCAL_FILES = { [SOURCE_FILE]: true, [DEPS_FILE]: true };
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** Returns the git blob SHA-1 of buf, the hash GitHub reports per tree entry. */
export function blobSha(buf) {
	return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/**
 * Splits a GitHub link into owner, repo, kind ("file" or "dir") and the path
 * segments after the mode. Accepts github.com/<o>/<r>, github.com/<o>/<r>/tree/...,
 * github.com/<o>/<r>/blob/... and raw.githubusercontent.com/<o>/<r>/....
 */
export function parseGitHubUrl(input) {
	let u;
	try {
		u = new URL(String(input).trim());
	} catch {
		throw new Error(`not a URL: ${input}`);
	}
	if (!Object.hasOwn(HOST_PARSERS, u.hostname)) throw new Error(`not a GitHub link: ${input}`);
	return HOST_PARSERS[u.hostname](u.pathname.split("/").filter(Boolean).map(decodeURIComponent), input);
}

function parseGitHubPath([owner, repoSeg, mode, ...rest], input) {
	if (!owner || !repoSeg) throw new Error(`GitHub link without owner and repository: ${input}`);
	const repo = repoSeg.replace(/\.git$/, "");
	if (mode === undefined) return { owner, repo, kind: "dir", rest: [] };
	if ((mode === "tree" || mode === "blob") && rest.length)
		return { owner, repo, kind: mode === "tree" ? "dir" : "file", rest };
	throw new Error(`unsupported GitHub link, expected .../tree/<ref>/<dir> or .../blob/<ref>/<file>: ${input}`);
}

function parseRawPath([owner, repo, ...rest], input) {
	if (!owner || !repo || rest.length < 2) throw new Error(`raw link without ref and file path: ${input}`);
	return { owner, repo, kind: "file", rest };
}

const HOST_PARSERS = {
	"github.com": parseGitHubPath,
	"www.github.com": parseGitHubPath,
	"raw.githubusercontent.com": parseRawPath,
};

/**
 * Lists the possible (ref, path) splits of a parsed link, shortest ref first.
 * A branch name may contain slashes, so the split is only known once GitHub
 * answers for one of them. ref null stands for the default branch.
 */
export function refCandidates(parsed) {
	if (!parsed.rest.length) return [{ ref: null, path: "" }];
	const last = parsed.kind === "file" ? parsed.rest.length - 1 : parsed.rest.length;
	const out = [];
	for (let i = 1; i <= last; i++)
		out.push({ ref: parsed.rest.slice(0, i).join("/"), path: parsed.rest.slice(i).join("/") });
	return out;
}

const enc = (s) => s.split("/").map(encodeURIComponent).join("/");

function headers(deps) {
	const h = { "User-Agent": "my-pi-skill-sources" };
	if (deps.token) h.Authorization = `Bearer ${deps.token}`;
	return h;
}

/** GETs an API path; returns the parsed body, or null on 404, 409 (empty repo) or 422. */
async function api(deps, path) {
	const res = await deps.fetch(`${API}${path}`, {
		headers: { ...headers(deps), Accept: "application/vnd.github+json" },
		signal: deps.signal,
	});
	if (res.ok) return res.json();
	if (res.status === 404 || res.status === 409 || res.status === 422) return null;
	throw apiError(res, path);
}

/** Builds the error for a failed API response: rate limit, rejected token, or the bare status. */
function apiError(res, path) {
	if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
		const reset = Number(res.headers.get("x-ratelimit-reset"));
		const until = reset ? ` until ${new Date(reset * 1000).toLocaleTimeString()}` : "";
		return new Error(`GitHub API rate limit reached${until}; set GITHUB_TOKEN for a higher limit`);
	}
	if (res.status === 401) return new Error("GitHub rejected the token in GITHUB_TOKEN/GH_TOKEN (401)");
	return new Error(`GitHub API ${path} answered ${res.status}`);
}

/** Fetches a tree listing (ref:path); null when the ref or path does not exist. */
function tree(deps, src, path, recursive) {
	const ref = enc(src.ref ?? "HEAD");
	// DEV-NOTE: the `ref:path` tree spec lists a whole skill directory in one API call,
	// so an update costs one call per skill against the 60/h unauthenticated limit;
	// downloads go to raw.githubusercontent.com, which that limit does not count.
	const spec = path ? `${ref}:${enc(path)}` : ref;
	return api(deps, `/repos/${enc(src.owner)}/${enc(src.repo)}/git/trees/${spec}${recursive ? "?recursive=1" : ""}`);
}

/**
 * Returns the upstream files of a source as { files, skipped }, where files
 * maps the installed relative path to { sha, mode, size, from } (from = path in
 * the repository). Returns null when the source no longer exists. Symlinks,
 * submodules and upstream copies of the local-only files are listed in skipped
 * and never installed.
 */
export function fetchUpstream(src, deps) {
	return src.kind === "file" ? fetchUpstreamFile(src, deps) : fetchUpstreamDir(src, deps);
}

async function fetchUpstreamFile(src, deps) {
	const parent = posix.dirname(src.path);
	const listing = await tree(deps, src, parent === "." ? "" : parent, false);
	const entry = listing?.tree?.find((e) => e.path === posix.basename(src.path) && e.type === "blob");
	if (!entry) return null;
	return { files: { "SKILL.md": { sha: entry.sha, mode: entry.mode, size: entry.size, from: src.path } }, skipped: [] };
}

async function fetchUpstreamDir(src, deps) {
	const listing = await tree(deps, src, src.path, true);
	if (!listing) return null;
	if (listing.truncated) throw new Error(`${src.path || src.repo} has too many files for one GitHub tree listing`);
	const up = treeFiles(listing.tree ?? [], src.path);
	if (!up.files["SKILL.md"]) throw new Error(`no SKILL.md at the top of ${src.path || `${src.owner}/${src.repo}`}`);
	return up;
}

/** Splits tree entries below base into installable files and skipped paths. */
function treeFiles(entries, base) {
	const files = {};
	const skipped = [];
	for (const e of entries) {
		if (e.type === "tree") continue;
		if (e.type !== "blob" || e.mode === "120000" || Object.hasOwn(LOCAL_FILES, e.path)) {
			skipped.push(e.path);
			continue;
		}
		files[e.path] = { sha: e.sha, mode: e.mode, size: e.size, from: base ? `${base}/${e.path}` : e.path };
	}
	return { files, skipped };
}

/** Downloads one upstream file and checks it against its blob SHA. */
async function download(deps, src, file) {
	const url = `${RAW}/${enc(src.owner)}/${enc(src.repo)}/${enc(src.ref ?? "HEAD")}/${enc(file.from)}`;
	const res = await deps.fetch(url, { headers: headers(deps), signal: deps.signal });
	if (!res.ok) throw new Error(`download of ${file.from} answered ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (blobSha(buf) !== file.sha) throw new Error(`${file.from} changed upstream during the download; run the update again`);
	return buf;
}

/** Resolves a link to a source record (without files) and its upstream listing. */
async function resolve(url, deps) {
	const parsed = parseGitHubUrl(url);
	for (const c of refCandidates(parsed)) {
		const src = { url: String(url).trim(), owner: parsed.owner, repo: parsed.repo, ref: c.ref, path: c.path, kind: parsed.kind };
		const up = await fetchUpstream(src, deps);
		if (up) return { src, up };
	}
	throw new Error(`nothing found at ${url} (missing, renamed, or private without GITHUB_TOKEN)`);
}

/**
 * Downloads the text files behind a GitHub link without installing anything.
 * Returns { src, name, files, texts }: files lists every upstream path, texts
 * maps the fetched text files to their content. SKILL.md is always fetched;
 * binary files, other files above maxFileBytes and files beyond maxTotalBytes
 * are listed but not fetched.
 */
export async function preview(url, { maxFileBytes = 200_000, maxTotalBytes = 2_000_000, ...deps } = {}) {
	const { src, up } = await resolve(url, deps);
	const texts = await fetchTexts(deps, src, up.files, maxFileBytes, maxTotalBytes);
	const name = skillName(texts["SKILL.md"] ?? "", fallbackName(src));
	return { src, name, files: Object.keys(up.files).sort(), texts };
}

/** Downloads the text files of files, SKILL.md first and always, the rest within the byte limits. */
async function fetchTexts(deps, src, files, maxFileBytes, maxTotalBytes) {
	const texts = {};
	let total = 0;
	const order = (a, b) => Number(b === "SKILL.md") - Number(a === "SKILL.md") || a.localeCompare(b);
	for (const rel of Object.keys(files).sort(order)) {
		const size = files[rel].size;
		if (rel !== "SKILL.md" && (size > maxFileBytes || total + size > maxTotalBytes)) continue;
		const buf = await download(deps, src, files[rel]);
		total += buf.length;
		if (!buf.includes(0)) texts[rel] = buf.toString("utf8");
	}
	return texts;
}

/** Maps a relative upstream path into dir; null for paths that would leave it or clobber a local-only file. */
function target(dir, rel) {
	const norm = posix.normalize(rel);
	if (norm === ".." || norm.startsWith("../") || posix.isAbsolute(norm) || Object.hasOwn(LOCAL_FILES, norm)) return null;
	return join(dir, ...norm.split("/"));
}

/**
 * Returns the name and description from the YAML front matter of a skill
 * file, or null when it has none. Folded (`>`) and literal (`|`) descriptions
 * are joined into one line.
 */
export function frontMatter(skillMd) {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
	if (!fm) return null;
	const quoted = /^(["'])(.*)\1$/;
	const name = /^name:[ \t]*(.+)$/m.exec(fm[1])?.[1].trim().replace(quoted, "$2");
	const desc = /^description:[ \t]*(.*)$((?:\r?\n[ \t]+.*)*)/m.exec(fm[1]);
	let description = desc?.[1].trim().replace(quoted, "$2");
	if (desc && (!description || /^[>|][+-]?$/.test(description)))
		description = desc[2].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ");
	return { name: name || undefined, description: description || undefined };
}

/** Derives the skill directory name from the front matter name, else from fallback. */
export function skillName(skillMd, fallback) {
	const fm = frontMatter(skillMd);
	if (!fm) throw new Error("not a skill: SKILL.md has no front matter");
	const name = sanitiseName(fm.name ?? fallback);
	if (!name) throw new Error("cannot derive a skill name; pass one");
	return name;
}

function sanitiseName(s) {
	return String(s ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|-+$/g, "");
}

function fallbackName(src) {
	if (src.kind === "file") {
		const file = posix.basename(src.path);
		if (file !== "SKILL.md") return file.replace(/\.md$/i, "");
		const parent = posix.basename(posix.dirname(src.path));
		return parent === "." ? src.repo : parent;
	}
	return src.path ? posix.basename(src.path) : src.repo;
}

export function readSource(dir) {
	const p = join(dir, SOURCE_FILE);
	if (!fs.existsSync(p)) return null;
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeSource(dir, src) {
	fs.writeFileSync(join(dir, SOURCE_FILE), `${JSON.stringify(src, null, "\t")}\n`);
}

/** Lists installed skills as { name, dir, source } or { name, dir, error } for an unreadable record. */
export function listInstalled(skillsDir) {
	if (!fs.existsSync(skillsDir)) return [];
	const out = [];
	for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		const dir = join(skillsDir, d.name);
		try {
			const source = readSource(dir);
			if (source) out.push({ name: d.name, dir, source });
		} catch (err) {
			out.push({ name: d.name, dir, error: `${SOURCE_FILE} unreadable: ${err.message}` });
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns the recorded files whose local copy is missing or differs from the recorded blob SHA. */
export function localEdits(dir, recorded) {
	return Object.entries(recorded ?? {})
		.filter(([rel, sha]) => {
			const p = target(dir, rel);
			return p && (!fs.existsSync(p) || blobSha(fs.readFileSync(p)) !== sha);
		})
		.map(([rel]) => rel)
		.sort();
}

function pruneEmpty(dir, from) {
	for (let d = from; d.startsWith(`${dir}/`); d = dirname(d)) {
		try {
			fs.rmdirSync(d);
		} catch {
			return;
		}
	}
}

/**
 * Brings dir to the upstream state of src. Returns status "current" (nothing
 * changed upstream; local edits listed in edits), "local-edits" (upstream
 * changed but local files were edited and overwrite is false; nothing
 * written), or "updated" with the changed and removed paths.
 */
async function sync(dir, src, up, deps, overwrite, prefetched = new Map()) {
	const { edits, removed, changed } = syncPlan(dir, src.files ?? {}, up.files);
	if (!changed.length && !removed.length) return { status: "current", edits, skipped: up.skipped };
	if (edits.length && !overwrite) return { status: "local-edits", edits, skipped: up.skipped };
	const write = [...new Set([...changed, ...edits.filter((rel) => rel in up.files)])].sort();
	// DEV-NOTE: every download is verified before the first write, so a failed or
	// raced download leaves the installed skill and its record untouched.
	const blobs = await fetchBlobs(deps, src, up.files, write, prefetched);
	writeSync(dir, up.files, blobs, removed);
	const files = Object.fromEntries(Object.entries(up.files).map(([rel, f]) => [rel, f.sha]));
	writeSource(dir, { ...src, files, updatedAt: (deps.now?.() ?? new Date()).toISOString() });
	return { status: "updated", changed: write, removed: removed.sort(), skipped: up.skipped };
}

/** Downloads the blobs of rels, reusing the already downloaded ones in prefetched. */
async function fetchBlobs(deps, src, files, rels, prefetched) {
	const blobs = new Map();
	for (const rel of rels) blobs.set(rel, prefetched.get(rel) ?? (await download(deps, src, files[rel])));
	return blobs;
}

/** Compares the recorded SHAs with upstream: locally edited, upstream-removed and upstream-changed paths. */
function syncPlan(dir, recorded, upstream) {
	return {
		edits: localEdits(dir, recorded),
		removed: Object.keys(recorded).filter((rel) => !(rel in upstream)),
		changed: Object.keys(upstream).filter((rel) => recorded[rel] !== upstream[rel].sha),
	};
}

/** Writes the downloaded blobs with their file modes and deletes the removed paths. */
function writeSync(dir, files, blobs, removed) {
	fs.mkdirSync(dir, { recursive: true });
	for (const [rel, buf] of blobs) {
		const p = target(dir, rel);
		if (!p) continue;
		fs.mkdirSync(dirname(p), { recursive: true });
		fs.writeFileSync(p, buf);
		fs.chmodSync(p, files[rel].mode === "100755" ? 0o755 : 0o644);
	}
	for (const rel of removed) {
		const p = target(dir, rel);
		if (!p) continue;
		fs.rmSync(p, { force: true });
		pruneEmpty(dir, dirname(p));
	}
}

/**
 * Installs the skill behind a GitHub link into skillsDir/<name>. name defaults
 * to the front matter name of SKILL.md. Reinstalling the same source updates it
 * and re-enables updates; a directory holding another skill is never replaced.
 * Returns { name, dir, ...sync result }.
 */
export async function install(url, { skillsDir, name, ...deps }) {
	const { src, up } = await resolve(url, deps);
	const skillMd = await download(deps, src, up.files["SKILL.md"]);
	const finalName = installName(name, skillMd.toString("utf8"), src);
	const dir = join(skillsDir, finalName);
	const existing = existingInstall(dir, src, finalName);
	const record = { ...src, updates: true, files: existing?.files ?? {} };
	try {
		const result = await sync(dir, record, up, deps, false, new Map([["SKILL.md", skillMd]]));
		if (existing && result.status !== "updated") writeSource(dir, { ...existing, ...src, updates: true });
		return { name: finalName, dir, ...result };
	} catch (err) {
		if (!existing) fs.rmSync(dir, { recursive: true, force: true });
		throw err;
	}
}

/** Returns the directory name for an install: name sanitised, else the front matter name. */
function installName(name, skillMd, src) {
	const derived = skillName(skillMd, fallbackName(src));
	const finalName = name ? sanitiseName(name) : derived;
	if (!finalName) throw new Error(`invalid skill name: ${name}`);
	return finalName;
}

/**
 * Returns the source record when dir holds an install of the same source, null
 * when dir does not exist; throws when dir holds anything else.
 */
function existingInstall(dir, src, name) {
	if (!fs.existsSync(dir)) return null;
	const existing = readSource(dir);
	if (!existing) throw new Error(`${dir} exists and was not installed from a link; pass another name`);
	if (existing.owner !== src.owner || existing.repo !== src.repo || existing.path !== src.path)
		throw new Error(`skill ${name} is installed from ${existing.url}; pass another name, or change its link via the update`);
	return existing;
}

/**
 * Checks one installed skill against its source and applies upstream changes.
 * Returns status "excluded", "gone" (source no longer exists), or a sync status.
 * overwrite replaces local edits with the upstream state.
 */
export async function update(entry, deps, { overwrite = false } = {}) {
	const src = entry.source;
	if (src.updates === false) return { status: "excluded" };
	const up = await fetchUpstream(src, deps);
	if (!up) return { status: "gone" };
	return sync(entry.dir, src, up, deps, overwrite);
}

/**
 * Compares one installed skill with its source without writing anything.
 * Returns status "excluded", "gone", "current" or "behind" (upstream has
 * changes not applied locally), with the locally edited paths in edits.
 */
export async function check(entry, deps) {
	const src = entry.source;
	const edits = localEdits(entry.dir, src.files);
	if (src.updates === false) return { status: "excluded", edits };
	const up = await fetchUpstream(src, deps);
	if (!up) return { status: "gone", edits };
	const recorded = src.files ?? {};
	const behind =
		Object.keys(recorded).some((rel) => !(rel in up.files)) ||
		Object.keys(up.files).some((rel) => recorded[rel] !== up.files[rel].sha);
	return { status: behind ? "behind" : "current", edits };
}

/**
 * Returns skillsDir/<name> when name is a direct child directory holding a
 * SKILL.md or a source record; throws for anything else (path segments,
 * dot names, symlinks, files, missing or non-skill directories).
 */
export function skillDir(skillsDir, name) {
	if (!name || name !== posix.basename(name) || name.startsWith(".") || name.includes("\\"))
		throw new Error(`invalid skill name: ${name}`);
	const dir = join(skillsDir, name);
	let stat;
	try {
		stat = fs.lstatSync(dir);
	} catch {
		throw new Error(`no skill ${name} in ${skillsDir}`);
	}
	if (!stat.isDirectory()) throw new Error(`${dir} is not a skill directory`);
	if (!fs.existsSync(join(dir, "SKILL.md")) && !fs.existsSync(join(dir, SOURCE_FILE)))
		throw new Error(`${dir} has no SKILL.md`);
	return dir;
}

/**
 * Deletes the skill directory skillsDir/<name> once confirm({ dir, url })
 * resolves true. name must pass skillDir; anything else is refused before
 * confirm is called. url is the link the skill was installed from, or null.
 * Returns { dir, url, deleted }.
 */
export async function remove(skillsDir, name, confirm) {
	const dir = skillDir(skillsDir, name);
	let url = null;
	try {
		url = readSource(dir)?.url ?? null;
	} catch {
		// An unreadable record does not block the deletion.
	}
	if (!(await confirm({ dir, url }))) return { dir, url, deleted: false };
	fs.rmSync(dir, { recursive: true, force: true });
	return { dir, url, deleted: true };
}

/** Excludes an installed skill from updates; the local files stay as they are. */
export function exclude(entry) {
	writeSource(entry.dir, { ...entry.source, updates: false });
}

/**
 * Points an installed skill at a new link, saves the new source, and syncs.
 * The recorded file SHAs are kept, so local edits are still detected.
 */
export async function relink(entry, url, deps, { overwrite = false } = {}) {
	const { src, up } = await resolve(url, deps);
	const record = { ...entry.source, ...src, updates: true };
	writeSource(entry.dir, record);
	return sync(entry.dir, record, up, deps, overwrite);
}

/** One-line description of a sync or update result. */
export function describe(r) {
	const text = Object.hasOwn(DESCRIPTIONS, r.status) ? DESCRIPTIONS[r.status](r) : r.status;
	const listsSkipped = (r.status === "current" || r.status === "updated") && r.skipped?.length;
	return listsSkipped ? `${text}; skipped symlinks/submodules: ${r.skipped.join(", ")}` : text;
}

const DESCRIPTIONS = {
	excluded: () => "excluded from updates",
	gone: () => "source not found",
	current: (r) => `up to date${r.edits.length ? `; local edits kept in ${r.edits.join(", ")}` : ""}`,
	"local-edits": (r) => `upstream changed, not updated because of local edits in ${r.edits.join(", ")}`,
	updated: (r) => {
		const parts = [];
		if (r.changed.length) parts.push(`wrote ${r.changed.join(", ")}`);
		if (r.removed.length) parts.push(`removed ${r.removed.join(", ")}`);
		return `updated: ${parts.join("; ")}`;
	},
};
