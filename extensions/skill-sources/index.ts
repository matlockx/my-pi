/**
 * Skills from GitHub links.
 *
 * `skill_install` / `/skill-install <link> [name]` installs a skill from a link
 * to a SKILL.md file or a skill directory on GitHub into my-pi/skills.
 * `skill_update` / `/skills-update` checks every skill installed that way for a
 * newer upstream version and applies it. When a source no longer exists, the
 * user chooses between keeping the local copy (excluded from future updates),
 * entering a corrected link, or skipping. Local edits are never overwritten
 * without asking.
 *
 * GITHUB_TOKEN or GH_TOKEN, when set, authenticates the GitHub calls (private
 * repositories, higher rate limit).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, exclude, install, listInstalled, readSource, relink, update } from "./sources.mjs";

const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

const KEEP = "Keep the local copy and exclude it from updates";
const RELINK = "Enter a corrected link";
const SKIP = "Skip for now (ask again next update)";
const OVERWRITE = "Overwrite local edits with the upstream version";
const SKIP_EDITS = "Keep local edits, skip this update";
const KEEP_EDITS = "Keep local edits and exclude it from updates";

type Entry = { name: string; dir: string; source?: Record<string, any>; error?: string };
type Result = { status: string; edits?: string[] };

function deps(signal?: AbortSignal) {
	return { fetch: globalThis.fetch, token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, signal };
}

function fresh(e: Entry): Entry {
	return { ...e, source: readSource(e.dir) };
}

async function resolveEdits(ctx: ExtensionContext, e: Entry, r: Result, signal?: AbortSignal): Promise<string> {
	if (!ctx.hasUI) return `${describe(r)}; run /skills-update in an interactive session to decide`;
	const choice = await ctx.ui.select(
		`${e.name}: upstream changed, local edits in ${r.edits?.join(", ")}`,
		[OVERWRITE, SKIP_EDITS, KEEP_EDITS],
	);
	if (choice === OVERWRITE) return describe(await update(fresh(e), deps(signal), { overwrite: true }));
	if (choice === KEEP_EDITS) {
		exclude(fresh(e));
		return "local edits kept; excluded from updates";
	}
	return "local edits kept; skipped this update";
}

async function resolveGone(ctx: ExtensionContext, e: Entry, signal?: AbortSignal): Promise<string> {
	const url = e.source?.url;
	if (!ctx.hasUI) return `source not found at ${url}; run /skills-update in an interactive session to keep or relink it`;
	for (;;) {
		const choice = await ctx.ui.select(`${e.name}: nothing found at ${url} (deleted, renamed, or private)`, [
			KEEP,
			RELINK,
			SKIP,
		]);
		if (choice === KEEP) {
			exclude(e);
			return "source not found; local copy kept and excluded from updates";
		}
		if (choice !== RELINK) return `source not found at ${url}; skipped`;
		const link = (await ctx.ui.input(`New GitHub link for ${e.name}`, url))?.trim();
		if (!link) continue;
		let r: Result;
		try {
			r = await relink(e, link, deps(signal));
		} catch (err) {
			ctx.ui.notify(`${e.name}: ${(err as Error).message}`, "error");
			continue;
		}
		const done = r.status === "local-edits" ? await resolveEdits(ctx, e, r, signal) : describe(r);
		return `relinked to ${link}; ${done}`;
	}
}

async function updateOne(ctx: ExtensionContext, e: Entry, signal?: AbortSignal): Promise<string> {
	if (e.error) return `error: ${e.error}`;
	let r: Result;
	try {
		r = await update(e, deps(signal));
	} catch (err) {
		return `error: ${(err as Error).message}`;
	}
	if (r.status === "gone") return resolveGone(ctx, e, signal);
	if (r.status === "local-edits") return resolveEdits(ctx, e, r, signal);
	return describe(r);
}

async function updateAll(ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
	const entries: Entry[] = listInstalled(SKILLS_DIR);
	if (!entries.length) return `No skills installed from GitHub links in ${SKILLS_DIR}.`;
	const lines: string[] = [];
	for (const e of entries) lines.push(`${e.name}: ${await updateOne(ctx, e, signal)}`);
	return lines.join("\n");
}

async function installOne(url: string, name: string | undefined, signal?: AbortSignal): Promise<string> {
	const r = await install(url, { skillsDir: SKILLS_DIR, name, ...deps(signal) });
	return `${r.name} (${r.dir}): ${describe(r)}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "skill_install",
		label: "Install skill",
		description:
			"Install a skill from a GitHub link into my-pi/skills: a link to a SKILL.md (or other skill markdown) file " +
			"(github.com/<o>/<r>/blob/<ref>/<path>, raw.githubusercontent.com/...) or to a skill directory " +
			"(github.com/<o>/<r>/tree/<ref>/<dir>, or the repository root). The source is recorded so skill_update can " +
			"update it. Installing the same link again updates it and re-enables updates.",
		parameters: Type.Object({
			url: Type.String({ description: "GitHub link to the skill file or directory" }),
			name: Type.Optional(Type.String({ description: "Skill directory name; defaults to the front matter name" })),
		}),
		async execute(_id, params, signal) {
			const text = await installOne(params.url, params.name, signal);
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "skill_update",
		label: "Update skills",
		description:
			"Check every skill installed from a GitHub link for a newer version at its source and update it. Use when the " +
			"user asks to update skills. Asks the user when a source is gone or local edits would be overwritten.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: await updateAll(ctx, signal) }], details: {} };
		},
	});

	pi.registerCommand("skill-install", {
		description: "Install a skill from a GitHub link: /skill-install <link> [name]",
		handler: async (args, ctx) => {
			const [url, name] = args.trim().split(/\s+/);
			if (!url) return ctx.ui.notify("usage: /skill-install <github link> [name]", "warning");
			try {
				ctx.ui.notify(await installOne(url, name), "info");
			} catch (err) {
				ctx.ui.notify(`skill install failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("skills-update", {
		description: "Update every skill installed from a GitHub link",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await updateAll(ctx), "info");
		},
	});
}
