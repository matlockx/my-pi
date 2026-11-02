/**
 * Wiring test for the /setup command: drives it against a mock ExtensionAPI and
 * an empty temporary HOME. The check rules are covered by checks.test.mjs.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import extension from "./index.ts";

/** Loads the extension against a mock pi in an empty HOME; os.homedir() reads $HOME. */
function setup(t: test.TestContext, hasUI = true) {
	const home = fs.mkdtempSync(join(os.tmpdir(), "setup-ext-"));
	const previous = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		process.env.HOME = previous;
		fs.rmSync(home, { recursive: true, force: true });
	});

	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notes: Array<{ text: string; level: string }> = [];
	const pi = {
		on: () => {},
		registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, spec),
	};
	const ctx = { hasUI, ui: { notify: (text: string, level: string) => notes.push({ text, level }) } };
	extension(pi as never);
	return { notes, run: () => commands.get("setup")!.handler("", ctx) };
}

test("/setup warns about the missing omp link and ends with the setup.fish command", async (t) => {
	const { notes, run } = setup(t);

	await run();

	assert.equal(notes.length, 1);
	assert.equal(notes[0].level, "warning");
	assert.match(notes[0].text, /\.omp\/agent\/AGENTS\.md missing: mkdir -p /);
	const script = fileURLToPath(new URL("../../setup.fish", import.meta.url));
	assert.ok(
		notes[0].text.endsWith(`all at once, from a host terminal: fish ${script} && my-pi-start`),
		notes[0].text,
	);
});

test("/setup stays silent without a UI", async (t) => {
	const { notes, run } = setup(t, false);

	await run();

	assert.deepEqual(notes, []);
});
