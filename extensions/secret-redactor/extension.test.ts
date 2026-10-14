/**
 * Wiring test for the extension: drives each hook against a mock ExtensionAPI
 * and asserts redaction, toggle gating, input-source guard, and log behavior.
 * No framework — run: `node --experimental-strip-types extension.test.ts`
 *
 * Covers the glue; detection rules are covered by redact.ts's own self-check.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the audit log at a temp file BEFORE importing the extension (module reads env at load).
const logPath = join(
	mkdtempSync(join(tmpdir(), "secret-redactor-")),
	"audit.log",
);
process.env.PI_SECRET_REDACTOR_LOG = logPath;

const { default: extension } = await import("./index.ts");

// --- minimal mock pi + ctx ---
type Handler = (event: any, ctx: any) => any;
const handlers = new Map<string, Handler>();
const commands = new Map<
	string,
	{ handler: (args: string, ctx: any) => any }
>();

const pi = {
	on: (name: string, fn: Handler) => handlers.set(name, fn),
	registerCommand: (name: string, def: any) => commands.set(name, def),
	registerTool: () => {},
} as any;

const ctx = {
	ui: { notify: () => {}, setStatus: () => {} },
	sessionManager: { getSessionId: () => "test-session" },
} as any;

extension(pi);

const GH = `ghp_${"a".repeat(36)}`;

// 1. before_provider_request redacts full payload (secret gone, non-secrets kept)
{
	const out = handlers.get("before_provider_request")!(
		{
			payload: {
				system: "sys",
				messages: [{ role: "user", content: `use ${GH} now` }],
			},
		},
		ctx,
	);
	const s = JSON.stringify(out);
	assert.ok(!s.includes(GH), "egress: secret removed from payload");
	assert.match(s, /\[REDACTED:github-pat#[0-9a-f]{8}\]/, "egress: placeholder with id present");
	assert.ok(s.includes('"role":"user"'), "egress: non-secret fields preserved");
}

// 2. tool_result redacts content (async: unions regex + gitleaks)
{
	const out = await handlers.get("tool_result")!(
		{
			toolName: "bash",
			content: [{ type: "text", text: `AWS AKIAIOSFODNN7EXAMPLE` }],
		},
		ctx,
	);
	assert.ok(out?.content, "tool_result: returns content");
	assert.ok(
		!JSON.stringify(out.content).includes("AKIAIOSFODNN7EXAMPLE"),
		"tool_result: secret removed",
	);
}

// 3. input transforms typed secret; passes clean text through; ignores extension source
{
	const secret = await handlers.get("input")!(
		{ text: `token ${GH}`, source: "interactive" },
		ctx,
	);
	assert.equal(secret.action, "transform", "input: secret triggers transform");
	assert.ok(!secret.text.includes(GH), "input: secret removed from text");

	const clean = await handlers.get("input")!(
		{ text: "hello world", source: "interactive" },
		ctx,
	);
	assert.equal(clean.action, "continue", "input: clean text passes through");

	const fromExt = await handlers.get("input")!(
		{ text: `token ${GH}`, source: "extension" },
		ctx,
	);
	assert.equal(fromExt.action, "continue", "input: extension source skipped");
}

// 4. user_bash returns wrapped operations when enabled
{
	const out = handlers.get("user_bash")!({ command: "env" }, ctx);
	assert.equal(
		typeof out?.operations?.exec,
		"function",
		"user_bash: wraps exec",
	);
}

// 5. toggle OFF makes hooks no-op
{
	await commands.get("redact-secrets")!.handler("off", ctx);
	const out = handlers.get("before_provider_request")!(
		{ payload: { messages: [{ content: GH }] } },
		ctx,
	);
	assert.equal(out, undefined, "toggle off: egress net no-op");
	const tr = await handlers.get("tool_result")!(
		{ toolName: "bash", content: [{ type: "text", text: GH }] },
		ctx,
	);
	assert.equal(tr, undefined, "toggle off: tool_result no-op");
	const inp = await handlers.get("input")!(
		{ text: GH, source: "interactive" },
		ctx,
	);
	assert.equal(inp.action, "continue", "toggle off: input no-op");
	await commands.get("redact-secrets")!.handler("on", ctx); // restore
}

// 5b. tool_call with a placeholder asks; plain restores the value, block blocks
{
	const egress = handlers.get("before_provider_request")!(
		{ payload: { messages: [{ content: `k ${GH}` }] } },
		ctx,
	);
	const ph = JSON.stringify(egress).match(/\[REDACTED:github-pat#[0-9a-f]{8}\]/)![0];
	let offered: string[] = [];
	const uiCtx = (pick: (opts: string[]) => string | undefined) => ({
		...ctx,
		hasUI: true,
		ui: {
			...ctx.ui,
			select: async (_title: string, opts: string[]) => {
				offered = opts;
				return pick(opts);
			},
		},
	});
	const call = (content: string) => ({
		toolName: "write",
		input: { path: "x_test.go", content },
	});

	const plainEvent = call(`apiKey = "${ph}"`);
	const plain = await handlers.get("tool_call")!(
		plainEvent,
		uiCtx((o) => o.find((x) => x.startsWith("Write the plain"))),
	);
	assert.equal(plain.input.content, `apiKey = "${GH}"`, "gate: plain returned (omp)");
	assert.equal(plainEvent.input.content, `apiKey = "${GH}"`, "gate: plain mutated (pi)");
	assert.equal(plain.block, undefined, "gate: plain not blocked");

	const blocked = await handlers.get("tool_call")!(
		call(ph),
		uiCtx((o) => o.find((x) => x.startsWith("Block"))),
	);
	assert.equal(blocked.block, true, "gate: block option blocks");
	assert.ok(blocked.reason.includes(ph), "gate: reason names the placeholder");

	const dismissed = await handlers.get("tool_call")!(call(ph), uiCtx(() => undefined));
	assert.equal(dismissed.block, true, "gate: dismissed dialog blocks");

	const asIs = await handlers.get("tool_call")!(
		call(ph),
		uiCtx((o) => o.find((x) => x.startsWith("Write the placeholder"))),
	);
	assert.equal(asIs, undefined, "gate: as-is passes input unchanged");

	const unknownPh = "[REDACTED:aws-access-key#deadbeef]";
	await handlers.get("tool_call")!(
		call(`${ph} ${unknownPh}`),
		uiCtx((o) => o[0]),
	);
	assert.ok(
		!offered.some((x) => x.startsWith("Write the plain")),
		"gate: no plain option when a value is unknown",
	);

	const noUi = await handlers.get("tool_call")!(call(ph), ctx);
	assert.equal(noUi.block, true, "gate: blocks without UI");

	offered = [];
	const clean = await handlers.get("tool_call")!(
		call("no secrets"),
		uiCtx(() => "unreachable"),
	);
	assert.equal(clean, undefined, "gate: clean input passes");
	assert.deepEqual(offered, [], "gate: clean input asks nothing");
}

// 6. audit log has metadata but NEVER the secret value (security-critical)
{
	const log = readFileSync(logPath, "utf8");
	assert.ok(log.includes("github-pat"), "log: records rule name");
	assert.ok(log.includes("test-session"), "log: records session id");
	assert.ok(!log.includes(GH), "log: NEVER contains the secret value");
	assert.ok(
		!log.includes("AKIAIOSFODNN7EXAMPLE"),
		"log: no aws secret value either",
	);
}

console.log("extension wiring test: ok");

// 7. live gitleaks integration (skips gracefully when binary absent)
{
	const { scanSecrets } = await import("./gitleaks.ts");
	const present =
		spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0;
	if (present) {
		// A high-entropy token gitleaks detects. Assert it surfaces as a hit.
		const hits = await scanSecrets(
			'stripe = "sk_live_4eC39HqLyjWDarjtT1zdp7dc"',
		);
		assert.ok(hits.length >= 1, "gitleaks: returns a hit for a known token");
		assert.ok(
			hits[0].rule.startsWith("gitleaks:"),
			"gitleaks: rule is namespaced",
		);
		// Missing binary path is covered by the graceful [] fallback (returns empty, no throw).
		console.log(`gitleaks live check: ok (${hits[0].rule})`);
	} else {
		const hits = await scanSecrets("anything");
		assert.deepEqual(hits, [], "gitleaks: absent -> graceful empty fallback");
		console.log("gitleaks live check: skipped (binary absent), fallback ok");
	}
}
