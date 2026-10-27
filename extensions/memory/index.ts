/**
 * Pi Memory Extension — Cross-session persistent memory
 *
 * Provides memory_save, memory_recall, and memory_forget tools that persist
 * insights, decisions, and patterns across Pi sessions in a SQLite database
 * at ~/.pi/memory/memories.db.
 *
 * Also auto-injects relevant memories into the system prompt and saves a
 * session summary on quit.
 *
 * Sharing with a team: ~/.pi/memory/shared.json lists git checkouts and the
 * projects exported to each, e.g. [{ "repo": "~/projects/stardust-agent-memory",
 * "projects": ["payment-service"] }]. /memory-share writes local memories of those
 * projects (except session summaries and preferences) as <repo>/<project>/<id>.md
 * for review in a pull request; every session start imports all files of the
 * checkouts and drops imported memories whose file is gone. Git stays manual.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStorage } from "./storage";
import { registerTools } from "./tools";
import { registerHooks, registerCommands } from "./hooks";

export default function (pi: ExtensionAPI): void {
	const storage = new MemoryStorage();

	registerTools(pi, storage);
	registerHooks(pi, storage);
	registerCommands(pi, storage);

	// Clean up DB connection on shutdown
	pi.on("session_shutdown", async () => {
		storage.close();
	});
}
