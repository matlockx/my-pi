/**
 * MCP guard policy for awslabs.aws-api-mcp-server: the base checks of
 * mcp/guard/policy.mjs (secrets and personal data in the arguments) plus the
 * tier of each AWS CLI command's profile (mcp/guard/tiers.mjs).
 *
 * call_aws takes one command or a list (cli_command). Each command is split
 * like a shell would and sorted by its operation: credential calls (secret
 * reads, decryption, tokens, assumed roles, presigned URLs), reads
 * (describe-, list-, get-, ...), destructive operations (delete-, terminate-,
 * ..., s3 rm/rb/mv, s3 sync --delete) and writes (everything else). A command
 * that cannot be parsed counts as a write on prd. suggest_aws_commands only
 * looks up documentation; any other tool needs confirmation.
 *
 * DEV-NOTE: see my-pi notes/specs/2026-11-12-kube-aws-vcluster-mcp.md (Policy).
 */

import { classify } from "../guard/policy.mjs";
import { awsTier, tierFinding, withTierFindings } from "../guard/tiers.mjs";

/** AWS CLI global options that take a value, so the value is no service or operation name. */
const VALUE_GLOBALS = new Set([
	"--profile",
	"--region",
	"--output",
	"--endpoint-url",
	"--query",
	"--color",
	"--ca-bundle",
	"--cli-read-timeout",
	"--cli-connect-timeout",
	"--cli-binary-format",
]);
/** "service operation" pairs whose answer is a secret, a credential or a token. */
const CREDENTIAL = new Set([
	"secretsmanager get-secret-value",
	"secretsmanager batch-get-secret-value",
	"kms decrypt",
	"sts assume-role",
	"sts assume-role-with-saml",
	"sts assume-role-with-web-identity",
	"sts get-session-token",
	"sts get-federation-token",
	"iam create-access-key",
	"ecr get-login-password",
	"ecr get-authorization-token",
	"ecr-public get-login-password",
	"ecr-public get-authorization-token",
	"eks get-token",
	"rds generate-db-auth-token",
	"codeartifact get-authorization-token",
	"sso get-role-credentials",
	"cognito-identity get-credentials-for-identity",
	"s3 presign",
]);
const SSM_PARAMETER_READS = new Set(["get-parameter", "get-parameters", "get-parameters-by-path"]);
const READ_OP = /^(?:describe|list|get|head|lookup|filter|search|batch-get|scan|query|tail|wait|ls)(?:-|$)/;
const DESTRUCTIVE_OP = /^(?:delete|terminate|remove|deregister|purge|revoke|detach|rm|rb|mv)(?:-|$)/;

/** Words of command split like a POSIX shell (quotes and backslashes); null when a quote is not closed. */
export function splitCommand(command) {
	const words = [];
	let word = null;
	let quote = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			else word += ch;
		} else if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === "\\" && i + 1 < command.length) word += command[++i];
			else word += ch;
		} else if (/\s/.test(ch)) {
			if (word !== null) words.push(word);
			word = null;
		} else {
			word ??= "";
			if (ch === "'" || ch === '"') quote = ch;
			else if (ch === "\\" && i + 1 < command.length) word += command[++i];
			else word += ch;
		}
	}
	if (quote) return null;
	if (word !== null) words.push(word);
	return words;
}

/**
 * Service, operation, profile (last --profile wins, as in the AWS CLI;
 * undefined when absent) and the set of flags of an `aws ...` command; null
 * when it does not start with aws or names no operation.
 */
export function parseAwsCommand(command) {
	const words = splitCommand(command);
	if (!words || words[0] !== "aws") return null;
	const positional = [];
	const flags = new Set();
	let profile;
	for (let i = 1; i < words.length; i++) {
		const word = words[i];
		if (!word.startsWith("--")) {
			if (positional.length < 2) positional.push(word);
			continue;
		}
		const eq = word.indexOf("=");
		const flag = eq === -1 ? word : word.slice(0, eq);
		flags.add(flag);
		const value = eq !== -1 ? word.slice(eq + 1) : VALUE_GLOBALS.has(flag) ? words[++i] : undefined;
		if (flag === "--profile") profile = value;
	}
	if (positional.length < 2) return null;
	return { service: positional[0], op: positional[1], profile, flags };
}

/** Kind of a parsed command: "secret", "read", "destructive" or "write". */
export function awsKind({ service, op, flags }) {
	if (CREDENTIAL.has(`${service} ${op}`)) return "secret";
	if (service === "ssm" && SSM_PARAMETER_READS.has(op) && flags.has("--with-decryption")) return "secret";
	if (service === "s3" && op === "sync" && flags.has("--delete")) return "destructive";
	if (DESTRUCTIVE_OP.test(op)) return "destructive";
	return READ_OP.test(op) ? "read" : "write";
}

/** Tier finding for one AWS CLI command (not a string: unparsable). */
function commandFinding(command, tiers) {
	const parsed = typeof command === "string" ? parseAwsCommand(command) : null;
	if (!parsed) return tierFinding("prd", "write", `unparsable command ${JSON.stringify(command)?.slice(0, 80)}`);
	const profile = parsed.profile ?? tiers?.aws?.default ?? "default";
	return tierFinding(awsTier(tiers, parsed.profile), awsKind(parsed), `profile ${profile} (${parsed.service} ${parsed.op})`);
}

/** Classifies one tools/call of the aws server; policy.tiers is the tier file. */
export function classifyAws(server, tool, args, policy = {}) {
	const base = classify(server, tool, args, policy);
	if (tool === "suggest_aws_commands") return base;
	if (tool !== "call_aws") return withTierFindings(base, [{ decision: "confirm", reason: `unknown tool ${tool}` }]);
	const raw = args && typeof args === "object" ? args.cli_command : undefined;
	const commands = Array.isArray(raw) ? raw : [raw];
	return withTierFindings(
		base,
		commands.map((command) => commandFinding(command, policy.tiers)),
	);
}
