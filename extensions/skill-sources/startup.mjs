/**
 * Skill check for the start of a session: skills whose dependency tools are
 * missing on this machine, and skills installed from a link whose source has
 * a newer version or is gone. The tool check is local and runs every time; the
 * upstream check calls GitHub and runs at most once per CHECK_INTERVAL_MS.
 */

import fs from "node:fs";
import { dirname, join } from "node:path";
import { onPath } from "./analyze.mjs";
import { DEPS_FILE, check, listInstalled } from "./sources.mjs";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Returns the command names a dependency script declares in `# provides:`
 * comment lines (space- or comma-separated), in order, without duplicates.
 */
export function providedCommands(script) {
	const names = [];
	for (const m of String(script).matchAll(/^#\s*provides:\s*(.*)$/gm))
		for (const name of m[1].split(/[\s,]+/)) if (name && !names.includes(name)) names.push(name);
	return names;
}

/** Returns [{ skill, missing }] for each skill whose dependency script declares commands not on pathEnv. */
export function missingTools(skillsDir, pathEnv) {
	if (!fs.existsSync(skillsDir)) return [];
	const out = [];
	for (const skill of fs.readdirSync(skillsDir).sort()) {
		const file = join(skillsDir, skill, DEPS_FILE);
		if (!fs.existsSync(file)) continue;
		const missing = providedCommands(fs.readFileSync(file, "utf8")).filter((c) => !onPath(c, pathEnv));
		if (missing.length) out.push({ skill, missing });
	}
	return out;
}

function readLastCheck(statePath) {
	try {
		return Number(JSON.parse(fs.readFileSync(statePath, "utf8")).lastCheck) || 0;
	} catch {
		return 0;
	}
}

/**
 * Returns [{ skill, status }] for link-installed skills that are "behind" or
 * "gone", or [] when the last complete check is younger than
 * CHECK_INTERVAL_MS. The check time is stored in statePath only when every
 * skill was checked, so an offline or rate-limited start retries next session.
 */
export async function upstreamFindings({ skillsDir, statePath, now = Date.now(), deps }) {
	if (now - readLastCheck(statePath) < CHECK_INTERVAL_MS) return [];
	const out = [];
	let complete = true;
	for (const entry of listInstalled(skillsDir)) {
		if (entry.error) continue;
		try {
			const { status } = await check(entry, deps);
			if (status === "behind" || status === "gone") out.push({ skill: entry.name, status });
		} catch {
			complete = false;
		}
	}
	if (complete) {
		fs.mkdirSync(dirname(statePath), { recursive: true });
		fs.writeFileSync(statePath, `${JSON.stringify({ lastCheck: now })}\n`);
	}
	return out;
}

/** Builds the session-start notification, or null when there is nothing to report. */
export function startupMessage(missing, upstream) {
	const lines = [
		...missing.map((m) => `- ${m.skill}: ${m.missing.join(", ")} missing → /skill-install ${m.skill}`),
		...upstream.map((u) =>
			u.status === "behind"
				? `- ${u.skill}: newer version upstream → /skills-update`
				: `- ${u.skill}: source not found → /skills-update to keep or relink`,
		),
	];
	return lines.length ? `my-pi skills:\n${lines.join("\n")}` : null;
}

/**
 * Runs both checks and shows one warning on ui when there is something to do;
 * a check failure is shown as an error. Returns the text shown, or null. Does
 * nothing when ui is null (print mode, subagents), so a session that cannot
 * show the result does not use up the daily upstream check.
 */
export async function reportSkills({ skillsDir, statePath, pathEnv, deps, ui, now }) {
	if (!ui) return null;
	try {
		const missing = missingTools(skillsDir, pathEnv);
		const text = startupMessage(missing, await upstreamFindings({ skillsDir, statePath, now, deps }));
		if (text) ui.notify(text, "warning");
		return text;
	} catch (err) {
		const text = `my-pi skills: check failed: ${err.message}`;
		ui.notify(text, "error");
		return text;
	}
}
