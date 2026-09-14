import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstatSync, readlinkSync, symlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

// DEV-NOTE: Symlinks agents/AGENTS.md → ~/.pi/agent/AGENTS.md on startup.
// No-op when the target is already the symlink to that source; warns and skips
// when it is any other file or link.
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;

    const source = fileURLToPath(
      new URL("../agents/AGENTS.md", import.meta.url),
    );
    const target = join(homedir(), ".pi", "agent", "AGENTS.md");

    try {
      const stats = lstatSync(target);
      // Already the symlink this extension installs — nothing to do
      if (stats.isSymbolicLink() && readlinkSync(target) === source) return;
      // Foreign file or link elsewhere — warn and skip
      ctx.ui.notify(
        `AGENTS.md already exists at ${target} — skipping install. Remove it manually to let this package manage it.`,
        "warning",
      );
      return;
    } catch {
      // Target does not exist — safe to create symlink
    }

    try {
      symlinkSync(source, target);
      ctx.ui.notify(`AGENTS.md installed: ${target} → ${source}`, "info");
    } catch (e) {
      ctx.ui.notify(`Failed to install AGENTS.md: ${e}`, "error");
    }
  });
}
