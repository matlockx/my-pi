import test from "node:test";
import assert from "node:assert/strict";

import { parseAcliStatus, projectKey } from "./guard.mjs";

test("parseAcliStatus reads site and e-mail, and leaves them undefined when logged out", () => {
	const status = "✓ Authenticated\n  Site: acme.atlassian.net\n  Email: dev@acme.example\n  Authentication Type: oauth_global\n";
	assert.deepEqual(parseAcliStatus(status), { site: "acme.atlassian.net", email: "dev@acme.example" });
	assert.deepEqual(parseAcliStatus("✗ Not logged in"), { site: undefined, email: undefined });
});

test("projectKey reads project_key, quoted or not, and is empty without a valid key", () => {
	assert.equal(projectKey("user_email: a@b.c\nproject_key: STAR\n"), "STAR");
	assert.equal(projectKey('project_key: "STAR2"\n'), "STAR2");
	assert.equal(projectKey("project_key: star\n"), "", "lower case is not a Jira key");
	assert.equal(projectKey("default_project_key: STAR\n"), "", "only the top-level key");
	assert.equal(projectKey(""), "");
});
