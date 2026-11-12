/**
 * Native macOS Allow/Deny dialog for the MCP guard, shown with osascript by
 * the host process that runs the guard. The answer never passes through the
 * agent.
 */

import { execFile } from "node:child_process";

/** Seconds a dialog waits before it counts as denied; below omp's 120 s MCP timeout. */
export const DIALOG_TIMEOUT_S = 110;

// DEV-NOTE: message and title arrive as argv, never spliced into the script, so text from
// the tool arguments cannot inject AppleScript. "Deny" is default and cancel button: Return,
// Escape and the timeout all deny.
const SCRIPT = [
	"on run argv",
	'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" giving up after ((item 3 of argv) as integer) with icon caution',
	"return button returned of result",
	"end run",
].flatMap((line) => ["-e", line]);

let queue = Promise.resolve();

/**
 * Shows message in an Allow/Deny dialog and resolves true only when Allow was
 * clicked; Deny, a timeout or a failure to show the dialog resolve false.
 * Dialogs are shown one at a time in call order. run defaults to execFile.
 */
export function askUser(message, { title = "MCP guard", timeoutS = DIALOG_TIMEOUT_S, run = execFile } = {}) {
	const answer = queue.then(
		() =>
			new Promise((resolve) => {
				run("osascript", [...SCRIPT, message, title, String(timeoutS)], { timeout: (timeoutS + 5) * 1000 }, (err, stdout) =>
					resolve(!err && String(stdout).trim() === "Allow"),
				);
			}),
	);
	queue = answer;
	return answer;
}
