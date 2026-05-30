/**
 * Pi Memory Extension — Cross-session persistent memory
 *
 * Provides memory_save, memory_recall, and memory_forget tools that persist
 * insights, decisions, and patterns across Pi sessions in a SQLite database
 * at ~/.pi/memory/memories.db.
 *
 * Also auto-injects relevant memories into the system prompt and saves a
 * session summary on quit.
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
