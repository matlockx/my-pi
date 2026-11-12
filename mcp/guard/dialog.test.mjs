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

test("resolves allow only when Allow was clicked, deny otherwise", async () => {
	const { run } = fakeRun([null, "Allow\n"], [null, "\n"], [Object.assign(new Error("User canceled"), { code: 1 }), ""]);
	assert.equal(await askUser("github: delete_file", { run }), "allow");
	assert.equal(await askUser("github: delete_file", { run }), "deny", "timeout returns no button");
	assert.equal(await askUser("github: delete_file", { run }), "deny", "Deny is the cancel button");
});

test("offers the always button only when labelled, and resolves always for it", async () => {
	const { run, calls } = fakeRun([null, "Always allow other\n"], [null, "Always allow other\n"]);
	assert.equal(await askUser("h\nd", { run, timeoutS: 7, always: "Always allow other" }), "always");
	assert.equal(await askUser("h\nd", { run, timeoutS: 7 }), "deny", "a label nobody offered does not count");
	assert.deepEqual(calls[0].args.slice(-4), ["h", "d", "7", "Always allow other"]);
	assert.deepEqual(calls[1].args.slice(-3), ["h", "d", "7"]);
});

test("passes heading and detail as arguments, never inside the script", async () => {
	const { run, calls } = fakeRun([null, "Deny\n"]);
	const heading = '" & (do shell script "touch /tmp/pwned") & "';
	const detail = 'line 2 " & quit & "\nline 3';
	await askUser(`${heading}\n${detail}`, { run, timeoutS: 7 });
	const { cmd, args } = calls[0];
	assert.equal(cmd, "osascript");
	assert.deepEqual(args.slice(-3), [heading, detail, "7"]);
	assert.ok(args.filter((_, i) => args[i - 1] === "-e").every((line) => !line.includes(heading) && !line.includes("quit")));
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
