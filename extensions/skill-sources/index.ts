/**
 * Skills from GitHub links.
 *
 * The `/skill-install <link | name>` prompt analyses a skill before installing
 * or re-installing it: `skill_analyze` reports the tools and skills it depends
 * on, the user decides whether to continue, `skill_install` / `skill_reinstall`
 * fetch it, and `skill_deps_run` writes and runs the dependency install script
 * (DEPS_FILE next to SKILL.md) after the user agrees in a dialog. `skill_install`
 * refuses links not analysed in the same session.
 *
 * `skill_update` / `/skills-update` checks every skill installed from a link for
 * a newer upstream version and applies it. When a source no longer exists, the
 * user chooses between keeping the local copy (excluded from future updates),
 * entering a corrected link, or skipping. Local edits are never overwritten
 * without asking.
 *
 * `skill_remove` / `/skill-remove <name>` deletes any skill in my-pi/skills
 * after a confirmation dialog. `skill_audit_data` returns the facts the
 * `/skills-audit` prompt judges: usage from the omp and pi session logs, last
 * change, link source state, and similar descriptions.
 *
 * GITHUB_TOKEN or GH_TOKEN, when set, authenticates the GitHub calls (private
 * repositories, higher rate limit).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { analyze } from "./analyze.mjs";
import { auditData, gitLastChanged } from "./audit.mjs";
import { installOne, removeOne, runDeps, updateAll } from "./flows.mjs";
import { DEPS_FILE, readSource, skillDir } from "./sources.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SKILLS_DIR = join(REPO, "skills");
const SESSION_DIRS = [join(homedir(), ".omp/agent/sessions"), join(homedir(), ".pi/agent/sessions")];

function deps(signal?: AbortSignal) {
	const token = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
	return { fetch: globalThis.fetch, token, signal };
}

// DEV-NOTE: the dialog flows live in flows.mjs so they can be tested with a fake UI;
// this file only registers tools and commands and builds the env they run in.
function env(ctx: ExtensionContext, signal?: AbortSignal) {
	return { skillsDir: SKILLS_DIR, ui: ctx.hasUI ? ctx.ui : null, deps: deps(signal) };
}

export default function (pi: ExtensionAPI) {
	// DEV-NOTE: install requires an analysis in the same session so the user sees the
	// skill's tool and skill dependencies before anything is written.
	const analysed = new Set<string>();

	pi.registerTool({
		name: "skill_analyze",
		label: "Analyse skill",
		description:
			"Analyse a skill before installing or re-installing it, without changing anything. target is a GitHub link, or " +
			"the name of a skill in my-pi/skills (read from its recorded link when it has one). Returns its files and text, " +
			"the links it contains (companion tool repositories), the commands it names with their PATH location (null = " +
			"missing), the skills it refers to and whether they are installed, and the existing dependency install script.",
		parameters: Type.Object({ target: Type.String({ description: "GitHub link or installed skill name" }) }),
		async execute(_id, params, signal) {
			const a = await analyze(params.target, { skillsDir: SKILLS_DIR, pathEnv: process.env.PATH, ...deps(signal) });
			for (const key of [a.target, a.name, a.url]) if (key) analysed.add(key);
			return { content: [{ type: "text", text: JSON.stringify(a, null, 1) }], details: {} };
		},
	});

	pi.registerTool({
		name: "skill_install",
		label: "Install skill",
		description:
			"Install a skill from a GitHub link into my-pi/skills: a link to a SKILL.md (or other skill markdown) file " +
			"(github.com/<o>/<r>/blob/<ref>/<path>, raw.githubusercontent.com/...) or to a skill directory " +
			"(github.com/<o>/<r>/tree/<ref>/<dir>, or the repository root). The source is recorded so skill_update can " +
			"update it. Requires skill_analyze on the same link first and the user's agreement to continue.",
		parameters: Type.Object({
			url: Type.String({ description: "GitHub link to the skill file or directory" }),
			name: Type.Optional(Type.String({ description: "Skill directory name; defaults to the front matter name" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!analysed.has(params.url.trim()))
				throw new Error(`not installed: run skill_analyze on ${params.url} first and report its dependencies to the user`);
			return { content: [{ type: "text", text: await installOne(env(ctx, signal), params.url, params.name) }], details: {} };
		},
	});

	pi.registerTool({
		name: "skill_reinstall",
		label: "Re-install skill",
		description:
			"Fetch an installed skill again from its recorded GitHub link and re-enable its updates. Asks the user before " +
			"overwriting local edits. Requires skill_analyze on the skill first. Skills not installed from a link have " +
			"nothing to fetch; handle their dependencies with skill_deps_run.",
		parameters: Type.Object({ name: Type.String({ description: "Skill directory name under my-pi/skills" }) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const source = readSource(skillDir(SKILLS_DIR, params.name));
			if (!source) throw new Error(`${params.name} was not installed from a link; nothing to fetch`);
			if (!analysed.has(params.name) && !analysed.has(source.url))
				throw new Error(`not re-installed: run skill_analyze on ${params.name} first and report its dependencies to the user`);
			return { content: [{ type: "text", text: await installOne(env(ctx, signal), source.url, params.name) }], details: {} };
		},
	});

	pi.registerTool({
		name: "skill_deps_run",
		label: "Install skill dependencies",
		description:
			`Write the dependency install script of a skill (my-pi/skills/<name>/${DEPS_FILE}, kept next to the skill and ` +
			"never touched by updates) and run it after the user agrees in a dialog that shows the whole script. Without " +
			"script, the existing file is run. Returns the output, or the command for the user to run in a host shell when " +
			"the user declines or the sandbox blocks the run. Do not ask for permission separately.",
		parameters: Type.Object({
			name: Type.String({ description: "Skill directory name under my-pi/skills" }),
			script: Type.Optional(Type.String({ description: "Full bash script; replaces the existing file" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: await runDeps(env(ctx, signal), params.name, params.script) }], details: {} };
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
			return { content: [{ type: "text", text: await updateAll(env(ctx, signal)) }], details: {} };
		},
	});

	pi.registerTool({
		name: "skill_remove",
		label: "Remove skill",
		description:
			"Delete a skill from my-pi/skills by its directory name. The user confirms each deletion in a dialog; " +
			"do not ask for confirmation separately.",
		parameters: Type.Object({ name: Type.String({ description: "Skill directory name under my-pi/skills" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: await removeOne(env(ctx), params.name) }], details: {} };
		},
	});

	pi.registerTool({
		name: "skill_audit_data",
		label: "Skill audit data",
		description:
			"Read-only facts for a skills audit (used by /skills-audit): per skill in my-pi/skills its description, " +
			"size, last commit date, link source state, and usage from the omp and pi session logs (sessions that read " +
			"or invoked it, sessions in the last 90 days, last use), plus pairs of skills with similar descriptions.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const data = await auditData({
				skillsDir: SKILLS_DIR,
				sessionDirs: SESSION_DIRS,
				lastChanged: (dir: string) => gitLastChanged(REPO, join("skills", dir)),
				...deps(signal),
			});
			return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }], details: {} };
		},
	});

	pi.registerCommand("skills-update", {
		description: "Update every skill installed from a GitHub link",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await updateAll(env(ctx)), "info");
		},
	});

	pi.registerCommand("skill-remove", {
		description: "Delete a skill from my-pi/skills after confirmation: /skill-remove <name>",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) return ctx.ui.notify("usage: /skill-remove <name>", "warning");
			try {
				ctx.ui.notify(await removeOne(env(ctx), name), "info");
			} catch (err) {
				ctx.ui.notify(`skill remove failed: ${(err as Error).message}`, "error");
			}
		},
	});
}
