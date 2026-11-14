/**
 * `apply_change`: the dialog text and applying a Builder's round patch to the user's checkout.
 * Nothing is committed; a patch that does not apply stays where it is and is reported.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { patchStats } from "./rounds.mjs";

const execFileP = promisify(execFile);

/**
 * Title and options of the apply dialog. `qa` is the latest QA report of the run (or undefined),
 * `qaRequired` whether the lane or a trigger requires QA.
 */
export function applyDialog({ builder, round, patch, qa, qaRequired }) {
	const stats = patchStats(patch);
	const files = stats.files.map((f) => `${f.path} (+${f.added} -${f.removed})`).join(", ");
	let verdict = "no QA (not required)";
	if (qa) verdict = `QA ${qa.verdict}${qa.findings?.length ? `, ${qa.findings.length} finding(s)` : ""}`;
	else if (qaRequired) verdict = "QA required but not run";
	const warn = qaRequired && qa?.verdict !== "PASS" ? " Applying overrides QA." : "";
	return {
		title: `Apply ${builder} round ${round} to your checkout? ${verdict}.${warn} ${files || "empty patch"}`,
		options: ["Apply (no commit)", "Do not apply"],
	};
}

// git apply errors from execFile carry stderr; anything else falls back to its message.
const errorText = (err) => String(err.stderr || err.message).trim();

// Why the patch cannot be applied without git, or undefined.
function unappliable(patchFile, patchText) {
	if (!patchText?.trim()) return "The patch is empty: the Builder changed nothing.";
	if (patchStats(patchText).nested) return `The patch changes a nested repository or submodule; apply it by hand: ${patchFile}`;
	return undefined;
}

/**
 * Applies `patch` (file path) at `top`, the top level of the user's checkout. Returns
 * `{ ok: true }` or `{ ok: false, error }`; on failure the checkout is unchanged.
 */
export async function applyPatch(top, patchFile, patchText) {
	const refused = unappliable(patchFile, patchText);
	if (refused) return { ok: false, error: refused };
	try {
		await execFileP("git", ["-C", top, "apply", "--check", patchFile], { timeout: 30_000 });
	} catch (err) {
		return { ok: false, error: `The patch does not apply to the checkout as it is now (kept at ${patchFile}): ${errorText(err)}` };
	}
	await execFileP("git", ["-C", top, "apply", patchFile], { timeout: 30_000 });
	return { ok: true };
}
