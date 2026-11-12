import test from "node:test";
import assert from "node:assert/strict";

import { serverEnv } from "./guard.mjs";

test("serverEnv switches file access and telemetry off and sets the profile only when one is given", () => {
	const env = serverEnv({ PATH: "/bin", AWS_API_MCP_TELEMETRY: "true" }, "test", "/w");
	assert.equal(env.PATH, "/bin");
	assert.equal(env.AWS_API_MCP_PROFILE_NAME, "test");
	assert.equal(env.AWS_API_MCP_ALLOW_UNRESTRICTED_LOCAL_FILE_ACCESS, "no-access");
	assert.equal(env.AWS_API_MCP_TELEMETRY, "false", "overrides the inherited value");
	assert.equal(env.AWS_API_MCP_WORKING_DIR, "/w/work");
	assert.equal("AWS_API_MCP_PROFILE_NAME" in serverEnv({}, undefined, "/w"), false);
});
