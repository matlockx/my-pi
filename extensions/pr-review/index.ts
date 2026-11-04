/**
 * PR review trigger
 *
 * Adds the pr-review skill to the system prompt of any prompt that asks for a review and links a
 * GitHub pull request (github.com/<owner>/<repo>/pull/<n>).
 *
 * DEV-NOTE: a skill is loaded only when the model matches its description, and a linked-PR review
 * request has been answered without the matching skill. Injecting the skill makes the routine
 * binding for exactly these prompts; every other prompt is left untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { prReviewUrls, reviewInstruction } from "./trigger.mjs";

const SKILL_PATH = fileURLToPath(new URL("../../skills/pr-review/SKILL.md", import.meta.url));

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const urls = prReviewUrls(event.prompt);
		if (urls.length === 0) return;
		let skill: string;
		try {
			skill = await readFile(SKILL_PATH, "utf8");
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`pr-review: skill not readable (${(err as Error).message})`, "warning");
			return;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${reviewInstruction(urls, skill)}` };
	});
}
