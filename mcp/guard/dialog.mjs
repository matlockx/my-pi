/**
 * Native macOS Allow/Deny dialog for the MCP guard, shown with osascript by
 * the host process that runs the guard. The answer never passes through the
 * agent.
 */

import { execFile } from "node:child_process";

/** Seconds a dialog waits before it counts as denied; below omp's 120 s MCP timeout. */
export const DIALOG_TIMEOUT_S = 110;

// DEV-NOTE: heading, detail and the "always" label arrive as argv, never spliced into the script,
// so text from the tool arguments cannot inject AppleScript. "Deny" is default and cancel button:
// Return, Escape and the timeout all deny. "display alert" gives the bold heading plus smaller
// detail text; the optional fourth argument becomes the leftmost button, away from the default.
const SCRIPT = [
	"on run argv",
	'set choices to {"Deny", "Allow"}',
	"if (count of argv) > 3 then set beginning of choices to item 4 of argv",
	'display alert (item 1 of argv) message (item 2 of argv) as critical buttons choices default button "Deny" cancel button "Deny" giving up after ((item 3 of argv) as integer)',
	"return button returned of result",
	"end run",
].flatMap((line) => ["-e", line]);

let queue = Promise.resolve();

/**
 * Shows message in an alert and resolves "allow" when Allow was clicked,
 * "always" when the extra button labelled always was clicked, and "deny" for
 * Deny, a timeout or a failure to show the alert. Without always only Deny
 * and Allow appear. The first line of message is the bold heading, the rest
 * the detail text. Alerts are shown one at a time in call order. run defaults
 * to execFile.
 */
export function askUser(message, { always, timeoutS = DIALOG_TIMEOUT_S, run = execFile } = {}) {
	const [heading, ...detail] = message.split("\n");
	const args = [...SCRIPT, heading, detail.join("\n"), String(timeoutS), ...(always ? [always] : [])];
	const answer = queue.then(
		() =>
			new Promise((resolve) => {
				run("osascript", args, { timeout: (timeoutS + 5) * 1000 }, (err, stdout) => {
					const button = err ? "" : String(stdout).trim();
					resolve(button === "Allow" ? "allow" : always && button === always ? "always" : "deny");
				});
			}),
	);
	queue = answer;
	return answer;
}
