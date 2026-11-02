/**
 * my-pi setup check.
 *
 * On startup, creates missing my-pi symlinks (AGENTS.md for omp and pi, the
 * fish conf.d loader) where the process may write, and shows one notification
 * listing every remaining gap with the host-shell command that closes it,
 * followed by the setup.fish command that closes all of them at once.
 * Silent when the setup is complete. `/setup` runs the same checks on demand
 * and also reports a complete setup.
 *
 * Inside `nono --profile pi` ~/.config is read-only, so the fish link always
 * ends up as a printed command there. The extension never starts the GitHub
 * MCP proxy: that process must not be a child of the agent session; the host
 * starts it with ~/bin/my-pi-start, installed by setup.fish.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { notification, runChecks } from "./checks.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SETUP_SCRIPT = join(REPO, "setup.fish");

async function report(ctx: ExtensionContext, quietWhenClean: boolean): Promise<void> {
	try {
		const note = notification(await runChecks({ repo: REPO, home: homedir() }), SETUP_SCRIPT, quietWhenClean);
		if (ctx.hasUI && note) ctx.ui.notify(note.text, note.level);
	} catch (err) {
		if (ctx.hasUI) ctx.ui.notify(`my-pi setup: check failed: ${(err as Error).message}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		// DEV-NOTE: pi sets event.reason ("startup", "resume", …); omp 18.11 sends no reason, so a
		// missing reason counts as a start. Not awaited; the command probes (node,
		// github-mcp-server, port) take up to a few seconds and must not delay the first prompt.
		if (event.reason && event.reason !== "startup") return;
		void report(ctx, true);
	});

	pi.registerCommand("setup", {
		description: "Check the my-pi base setup and show what is missing",
		handler: async (_args, ctx) => {
			await report(ctx, false);
		},
	});
}
