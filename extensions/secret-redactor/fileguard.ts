/**
 * fileguard — hard-block reads of secret-bearing files (.env, *.tfvars, ...).
 *
 * Redaction is a net; this is a wall. Redaction still runs for anything that
 * slips past (e.g. `docker compose config` printing env values).
 *
 * DEV-NOTE: add new filenames to SECRET_FILES, full-path suffixes to
 * SECRET_PATHS, allow-list to ALLOWED.
 */

const SECRET_FILES = [
	/^\.env(\..+)?$/, // .env, .env.local, .env.production
	/\.tfvars(\.json)?$/, // terraform.tfvars, prod.auto.tfvars.json
	/^(id_rsa|id_ed25519|id_ecdsa)$/,
	/\.(pem|p12|pfx|key|keystore|jks)$/,
	/^(credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)$/,
];

// Paths whose basename is too generic to block alone (config.yaml), matched on
// the whole path instead. jflow's config holds Teams webhook URLs (sig=...).
// The directory itself is matched too, so `rg sig ~/.config/jflow` and globs
// (`~/.config/jflow/*.yaml` tokenises to `~/.config/jflow/`) are blocked.
const SECRET_PATHS = [/(?:^|\/)\.config\/jflow(?:\/(?:config\.ya?ml)?)?$/];

// Templates/examples carry no real values.
const ALLOWED = /\.(example|sample|template|dist|tpl)$|^\.env\.example$/;

/** True when a path's basename or whole path looks like a secret-bearing file. */
export function isSecretFile(path: string): boolean {
	if (SECRET_PATHS.some((re) => re.test(path))) return true;
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
	// eval code is scanned like a shell command: open("~/.config/...") reads too.
	if (toolName === "bash" || toolName === "eval") {
		const text = String(input.command ?? input.code ?? "");
		const hits = secretPathsInCommand(text);
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
