/**
 * Dialog flows behind the skill-sources tools and commands. Every flow takes
 * env = { skillsDir, ui, deps }: ui is the extension UI (select, input,
 * confirm, notify), or null when the session has no interactive UI; deps
 * carries fetch, token and signal for the GitHub calls. A flow returns the
 * result line reported to the user.
 */

import fs from "node:fs";
import { join } from "node:path";
import { runDepsScript, sandboxBlocked, writeDepsScript } from "./deps.mjs";
import {
	DEPS_FILE,
	describe,
	exclude,
	install,
	listInstalled,
	readSource,
	relink,
	remove,
	skillDir,
	update,
} from "./sources.mjs";

/** Option labels of the select dialogs. */
export const CHOICES = {
	keep: "Keep the local copy and exclude it from updates",
	relink: "Enter a corrected link",
	skip: "Skip for now (ask again next update)",
	overwrite: "Overwrite local edits with the upstream version",
	skipEdits: "Keep local edits, skip this update",
	keepEdits: "Keep local edits and exclude it from updates",
};

/** Asks how to handle local edits when upstream changed: overwrite, skip, or keep and exclude. */
async function resolveEdits(env, e, r) {
	if (!env.ui) return `${describe(r)}; run /skills-update in an interactive session to decide`;
	const choice = await env.ui.select(`${e.name}: upstream changed, local edits in ${r.edits.join(", ")}`, [
		CHOICES.overwrite,
		CHOICES.skipEdits,
		CHOICES.keepEdits,
	]);
	const current = { ...e, source: readSource(e.dir) };
	if (choice === CHOICES.overwrite) return describe(await update(current, env.deps, { overwrite: true }));
	if (choice === CHOICES.keepEdits) {
		exclude(current);
		return "local edits kept; excluded from updates";
	}
	return "local edits kept; skipped this update";
}

/** Asks what to do with a skill whose source is gone: keep and exclude, relink, or skip. */
async function resolveGone(env, e) {
	const url = e.source?.url;
	if (!env.ui) return `source not found at ${url}; run /skills-update in an interactive session to keep or relink it`;
	for (;;) {
		const choice = await env.ui.select(`${e.name}: nothing found at ${url} (deleted, renamed, or private)`, [
			CHOICES.keep,
			CHOICES.relink,
			CHOICES.skip,
		]);
		if (choice === CHOICES.keep) {
			exclude(e);
			return "source not found; local copy kept and excluded from updates";
		}
		if (choice !== CHOICES.relink) return `source not found at ${url}; skipped`;
		const done = await tryRelink(env, e, url);
		if (done) return done;
	}
}

/** Asks for a new link and relinks; null when the user entered nothing or the link failed (reported). */
async function tryRelink(env, e, url) {
	const link = (await env.ui.input(`New GitHub link for ${e.name}`, url))?.trim();
	if (!link) return null;
	let r;
	try {
		r = await relink(e, link, env.deps);
	} catch (err) {
		env.ui.notify(`${e.name}: ${err.message}`, "error");
		return null;
	}
	const done = r.status === "local-edits" ? await resolveEdits(env, e, r) : describe(r);
	return `relinked to ${link}; ${done}`;
}

async function updateOne(env, e) {
	if (e.error) return `error: ${e.error}`;
	let r;
	try {
		r = await update(e, env.deps);
	} catch (err) {
		return `error: ${err.message}`;
	}
	if (r.status === "gone") return resolveGone(env, e);
	if (r.status === "local-edits") return resolveEdits(env, e, r);
	return describe(r);
}

/** Updates every skill installed from a link; one result line per skill. */
export async function updateAll(env) {
	const entries = listInstalled(env.skillsDir);
	if (!entries.length) return `No skills installed from GitHub links in ${env.skillsDir}.`;
	const lines = [];
	for (const e of entries) lines.push(`${e.name}: ${await updateOne(env, e)}`);
	return lines.join("\n");
}

/** Installs or re-installs the skill behind url, asking when local edits would be overwritten. */
export async function installOne(env, url, name) {
	const r = await install(url, { skillsDir: env.skillsDir, name, ...env.deps });
	const e = { name: r.name, dir: r.dir, source: readSource(r.dir) };
	const done = r.status === "local-edits" ? await resolveEdits(env, e, r) : describe(r);
	return `${r.name} (${r.dir}): ${done}`;
}

/**
 * Writes script (when given) to the skill's DEPS_FILE and runs the file after
 * the user confirms in a dialog showing it. Without a UI, or when the user
 * declines, nothing runs and the result names the host-shell command.
 */
export async function runDeps(env, name, script) {
	const dir = skillDir(env.skillsDir, name);
	const file = script ? writeDepsScript(dir, script) : join(dir, DEPS_FILE);
	if (!fs.existsSync(file)) throw new Error(`${file} does not exist; pass the script`);
	const host = `Run it in a host shell: bash '${file}'`;
	if (!env.ui) return `${file} not run: no UI available to ask for permission. ${host}`;
	const ok = await env.ui.confirm(
		`Run the dependency install script for ${name} now?`,
		`${file}\n\nNo: nothing runs; you get the command to run it yourself.\n\n${fs.readFileSync(file, "utf8")}`,
	);
	if (!ok) return `${file} not run: the user declined. ${host}`;
	return depsRunReport(file, await runDepsScript(file, { signal: env.deps.signal }), host);
}

function depsRunReport(file, r, host) {
	const status = r.timedOut ? "timed out" : r.code === 0 ? "succeeded" : `failed (exit ${r.code ?? r.signal})`;
	let hint = "";
	if (r.code !== 0)
		hint = sandboxBlocked(r.output)
			? `\nThe run was blocked by the sandbox or file permissions. ${host}`
			: `\nIf this failed because of the sandbox, run it in a host shell: bash '${file}'`;
	return `${file} ${status}.${hint}\n--- output (last part) ---\n${r.output}`;
}

/** Deletes a skill after the user confirms; throws without a UI. */
export async function removeOne(env, name) {
	if (!env.ui) throw new Error(`skill ${name} not deleted: no UI available for the confirmation`);
	const r = await remove(env.skillsDir, name, ({ dir, url }) =>
		env.ui.confirm(
			`Delete skill ${name}?`,
			`${dir}\n\n${url ? `Installed from ${url}; /skill-install can bring it back.` : "Not installed from a link; only git can restore it, and only if it was committed."}`,
		),
	);
	return r.deleted ? `deleted ${r.dir}` : `skill ${name} kept: deletion declined`;
}
