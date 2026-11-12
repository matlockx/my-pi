import test from "node:test";
import assert from "node:assert/strict";

import { classify, personalData, secrets } from "./policy.mjs";

const OPTS = { owners: ["bauermediagroup-stardust", "matlockx"], jiraProjects: ["STAR"], ownEmails: ["me@example.com"] };
const GH_TOKEN = `ghp_${"a".repeat(36)}`;

const decide = (server, tool, args, opts = OPTS) => classify(server, tool, args, opts);

test("destructive tools need confirmation, reads and ordinary writes pass", () => {
	assert.equal(decide("github", "delete_file", { owner: "matlockx", repo: "r", path: "a", branch: "x" }).decision, "confirm");
	assert.equal(decide("github", "merge_pull_request", { owner: "matlockx", repo: "r", pullNumber: 1 }).decision, "confirm");
	assert.equal(decide("jira", "jira_delete_issue", { issue_key: "STAR-1" }).decision, "confirm");
	assert.equal(decide("github", "add_issue_comment", { owner: "matlockx", repo: "r", issue_number: 1, body: "done" }).decision, "allow");
	assert.equal(decide("jira", "jira_transition_issue", { issue_key: "STAR-1", transition_id: "31" }).decision, "allow");
	assert.equal(decide("jflow", "review_status", { path: "/x", merge: true }).decision, "allow", "jflow merges only after a coworker approval");
});

test("file writes to the default branch need confirmation; a feature branch passes", () => {
	const file = { owner: "matlockx", repo: "r", path: "a", content: "x", message: "m" };
	assert.deepEqual(decide("github", "create_or_update_file", { ...file, branch: "main" }).reasons, ["writes files to the default branch (main)"]);
	assert.equal(decide("github", "push_files", { ...file, branch: "" }).decision, "confirm", "absent branch is the default branch");
	assert.equal(decide("github", "create_or_update_file", { ...file, branch: "feature/x" }).decision, "allow");
});

test("writes outside the owner allowlist need confirmation; reads do not", () => {
	assert.deepEqual(decide("github", "create_pull_request", { owner: "Evil", repo: "r", title: "t", head: "a", base: "b" }).reasons, [
		"repository owner Evil is not in the allowlist",
	]);
	assert.equal(decide("github", "create_branch", { owner: "MatlockX", repo: "r", branch: "b" }).decision, "allow", "owner compared case-insensitively");
	assert.equal(decide("github", "get_file_contents", { owner: "torvalds", repo: "linux", path: "README" }).decision, "allow");
	assert.equal(decide("github", "pull_request_read", { owner: "torvalds", repo: "linux", pullNumber: 1 }).decision, "allow");
});

test("Jira writes outside the project allowlist need confirmation; an empty allowlist disables the check", () => {
	assert.deepEqual(decide("jira", "jira_add_comment", { issue_key: "OTHER-7", comment: "x" }).reasons, ["Jira project OTHER is not in the allowlist"]);
	assert.equal(decide("jira", "jira_create_issue", { project_key: "STAR", summary: "s" }).decision, "allow");
	assert.equal(decide("jira", "jira_get_issue", { issue_key: "OTHER-7" }).decision, "allow", "reads pass");
	assert.equal(decide("jira", "jira_add_comment", { issue_key: "OTHER-7", comment: "x" }, { ...OPTS, jiraProjects: [] }).decision, "allow");
});

test("a secret anywhere in the arguments needs confirmation, reads included", () => {
	assert.deepEqual(decide("github", "search_code", { query: `token ${GH_TOKEN}` }).reasons, ["secret in the arguments (github-pat)"]);
	assert.equal(decide("jflow", "teams_send", { to: "aleks", message: `here: ${GH_TOKEN}` }).decision, "confirm");
	assert.equal(decide("github", "push_files", { owner: "matlockx", repo: "r", branch: "b", files: [{ path: ".env", content: GH_TOKEN }] }).decision, "confirm");
	assert.deepEqual(secrets("nothing to see"), []);
});

test("personal data in free-text fields needs confirmation; own address and other fields pass", () => {
	assert.deepEqual(decide("jira", "jira_add_comment", { issue_key: "STAR-1", comment: "mail jane.doe@corp.example" }).reasons, [
		"personal data in the arguments (e-mail)",
	]);
	assert.equal(decide("jira", "jira_add_comment", { issue_key: "STAR-1", comment: "ping Me@Example.com" }).decision, "allow");
	assert.equal(decide("jira", "jira_assign_issue", { issue_key: "STAR-1", assignee: "jane.doe@corp.example" }).decision, "allow");
});

test("personalData validates IBANs and card numbers and needs a + for phone numbers", () => {
	assert.deepEqual(personalData("pay to DE89 3704 0044 0532 0130 00"), ["iban"]);
	assert.deepEqual(personalData("pay to DE00 3704 0044 0532 0130 00"), [], "wrong IBAN checksum");
	assert.deepEqual(personalData("card 4111 1111 1111 1111"), ["card"]);
	assert.deepEqual(personalData("card 4111 1111 1111 1112"), [], "fails Luhn");
	assert.deepEqual(personalData("call +49 30 1234567"), ["phone"]);
	assert.deepEqual(personalData("build 2026 11 12 took 30 s"), []);
});
