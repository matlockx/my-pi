/**
 * Pure redaction core. No pi imports — importable by the self-check below.
 */

import { RULES } from "./patterns.ts";

export interface RedactResult {
	value: unknown;
	count: number;
	rules: string[];
}

/** Redact all secrets in a single string. */
export function redactString(text: string): {
	text: string;
	count: number;
	rules: string[];
} {
	let out = text;
	let count = 0;
	const rules: string[] = [];

	for (const rule of RULES) {
		rule.regex.lastIndex = 0; // global regexes are stateful; reset before reuse
		out = out.replace(rule.regex, (full: string, ...groups: unknown[]) => {
			count++;
			rules.push(rule.name);
			if (rule.secretGroup != null) {
				const secret = groups[rule.secretGroup - 1];
				if (typeof secret === "string" && secret.length > 0) {
					return full.replace(secret, `[REDACTED:${rule.name}]`);
				}
			}
			return `[REDACTED:${rule.name}]`;
		});
	}
	return { text: out, count, rules };
}

/** A secret found by an external scanner (e.g. gitleaks): the literal value + rule id. */
export interface ExternalHit {
	secret: string;
	rule: string;
}

/**
 * Redact a string with the in-process regex rules AND any external-scanner hits
 * (literal substring replacement). Regex runs first; external hits are layered
 * on top (union), so gitleaks + our rules together beat either alone.
 */
export function redactStringWith(
	text: string,
	hits: ExternalHit[] = [],
): { text: string; count: number; rules: string[] } {
	const base = redactString(text);
	let out = base.text;
	let count = base.count;
	const rules = [...base.rules];

	for (const hit of hits) {
		if (!hit.secret || hit.secret.length < 4) continue; // ignore trivially short matches
		const next = out.split(hit.secret).join(`[REDACTED:${hit.rule}]`);
		if (next !== out) {
			count++;
			rules.push(hit.rule);
			out = next;
		}
	}
	return { text: out, count, rules };
}

/** Collect every string leaf of a JSON-ish value (for feeding an external scanner once). */
export function collectStrings(value: unknown): string[] {
	const acc: string[] = [];
	const walk = (v: unknown) => {
		if (typeof v === "string") acc.push(v);
		else if (Array.isArray(v)) for (const item of v) walk(item);
		else if (v && typeof v === "object")
			for (const item of Object.values(v)) walk(item);
	};
	walk(value);
	return acc;
}

function redactDeepCore(
	value: unknown,
	fn: (s: string) => { text: string; count: number; rules: string[] },
): RedactResult {
	if (typeof value === "string") {
		const r = fn(value);
		return { value: r.text, count: r.count, rules: r.rules };
	}
	if (Array.isArray(value)) {
		let count = 0;
		const rules: string[] = [];
		const out = value.map((item) => {
			const r = redactDeepCore(item, fn);
			count += r.count;
			rules.push(...r.rules);
			return r.value;
		});
		return { value: out, count, rules };
	}
	if (value && typeof value === "object") {
		let count = 0;
		const rules: string[] = [];
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const r = redactDeepCore(v, fn);
			count += r.count;
			rules.push(...r.rules);
			out[k] = r.value;
		}
		return { value: out, count, rules };
	}
	return { value, count: 0, rules: [] };
}

/** Recursively redact every string leaf using the in-process regex rules. */
export function redactDeep(value: unknown): RedactResult {
	return redactDeepCore(value, redactString);
}

/** redactDeep + external-scanner hits layered on top. */
export function redactDeepWith(
	value: unknown,
	hits: ExternalHit[] = [],
): RedactResult {
	return redactDeepCore(value, (s) => redactStringWith(s, hits));
}

// --- self-check: `node --experimental-strip-types redact.ts` or `tsx redact.ts` ---
// ponytail: one runnable assert-based check, no framework.
if (process.argv[1]?.endsWith("redact.ts")) {
	const assert = (cond: boolean, msg: string) => {
		if (!cond) throw new Error(`FAIL: ${msg}`);
	};

	// token-shaped: whole match replaced
	assert(
		redactString("key AKIAIOSFODNN7EXAMPLE end").text ===
			"key [REDACTED:aws-access-key] end",
		"aws",
	);
	assert(
		redactString(`ghp_${"a".repeat(36)}`).text === "[REDACTED:github-pat]",
		"gh pat",
	);
	assert(redactString(`sk-ant-${"a".repeat(24)}`).count === 1, "anthropic");

	// assignment-style: only the value group replaced, key name kept
	const a = redactString('password = "hunter2hunter2hunter2"');
	assert(
		a.text.includes("password") &&
			a.text.includes("[REDACTED:generic-secret-assignment]"),
		"assignment keeps key",
	);

	// env-style unquoted (dotenv): KEY=value — the main secret vector
	const env = redactString(
		"AWS_SECRET_ACCESS_KEY=xYz1234567890+/AbCdEfGhIjKlMnOpQrStUvWxYz",
	);
	assert(env.count === 1, "env-style unquoted detected");
	assert(
		env.text.startsWith("AWS_SECRET_ACCESS_KEY=") &&
			!env.text.includes("xYz1234567890"),
		"env-style keeps key, drops value",
	);

	// _id suffix tolerated: aws_access_key_id = value (even lowercase/malformed)
	const kid = redactString("aws_access_key_id = AKIAasdfasdvasfd");
	assert(
		kid.count === 1 && !kid.text.includes("AKIAasdfasdvasfd"),
		"access_key_id suffix matched",
	);

	// private key block
	const pem =
		"-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
	assert(redactString(pem).text === "[REDACTED:private-key]", "pem");

	// connection string password only
	const cs = redactString("postgres://user:s3cr3tpass@db.example.com:5432/app");
	assert(
		cs.text.includes("user:[REDACTED:connection-string-password]@"),
		"conn string",
	);

	// deep walk hits nested strings, leaves non-secrets
	const deep = redactDeep({
		role: "user",
		content: [{ type: "text", text: `token=ghp_${"a".repeat(36)}` }],
	});
	assert(deep.count === 1, "deep count");
	assert(
		(deep.value as { role: string }).role === "user",
		"deep preserves non-secret",
	);

	// clean text untouched
	assert(redactString("just a normal sentence").count === 0, "clean");

	// external-scanner hits layered on top of regex (synthetic gitleaks findings)
	const blob = "xYz1234567890+/AbCdEfGhIjKlMnOpQrStUvWxYz";
	const withHit = redactStringWith(`bare ${blob} end`, [
		{ secret: blob, rule: "gitleaks:generic" },
	]);
	assert(
		withHit.count === 1 && !withHit.text.includes(blob),
		"external hit redacts bare blob",
	);
	assert(
		withHit.text === "bare [REDACTED:gitleaks:generic] end",
		"external hit placeholder",
	);

	// collectStrings gathers nested leaves
	const strs = collectStrings({ a: "one", b: [{ c: "two" }], n: 5 });
	assert(strs.join(",") === "one,two", "collectStrings");

	// redactDeepWith applies both regex and external hits across structure
	const deepBoth = redactDeepWith(
		{ t: [`token=ghp_${"a".repeat(36)}`, `bare ${blob}`] },
		[{ secret: blob, rule: "gitleaks:generic" }],
	);
	assert(deepBoth.count === 2, "redactDeepWith union count");

	console.log("redact self-check: ok");
}
