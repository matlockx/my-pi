/**
 * Client IP scan: compares a work repository against restricted reference corpora
 * (another client's code) and the consultancy's own platform with jscpd and JPlag.
 *
 * The agent view (agentView) carries work-repository locations only. Reference source,
 * reference paths and scanner stderr stay in the audit record under the client-ip home.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Directory holding config.json, the scanner binaries and the audit trail. */
export const clientIpHome = () =>
	process.env.CLIENT_IP_HOME ?? join(homedir(), ".omp", "client-ip");

/**
 * Paths never compared: dependency trees, build output, lockfiles, generated code and
 * macOS AppleDouble metadata (._name, written next to every file on exFAT/FAT volumes).
 * They match across any two repositories using the same libraries, or are not source at
 * all, and carry no authored expression. config.json "ignore" extends this list.
 */
export const DEFAULT_IGNORE = [
	"(^|/)(node_modules|vendor|dist|build|target|coverage|\\.git)/",
	"(^|/)(go\\.mod|go\\.sum|package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb?|Cargo\\.lock|poetry\\.lock|uv\\.lock)$",
	"\\.pb(\\.gw)?\\.go$",
	"(^|/)\\._[^/]*$",
];

/** File suffix to JPlag language id; jscpd needs no mapping. */
const JPLAG_LANGUAGES: Record<string, string> = {
	go: "go",
	java: "java",
	py: "python3",
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	kt: "kotlin",
	rs: "rust",
	cs: "csharp",
	c: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	scala: "scala",
	swift: "swift",
	md: "text",
	txt: "text",
};

/** Settings read from <client-ip home>/config.json, paths absolute. */
export interface Config {
	home: string;
	jscpd: string;
	java: string;
	jplagJar: string;
	/** jscpd --min-tokens. */
	minTokens: number;
	/** jscpd --min-lines. JPlag is bounded by jplagMinTokens only: prose puts a sentence on one line. */
	minLines: number;
	/** JPlag -t. */
	jplagMinTokens: number;
	ignore: RegExp[];
	repos: { path: string; restricted: string[]; own: string[] }[];
}

/** A work repository with the references it is compared against. */
export interface Repo {
	/** Git root of the work repository. */
	root: string;
	/** Roots of code owned by another client; matches are findings. */
	restricted: string[];
	/** Roots of the own platform; matches only label findings (alsoInOwn). */
	own: string[];
}

type Corpus = "work" | "restricted" | "own";

/** A file in the scan tree; index selects the root in Repo.restricted or Repo.own. */
interface Location {
	corpus: Corpus;
	index?: number;
	file: string;
}

interface Range {
	start: number;
	end: number;
}

/** One match between a work range and a reference range, as reported by one scanner. */
export interface Pair {
	work: { file: string } & Range;
	ref: Location & Range;
	kind: string;
	tokens: number;
	scanner: "jscpd" | "jplag";
}

/** Overlapping work-to-restricted matches of one work file. */
export interface Finding extends Range {
	/** IP- plus 8 hex characters, derived from the work file and the reference locations. */
	id: string;
	file: string;
	/** HIGH when both scanners report the range, MED when one does. */
	severity: "HIGH" | "MED";
	kinds: string[];
	scanners: string[];
	tokens: number;
	/** The work range also matches the own platform. */
	alsoInOwn: boolean;
	refs: (Location & Range)[];
}

export interface ScanError {
	scanner: "jscpd" | "jplag" | "config";
	message: string;
}

/** Result of scan(); CLEAN only when every scanner ran and nothing matched. */
export interface ScanResult {
	status: "CLEAN" | "FINDINGS" | "INCOMPLETE";
	/** Work-repository lines covered by findings. */
	score: number;
	findings: Finding[];
	errors: ScanError[];
	versions: Record<string, unknown>;
}

/** What the agent sees of a ScanResult. */
export interface AgentView {
	status: ScanResult["status"];
	score: number;
	findings: {
		id: string;
		file: string;
		lines: string;
		severity: Finding["severity"];
		kinds: string[];
		scanners: string[];
		alsoInOwn: boolean;
	}[];
	errors: string[];
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, homedir());

const within = (path: string, root: string) =>
	path === root || path.startsWith(root + sep);

/**
 * Absolute path with symlinks resolved, as git rev-parse --show-toplevel reports roots
 * (/var/... is /private/var/... on macOS); the resolved input when it does not exist.
 */
function canonical(path: string): string {
	const abs = resolve(expandHome(path));
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

/** Runs a binary without a shell; never rejects. code is 0 on success. */
export async function run(cmd: string, args: string[]): Promise<RunResult> {
	try {
		const { stdout, stderr } = await execFileP(cmd, args, {
			maxBuffer: 256 * 1024 * 1024,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as { code?: unknown; stdout?: string; stderr?: string; message: string };
		return {
			code: typeof e.code === "number" ? e.code : 1,
			stdout: e.stdout ?? "",
			stderr: e.stderr || e.message,
		};
	}
}

/**
 * Reads <home>/config.json. Returns undefined when the file does not exist; a file
 * that is not valid JSON throws.
 */
export async function loadConfig(home = clientIpHome()): Promise<Config | undefined> {
	let raw: Record<string, any>;
	try {
		raw = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const bin = join(home, "bin");
	return {
		home,
		jscpd: canonical(raw.jscpd ?? join(bin, "jscpd")),
		java: raw.java ? canonical(raw.java) : "java",
		jplagJar: canonical(raw.jplagJar ?? join(bin, "jplag.jar")),
		minTokens: raw.minTokens ?? 50,
		minLines: raw.minLines ?? 5,
		jplagMinTokens: raw.jplagMinTokens ?? 20,
		ignore: [...DEFAULT_IGNORE, ...(raw.ignore ?? [])].map((s: string) => new RegExp(s)),
		repos: Object.entries(raw.repos ?? {}).map(([path, refs]: [string, any]) => ({
			path: canonical(path),
			restricted: (refs.restricted ?? []).map(canonical),
			own: (refs.own ?? []).map(canonical),
		})),
	};
}

/**
 * Work-repository entry for a git root: the config key equals the root or is a parent
 * directory of it. undefined when the root is not listed.
 */
export function findRepo(config: Config, root: string): Repo | undefined {
	const entry = config.repos.find((r) => within(root, r.path));
	return entry && { root, restricted: entry.restricted, own: entry.own };
}

/** Tool input fields that name what a tool reads; file content fields are never inspected. */
const INPUT_FIELDS = ["command", "code", "path", "paths", "file", "filePath", "cwd", "dir", "directory"];

/**
 * First path-like token of a tool input that resolves inside a guarded root or to a
 * directory containing one (a recursive search of the parent reads the root too);
 * undefined when none does. Relative tokens resolve against cwd, ~ against the home
 * directory, symlinks to their target. The home directory and / are not treated as
 * containing a root.
 */
// ponytail: token scan over INPUT_FIELDS, misses quoted paths with spaces, glob patterns
// and paths assembled at runtime (os.path.join in eval); a sandbox profile is the upgrade.
export function guardHit(
	input: Record<string, unknown>,
	cwd: string,
	roots: string[],
): string | undefined {
	const home = homedir();
	const guarded = roots.map(canonical);
	const values = INPUT_FIELDS.flatMap((key) => input[key] ?? []);
	for (const text of values.filter((v): v is string => typeof v === "string")) {
		for (const token of text.match(/[\w./~@+-]+/g) ?? []) {
			const path = canonical(resolve(cwd, expandHome(token)));
			const parent = path !== home && path !== "/";
			if (guarded.some((root) => within(path, root) || (parent && within(root, path))))
				return token;
		}
	}
	return undefined;
}

/** Files of a corpus relative to its root: git-tracked plus untracked-not-ignored, else a walk. */
async function listFiles(root: string, ignore: RegExp[]): Promise<string[]> {
	const git = await run("git", [
		"-C",
		root,
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
	]);
	const files =
		git.code === 0
			? git.stdout.split("\0").filter(Boolean)
			: (await readdir(root, { recursive: true, withFileTypes: true }))
					.filter((d) => d.isFile())
					.map((d) => relative(root, join(d.parentPath, d.name)));
	return files.filter((file) => !ignore.some((re) => re.test(file)));
}

/** Symlinks files into dir; skips entries that are not regular files (deleted, submodules). */
async function linkFiles(
	dir: string,
	root: string,
	files: string[],
	place: (file: string) => string = (file) => file,
): Promise<string[]> {
	const linked: string[] = [];
	for (const file of files) {
		const target = join(root, file);
		const info = await stat(target).catch(() => undefined);
		if (!info?.isFile()) continue;
		const link = join(dir, place(file));
		await mkdir(dirname(link), { recursive: true });
		await symlink(target, link);
		linked.push(file);
	}
	return linked;
}

// DEV-NOTE: the work tree is split into one JPlag submission per top-level directory.
// JPlag tiles each reference token at most once per submission pair, so a reference
// region copied into two places of one submission is reported once; per-directory
// submissions report each copy that sits in a different directory.
function workPlace(file: string): string {
	const slash = file.indexOf("/");
	return slash < 0 ? `w-/${file}` : `w-${file.slice(0, slash)}/${file.slice(slash + 1)}`;
}

/**
 * Maps a path inside the scan tree (group/submission/rest) back to its corpus.
 * Groups: 0-ref/r<i> restricted, 0-own/o<i> own, 1-work/w-<top> the work repository.
 */
export function locate(group: string, submission: string, rest: string): Location | undefined {
	if (group === "1-work") {
		const top = submission.slice(2);
		return { corpus: "work", file: top ? `${top}/${rest}` : rest };
	}
	if (group === "0-ref" || group === "0-own")
		return {
			corpus: group === "0-ref" ? "restricted" : "own",
			index: Number(submission.slice(1)),
			file: rest,
		};
	return undefined;
}

type Side = { loc: Location } & Range;

/** Orders a located pair as {work, ref}; undefined unless exactly one side is the work repository. */
function workPair(a: Side | undefined, b: Side | undefined) {
	if (!a || !b || (a.loc.corpus === "work") === (b.loc.corpus === "work")) return undefined;
	const [w, r] = a.loc.corpus === "work" ? [a, b] : [b, a];
	return {
		work: { file: w.loc.file, start: w.start, end: w.end },
		ref: { ...r.loc, start: r.start, end: r.end },
	};
}

interface JscpdFile {
	name: string;
	start: number;
	end: number;
}

/** Work-to-reference pairs from a jscpd JSON report whose paths lie under tree. */
export function parseJscpd(
	report: { duplicates?: { firstFile: JscpdFile; secondFile: JscpdFile; kind: string; tokens: number }[] },
	tree: string,
): Pair[] {
	const side = (f: JscpdFile): Side | undefined => {
		// DEV-NOTE: jscpd names a block of a block-tokenised file (Markdown, Vue, Svelte,
		// Astro) "<path>:<format>"; the suffix goes so the range merges with JPlag's.
		const rel = relative(tree, f.name.replace(/(\.[^/.:]+):[a-z][\w-]*$/, "$1"));
		if (rel.startsWith("..")) return undefined;
		const [group, submission, ...rest] = rel.split(sep);
		const loc = locate(group, submission, rest.join("/"));
		return loc && { loc, start: f.start, end: f.end };
	};
	return (report.duplicates ?? []).flatMap((d) => {
		const pair = workPair(side(d.firstFile), side(d.secondFile));
		return pair ? [{ ...pair, kind: d.kind, tokens: d.tokens, scanner: "jscpd" as const }] : [];
	});
}

interface JplagPoint {
	line: number;
}

/** A comparisons/*.json object of a JPlag result archive. */
export interface JplagComparison {
	matches?: {
		firstFileName: string;
		secondFileName: string;
		startInFirst: JplagPoint;
		endInFirst: JplagPoint;
		startInSecond: JplagPoint;
		endInSecond: JplagPoint;
		lengthOfFirst: number;
	}[];
}

/** Work-to-reference pairs from JPlag comparisons; file names are <root>_<submission>/<path>. */
export function parseJplag(comparisons: JplagComparison[]): Pair[] {
	const side = (name: string, start: JplagPoint, end: JplagPoint): Side | undefined => {
		const slash = name.indexOf("/");
		const id = name.slice(0, slash);
		const cut = id.indexOf("_");
		const loc = locate(id.slice(0, cut), id.slice(cut + 1), name.slice(slash + 1));
		return loc && { loc, start: start.line, end: end.line };
	};
	return comparisons.flatMap((c) =>
		(c.matches ?? []).flatMap((m) => {
			const pair = workPair(
				side(m.firstFileName, m.startInFirst, m.endInFirst),
				side(m.secondFileName, m.startInSecond, m.endInSecond),
			);
			return pair
				? [{ ...pair, kind: "jplag", tokens: m.lengthOfFirst, scanner: "jplag" as const }]
				: [];
		}),
	);
}

/**
 * Merges work-to-restricted pairs into findings: overlapping work line ranges of one
 * file become one finding.
 */
export function mergeFindings(pairs: Pair[]): Finding[] {
	const own = pairs.filter((p) => p.ref.corpus === "own");
	const restricted = pairs
		.filter((p) => p.ref.corpus === "restricted")
		.sort((a, b) => a.work.file.localeCompare(b.work.file) || a.work.start - b.work.start);

	const merged: ({ file: string; pairs: Pair[] } & Range)[] = [];
	for (const p of restricted) {
		const last = merged.at(-1);
		if (last && last.file === p.work.file && p.work.start <= last.end) {
			last.end = Math.max(last.end, p.work.end);
			last.pairs.push(p);
		} else merged.push({ file: p.work.file, start: p.work.start, end: p.work.end, pairs: [p] });
	}

	return merged.map(({ file, start, end, pairs: group }) => {
		const scanners = [...new Set(group.map((p) => p.scanner))].sort();
		const refs = [
			...new Map(
				group.map((p) => [`${p.ref.index}:${p.ref.file}:${p.ref.start}-${p.ref.end}`, p.ref]),
			).values(),
		];
		const key = `${file}\n${refs.map((r) => `${r.index}:${r.file}:${r.start}`).sort().join("\n")}`;
		return {
			id: `IP-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`,
			file,
			start,
			end,
			severity: scanners.length > 1 ? "HIGH" : "MED",
			kinds: [...new Set(group.map((p) => p.kind))].sort(),
			scanners,
			tokens: Math.max(...group.map((p) => p.tokens)),
			alsoInOwn: own.some(
				(o) => o.work.file === file && o.work.start <= end && start <= o.work.end,
			),
			refs,
		};
	});
}

/** The part of a scan result the agent may see: no reference paths, no source, no stderr. */
export function agentView(result: ScanResult): AgentView {
	return {
		status: result.status,
		score: result.score,
		findings: result.findings.map((f) => ({
			id: f.id,
			file: f.file,
			lines: `${f.start}-${f.end}`,
			severity: f.severity,
			kinds: f.kinds,
			scanners: f.scanners,
			alsoInOwn: f.alsoInOwn,
		})),
		errors: result.errors.map((e) => `${e.scanner} failed; details in the audit record`),
	};
}

async function runJscpd(config: Config, tree: string, refGroup: string): Promise<Pair[]> {
	const out = join(tree, `out-jscpd-${refGroup}`);
	const res = await run(config.jscpd, [
		join(tree, refGroup),
		join(tree, "1-work"),
		"--follow-symlinks",
		"--absolute",
		"--no-gitignore",
		"--ignore-identifiers",
		"--max-gap-lines",
		"2",
		"--min-tokens",
		String(config.minTokens),
		"--min-lines",
		String(config.minLines),
		"--reporters",
		"json",
		"--output",
		out,
		"--silent",
		"--no-tips",
	]);
	if (res.code !== 0) throw new Error(`exit ${res.code}: ${res.stderr.trim()}`);
	return parseJscpd(JSON.parse(await readFile(join(out, "jscpd-report.json"), "utf8")), tree);
}

async function runJplag(config: Config, tree: string, oldGroups: string[], languages: string[]) {
	const result = join(tree, "out-jplag");
	const res = await run(config.java, [
		"-jar",
		config.jplagJar,
		"--new",
		join(tree, "1-work"),
		"--old",
		oldGroups.map((g) => join(tree, g)).join(","),
		"-M",
		"RUN",
		"-r",
		result,
		"--overwrite",
		"--cluster-skip",
		"-n",
		"-1",
		"-t",
		String(config.jplagMinTokens),
		"--log-level=ERROR",
		"multi",
		`--languages=${languages.join(",")}`,
	]);
	if (res.code !== 0) throw new Error(`exit ${res.code}: ${(res.stderr || res.stdout).trim()}`);
	const dir = join(tree, "out-jplag-x");
	const unzip = await run("unzip", ["-q", "-o", `${result}.jplag`, "-d", dir]);
	if (unzip.code !== 0) throw new Error(`unzip: ${unzip.stderr.trim()}`);
	const info = JSON.parse(await readFile(join(dir, "runInformation.json"), "utf8"));
	const names = await readdir(join(dir, "comparisons")).catch(() => []);
	const comparisons = await Promise.all(
		names.map(async (n) => JSON.parse(await readFile(join(dir, "comparisons", n), "utf8"))),
	);
	const v = info.version ?? {};
	return {
		pairs: parseJplag(comparisons),
		version: `${v.major}.${v.minor}.${v.patch}`,
		failedSubmissions: info.failedSubmissions ?? [],
	};
}

/**
 * Scans one work repository against its restricted and own references.
 * INCOMPLETE when a scanner failed; findings of the scanners that ran are still reported.
 */
export async function scan(config: Config, repo: Repo): Promise<ScanResult> {
	const tree = await realpath(await mkdtemp(join(tmpdir(), "client-ip-")));
	const errors: ScanError[] = [];
	const pairs: Pair[] = [];
	const versions: Record<string, unknown> = {};
	try {
		const workFiles = await linkFiles(
			join(tree, "1-work"),
			repo.root,
			await listFiles(repo.root, config.ignore),
			workPlace,
		);
		const groups: string[] = [];
		for (const [group, prefix, roots] of [
			["0-ref", "r", repo.restricted],
			["0-own", "o", repo.own],
		] as const) {
			for (const [i, root] of roots.entries()) {
				// DEV-NOTE: a reference that yields no files (typo, unmounted volume, empty
				// checkout) would scan as CLEAN; it is reported as a failed scan instead.
				try {
					const linked = await linkFiles(join(tree, group, `${prefix}${i}`), root, await listFiles(root, config.ignore));
					if (!linked.length) throw new Error("no files to compare");
				} catch (error) {
					errors.push({ scanner: "config", message: `${root}: ${(error as Error).message}` });
				}
			}
			if (roots.length) groups.push(group);
		}

		versions.jscpd = (await run(config.jscpd, ["--version"])).stdout.trim() || "unknown";
		// DEV-NOTE: one jscpd run per reference group, references sorted before the work
		// tree. jscpd reports each clone against the first occurrence it saw; with work
		// first, a work file copied twice links to its sibling and the reference match
		// is never reported.
		for (const group of groups) {
			try {
				pairs.push(...(await runJscpd(config, tree, group)));
			} catch (error) {
				errors.push({ scanner: "jscpd", message: `${group}: ${(error as Error).message}` });
			}
		}

		const languages = [
			...new Set(
				workFiles
					.map((f) => JPLAG_LANGUAGES[f.split(".").pop()?.toLowerCase() ?? ""])
					.filter(Boolean),
			),
		].sort();
		versions.jplagLanguages = languages;
		if (languages.length && groups.length) {
			try {
				const jplag = await runJplag(config, tree, groups, languages);
				pairs.push(...jplag.pairs);
				versions.jplag = jplag.version;
				// DEV-NOTE: JPlag excludes a submission it cannot parse from every comparison
				// (the Java parser rejects a whole directory over one bad file), so that
				// reference or work directory goes unchecked. TOO_SMALL and NOTHING_TO_PARSE
				// mean there is nothing to compare.
				const unparsed = jplag.failedSubmissions.filter(
					(s: { submissionState: string }) =>
						s.submissionState !== "TOO_SMALL" && s.submissionState !== "NOTHING_TO_PARSE",
				);
				if (unparsed.length)
					errors.push({ scanner: "jplag", message: `not parsed: ${JSON.stringify(unparsed)}` });
				if (jplag.failedSubmissions.length)
					versions.jplagFailedSubmissions = jplag.failedSubmissions;
			} catch (error) {
				errors.push({ scanner: "jplag", message: (error as Error).message });
			}
		}
	} finally {
		await rm(tree, { recursive: true, force: true });
	}

	const findings = mergeFindings(pairs);
	return {
		status: errors.length ? "INCOMPLETE" : findings.length ? "FINDINGS" : "CLEAN",
		score: findings.reduce((sum, f) => sum + f.end - f.start + 1, 0),
		findings,
		errors,
		versions,
	};
}

/** Audit directory name of a work repository: its path relative to the home directory, '/' as '-'. */
export function auditBucket(root: string): string {
	const rel = relative(homedir(), root);
	return (rel.startsWith("..") ? root : rel).replace(/^\/+/, "").replaceAll("/", "-");
}

/**
 * Writes <home>/audit/<bucket>/<timestamp>.json with reference roots resolved, and appends
 * findings not yet listed to review.jsonl in the same directory. Returns the record path.
 */
export async function writeAudit(
	home: string,
	repo: Repo,
	result: ScanResult,
	meta: { session: string | null; trigger: string },
): Promise<string> {
	const dir = join(home, "audit", auditBucket(repo.root));
	await mkdir(dir, { recursive: true });
	const time = new Date().toISOString();
	const head = await run("git", ["-C", repo.root, "rev-parse", "HEAD"]);
	const dirty = await run("git", ["-C", repo.root, "status", "--porcelain"]);
	const findings = result.findings.map((f) => ({
		...f,
		lines: `${f.start}-${f.end}`,
		refs: f.refs.map((r) => ({
			corpus: r.corpus,
			root: (r.corpus === "restricted" ? repo.restricted : repo.own)[r.index ?? -1],
			file: r.file,
			lines: `${r.start}-${r.end}`,
		})),
	}));
	const record = {
		time,
		...meta,
		work: { root: repo.root, head: head.stdout.trim() || null, dirty: dirty.stdout.trim() !== "" },
		references: { restricted: repo.restricted, own: repo.own },
		scanners: result.versions,
		status: result.status,
		score: result.score,
		errors: result.errors,
		findings,
	};
	const path = join(dir, `${time.replace(/[:.]/g, "-")}.json`);
	await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);

	const queue = join(dir, "review.jsonl");
	// DEV-NOTE: ids are read with a pattern, not JSON.parse, so one hand-edited or truncated
	// line cannot keep new findings out of the review queue.
	const listed = new Set(
		[...(await readFile(queue, "utf8").catch(() => "")).matchAll(/"id":"(IP-[0-9a-f]{8})"/g)].map(
			(m) => m[1],
		),
	);
	const fresh = findings
		.filter((f) => !listed.has(f.id))
		.map((f) =>
			JSON.stringify({
				time,
				session: meta.session,
				id: f.id,
				file: f.file,
				lines: f.lines,
				severity: f.severity,
				alsoInOwn: f.alsoInOwn,
				refs: f.refs,
				status: "open",
			}),
		);
	if (fresh.length) await appendFile(queue, `${fresh.join("\n")}\n`);
	return path;
}

/**
 * Fingerprint of the uncommitted state of the given repositories: status, diff against
 * HEAD, and size/mtime of untracked files. "" for an empty list.
 */
export async function fingerprint(roots: string[]): Promise<string> {
	if (!roots.length) return "";
	const hash = createHash("sha1");
	for (const root of roots) {
		const status = await run("git", ["-C", root, "status", "--porcelain", "-uall"]);
		const diff = await run("git", ["-C", root, "diff", "HEAD"]);
		hash.update(`${root}\n${status.stdout}\n${diff.stdout}`);
		for (const line of status.stdout.split("\n")) {
			if (!line.startsWith("?? ")) continue;
			const info = await stat(join(root, line.slice(3))).catch(() => undefined);
			hash.update(`${line}:${info?.size}:${info?.mtimeMs}`);
		}
	}
	return hash.digest("hex");
}
