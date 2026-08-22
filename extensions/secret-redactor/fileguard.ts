/**
 * fileguard — hard-block reads of secret-bearing files (.env, *.tfvars, ...).
 *
 * Redaction is a net; this is a wall. Redaction still runs for anything that
 * slips past (e.g. `docker compose config` printing env values).
 *
 * DEV-NOTE: add new filenames to SECRET_FILES / allow-list to ALLOWED.
 */

const SECRET_FILES = [
	/^\.env(\..+)?$/, // .env, .env.local, .env.production
	/\.tfvars(\.json)?$/, // terraform.tfvars, prod.auto.tfvars.json
	/^(id_rsa|id_ed25519|id_ecdsa)$/,
	/\.(pem|p12|pfx|key|keystore|jks)$/,
	/^(credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)$/,
];

// Templates/examples carry no real values.
const ALLOWED = /\.(example|sample|template|dist|tpl)$|^\.env\.example$/;

/** True when a path's basename looks like a secret-bearing file. */
export function isSecretFile(path: string): boolean {
	const base = path.split("/").pop() ?? "";
	if (!base || ALLOWED.test(base)) return false;
	return SECRET_FILES.some((re) => re.test(base));
}

/** Path-ish tokens in a shell command that name a secret file. */
export function secretPathsInCommand(command: string): string[] {
	return (command.match(/[\w./~@-]+/g) ?? []).filter(isSecretFile);
}

const REASON = (what: string) =>
	`Blocked: ${what} is a secret-bearing file. Do not read it. ` +
	`Ask the user for the specific value, or read a .example/.template variant. ` +
	`To inspect keys only: \`rg -o '^[A-Z_]+=' <file> | head\` is still blocked — ask instead.`;

/**
 * Decide whether a tool call must be blocked.
 * Returns a reason string, or undefined to allow.
 */
export function checkToolCall(
	toolName: string,
	input: Record<string, unknown>,
): string | undefined {
	if (toolName === "bash") {
		const hits = secretPathsInCommand(String(input.command ?? ""));
		return hits.length ? REASON(hits[0]) : undefined;
	}
	// Any other tool: block when a path-ish argument names a secret file.
	for (const key of ["path", "file", "filePath", "filename"]) {
		const v = input[key];
		if (typeof v === "string" && isSecretFile(v)) return REASON(v);
	}
	const paths = input.paths;
	if (Array.isArray(paths)) {
		const hit = paths.find((p) => typeof p === "string" && isSecretFile(p));
		if (hit) return REASON(String(hit));
	}
	return undefined;
}
