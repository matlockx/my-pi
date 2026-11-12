import test from "node:test";
import assert from "node:assert/strict";

import { askUser } from "./dialog.mjs";

/** execFile stand-in that records calls and answers each with the next of answers ([err, stdout]). */
function fakeRun(...answers) {
	const calls = [];
	const run = (cmd, args, opts, cb) => {
		calls.push({ cmd, args });
		const [err, stdout] = answers.shift();
		setTimeout(() => cb(err, stdout), 5);
	};
	return { run, calls };
}

test("resolves true only when Allow was clicked", async () => {
	const { run } = fakeRun([null, "Allow\n"], [null, "\n"], [Object.assign(new Error("User canceled"), { code: 1 }), ""]);
	assert.equal(await askUser("github: delete_file", { run }), true);
	assert.equal(await askUser("github: delete_file", { run }), false, "timeout returns no button");
	assert.equal(await askUser("github: delete_file", { run }), false, "Deny is the cancel button");
});

test("passes the message as an argument, never inside the script", async () => {
	const { run, calls } = fakeRun([null, "Deny\n"]);
	const message = '" & (do shell script "touch /tmp/pwned") & "';
	await askUser(message, { run, timeoutS: 7 });
	const { cmd, args } = calls[0];
	assert.equal(cmd, "osascript");
	assert.deepEqual(args.slice(-3), [message, "MCP guard", "7"]);
	assert.ok(args.filter((_, i) => args[i - 1] === "-e").every((line) => !line.includes(message)));
});

test("shows one dialog at a time in call order", async () => {
	const order = [];
	const run = (cmd, args, opts, cb) => {
		order.push(`start ${args.at(-3)}`);
		setTimeout(() => {
			order.push(`end ${args.at(-3)}`);
			cb(null, "Allow");
		}, 10);
	};
	await Promise.all([askUser("a", { run }), askUser("b", { run })]);
	assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
});
