/**
 * Facts about what a skill depends on, collected before it is installed or
 * re-installed: the links it contains, the commands it names and whether each
 * is on PATH, and the other skills it refers to and whether they are installed.
 * The facts are hints extracted from text; deciding what a skill really needs
 * is left to the reader of the facts.
 */

import fs from "node:fs";
import { delimiter, join } from "node:path";
import { DEPS_FILE, preview, readSource, skillDir } from "./sources.mjs";

const flags = (words) => Object.fromEntries(words.split(" ").map((w) => [w, true]));
const SHELL_LANGS = { "": true, ...flags("sh bash shell console zsh fish terminal") };
const WRAPPERS = flags("sudo npx uvx bunx pipx exec env");
const BUILTINS = flags(
	"cd echo export set unset if then else elif fi for while do done case esac source alias read return exit true false test",
);
const COMMAND = /^[a-z][a-z0-9._+-]*$/;

/** Returns the distinct http(s) links in texts as { url, file, github }, github being { owner, repo } for GitHub repository links. */
export function findLinks(texts) {
	const seen = new Map();
	for (const [file, text] of Object.entries(texts)) {
		for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
			const url = m[0].replace(/[.,;:!?]+$/, "");
			if (seen.has(url)) continue;
			const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/#?]+)\/([^/#?]+)/.exec(url);
			const github = gh && !["orgs", "topics", "settings"].includes(gh[1]) ? { owner: gh[1], repo: gh[2].replace(/\.git$/, "") } : null;
			seen.set(url, { url, file, github });
		}
	}
	return [...seen.values()];
}

/**
 * Returns the command names texts ask to run, sorted: the first word of each
 * line in shell code blocks (after a `$ ` prompt and wrappers such as sudo or
 * npx; `./tool` counts as tool) and names in phrases such as "use the X tool".
 */
export function findCommands(texts) {
	const out = new Set();
	const add = (word) => {
		const name = word?.replace(/^\.\//, "").toLowerCase();
		if (name && COMMAND.test(name) && !Object.hasOwn(BUILTINS, name)) out.add(name);
	};
	for (const text of Object.values(texts)) {
		for (const block of text.matchAll(/^```([\w-]*)[^\n]*\n([\s\S]*?)^```/gm)) {
			if (!Object.hasOwn(SHELL_LANGS, block[1].toLowerCase())) continue;
			for (const raw of block[2].split("\n")) {
				const words = raw.trim().replace(/^[$>%]\s+/, "").split(/\s+/);
				if (!words[0] || words[0].startsWith("#") || words[0].includes("=")) continue;
				add(Object.hasOwn(WRAPPERS, words[0]) && words[1] ? words[1] : words[0]);
			}
		}
		const prose = /\b(?:use|run|install|requires?|needs?)\s+(?:the\s+)?`?([a-z][\w.+-]*)`?\s+(?:tool|cli|command|binary|utility)\b/gi;
		for (const m of text.matchAll(prose)) add(m[1]);
		for (const m of text.matchAll(/`([a-z][\w.+-]*)`\s+(?:tool|cli|command|binary)\b/gi)) add(m[1]);
	}
	return [...out].sort();
}

/** Returns the full path of command in the directories of pathEnv, or null. */
export function onPath(command, pathEnv) {
	for (const dir of String(pathEnv ?? "").split(delimiter)) {
		if (!dir) continue;
		const p = join(dir, command);
		try {
			fs.accessSync(p, fs.constants.X_OK);
			if (fs.statSync(p).isFile()) return p;
		} catch {
			// Not in this directory.
		}
	}
	return null;
}

/** Returns the skill names texts refer to via skill://, /skill:, "the X skill" or "`X` skill", sorted. */
export function findSkillRefs(texts) {
	const out = new Set();
	for (const text of Object.values(texts)) {
		for (const m of text.matchAll(/skill:\/\/([a-z0-9._-]+)/gi)) out.add(m[1].toLowerCase());
		for (const m of text.matchAll(/(?:^|\s)\/skill:([a-z0-9._-]+)/gim)) out.add(m[1].toLowerCase());
		for (const m of text.matchAll(/\bthe\s+`?([a-z0-9][a-z0-9._-]*)`?\s+skill\b/gi)) out.add(m[1].toLowerCase());
		for (const m of text.matchAll(/`([a-z0-9][a-z0-9._-]*)`\s+skill\b/gi)) out.add(m[1].toLowerCase());
	}
	return [...out].sort();
}

/** Combines the extracted facts for one skill's texts; self is excluded from the skill references. */
export function dependencyFacts(texts, { skillsDir, self, pathEnv }) {
	return {
		links: findLinks(texts),
		commands: findCommands(texts).map((name) => ({ name, path: onPath(name, pathEnv) })),
		skills: findSkillRefs(texts)
			.filter((name) => name !== self)
			.map((name) => ({ name, installed: fs.existsSync(join(skillsDir, name, "SKILL.md")) })),
	};
}

function localTexts(dir) {
	const texts = {};
	for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!e.isFile() || e.name === ".source.json" || e.name === DEPS_FILE) continue;
		const p = join(e.parentPath ?? e.path, e.name);
		const buf = fs.readFileSync(p);
		if (buf.length <= 200_000 && !buf.includes(0)) texts[p.slice(dir.length + 1)] = buf.toString("utf8");
	}
	return texts;
}

/**
 * Analyses a skill without changing anything. target is a GitHub link (the
 * upstream files are read) or the name of a skill in skillsDir (a skill
 * installed from a link is read from its link, falling back to the local copy
 * when the link is gone or excluded from updates). Returns { target, origin,
 * name, url, installed, depsScript, files, texts, facts }; origin is
 * "upstream" or "local", depsScript the content of DEPS_FILE or null.
 */
export async function analyze(target, { skillsDir, pathEnv, ...deps }) {
	const isLink = /^https?:\/\//i.test(String(target).trim());
	let origin;
	let name;
	let url = null;
	let texts;
	let files;
	let note = null;
	if (isLink) {
		const p = await preview(target, deps);
		({ name, texts, files } = p);
		url = p.src.url;
		origin = "upstream";
	} else {
		const dir = skillDir(skillsDir, target);
		name = target;
		let source = null;
		try {
			source = readSource(dir);
		} catch (err) {
			note = `source record unreadable: ${err.message}`;
		}
		url = source?.url ?? null;
		if (source && source.updates !== false) {
			try {
				const p = await preview(source.url, deps);
				({ texts, files } = p);
				origin = "upstream";
			} catch (err) {
				note = `link not readable (${err.message}); local copy analysed`;
			}
		}
		if (!texts) {
			texts = localTexts(dir);
			files = Object.keys(texts).sort();
			origin = "local";
		}
	}
	const dir = (() => {
		try {
			return skillDir(skillsDir, name);
		} catch {
			return null;
		}
	})();
	const depsPath = dir && join(dir, DEPS_FILE);
	return {
		target: String(target).trim(),
		origin,
		...(note && { note }),
		name,
		url,
		installed: Boolean(dir),
		depsScript: depsPath && fs.existsSync(depsPath) ? fs.readFileSync(depsPath, "utf8") : null,
		files,
		facts: dependencyFacts(texts, { skillsDir, self: name, pathEnv }),
		texts,
	};
}
