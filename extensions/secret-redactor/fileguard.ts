/**
 * fileguard — hard-block reads of secret-bearing files (.env, *.tfvars, ...),
 * keychain and gh token reads that print a secret, and irreversible acli and gh
 * commands.
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

// Keychain commands that print a stored value. The find-generic-password and
// find-internet-password commands print it with -w or -g, dump-keychain with -d.
// The separator class also covers argv lists in eval code
// (`"security", "find-generic-password", "-w"`).
const KEYCHAIN_READ =
	/\bsecurity\b\W+(?:find-(?:generic|internet)-password\b[^\n;&|]*?[\s"'`,]-[A-Za-z]*[wg][A-Za-z]*\b|dump-keychain\b[^\n;&|]*?[\s"'`,]-[A-Za-z]*d[A-Za-z]*\b)/;

const KEYCHAIN_REASON =
	"Blocked: this command prints a keychain secret into the tool trace, which is shown and logged unredacted. " +
	"Do not load secrets into the agent shell. Ask the user to run the command in their own terminal.";

// gh commands that print the stored GitHub token.
const GH_TOKEN_READ = /\bgh[\s,]+auth[\s,]+(?:token\b|status\b[^;&|]*?[\s,](?:-t|--show-token)\b)/;

// acli commands that cannot be undone, or that hand Jira access to another agent
// (rovodev). Matched after quotes and backslashes are removed, so `ac''li`,
// `"acli", "jira", ...` argv lists and `bash -c "acli ..."` read as plain words.
// Only the subcommand words directly after acli count: a flag ends the chain, so
// `--summary "remove x"` is not a verb.
const ACLI_DESTRUCTIVE =
	/\bacli(?:[\s,]+[a-z][a-z-]*)*?[\s,]+(?:delete|archive|remove|deactivate|change-owner|rovodev)\b/;

// gh commands that cannot be undone, or that the GitHub MCP guard confirms first
// (delete_file, merge_pull_request, actions_run_trigger, create_repository,
// fork_repository), plus changing a repository's visibility. Same word-chain
// matching as ACLI_DESTRUCTIVE; `*-delete` verbs cover delete-asset and item-delete.
const GH_DESTRUCTIVE =
	/\bgh(?:[\s,]+[a-z][a-z-]*)*?[\s,]+(?:(?:[a-z]+-)?delete(?:-[a-z]+)?|merge|archive|transfer|repo[\s,]+(?:create|fork)|workflow[\s,]+run|run[\s,]+(?:rerun|cancel))\b|\bgh[\s,]+repo[\s,]+edit\b[^;&|]*?--visibility\b/;

/**
 * True when a `gh api` call in quote-stripped command text writes: a GraphQL
 * mutation, an explicit method other than GET, or a field or input flag, which
 * makes gh send a POST.
 */
function ghApiWrites(bare: string): boolean {
	for (const [, args] of bare.matchAll(/\bgh[\s,]+api\b([^;&|]*)/g)) {
		if (/\bgraphql\b/.test(args)) {
			if (/\bmutation\b/.test(args)) return true;
			continue;
		}
		const method = /(?:^|[\s,])(?:-X|--method)[\s,=]*([A-Za-z]+)/.exec(args)?.[1];
		if (method ? method.toUpperCase() !== "GET" : /[\s,](?:-f|-F|--field|--raw-field|--input)\b/.test(args))
			return true;
	}
	return false;
}

const BYPASS_REASON = (cli: string, server: string) =>
	`Blocked: this ${cli} command makes an irreversible change outside the MCP guard, so the user is never asked. ` +
	`Use the ${server} MCP tool instead (it asks the user first), or ask the user to run the command in their own terminal.`;

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
		// DEV-NOTE: lines joined first so a `\`-continued shell line or a multi-line argv list in
		// eval code cannot split the command from its flag or verb; a newline-separated later
		// command may then match too, which errs on the side of blocking.
		const joined = text.replace(/\\?\n/g, " ");
		const bare = joined.replace(/["'`\\]/g, "");
		if (KEYCHAIN_READ.test(joined) || GH_TOKEN_READ.test(bare)) return KEYCHAIN_REASON;
		if (ACLI_DESTRUCTIVE.test(bare)) return BYPASS_REASON("acli", "jira");
		if (GH_DESTRUCTIVE.test(bare) || ghApiWrites(bare)) return BYPASS_REASON("gh", "github");
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
