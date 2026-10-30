/**
 * my-pi setup check.
 *
 * On startup, creates missing my-pi symlinks (AGENTS.md for omp and pi, the
 * fish conf.d loader) where the process may write, and shows one notification
 * listing every remaining gap with the host-shell command that closes it.
 * Silent when the setup is complete. `/setup` runs the same checks on demand
 * and also reports a complete setup.
 *
 * Inside `nono --profile pi` ~/.config is read-only, so the fish link always
 * ends up as a printed command there. The extension never starts the GitHub
 * MCP proxy: that process must not be a child of the agent session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { formatReport, runChecks } from "./checks.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

async function report(ctx: ExtensionContext, quietWhenClean: boolean): Promise<void> {
	try {
		const result = await runChecks({ repo: REPO, home: homedir() });
		const text = formatReport(result);
		if (!ctx.hasUI) return;
		if (text === null) {
			if (!quietWhenClean) ctx.ui.notify("my-pi setup: complete", "info");
			return;
		}
		ctx.ui.notify(text, result.actions.length ? "warning" : "info");
	} catch (err) {
		if (ctx.hasUI) ctx.ui.notify(`my-pi setup: check failed: ${(err as Error).message}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		// DEV-NOTE: not awaited; the command probes (node, github-mcp-server, port)
		// take up to a few seconds and must not delay the first prompt.
		void report(ctx, true);
	});

	pi.registerCommand("setup", {
		description: "Check the my-pi base setup and show what is missing",
		handler: async (_args, ctx) => {
			await report(ctx, false);
		},
	});
}
