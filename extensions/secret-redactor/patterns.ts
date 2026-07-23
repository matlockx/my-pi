/**
 * Secret detection rules. Curated from the gitleaks default ruleset —
 * high-confidence provider tokens plus private keys and assignment-style
 * generic secrets. Each rule is a global regex.
 *
 * secretGroup: when set, only that capture group is replaced (keeps the
 * surrounding key name / prefix intact). When unset, the whole match is
 * replaced (token-shaped patterns).
 *
 * DEV-NOTE: add rules here, not in index.ts. Keep the global flag.
 */

export interface Rule {
	name: string;
	regex: RegExp;
	secretGroup?: number;
}

export const RULES: Rule[] = [
	// --- Private keys / certs (whole-match) ---
	{
		name: "private-key",
		regex:
			/-----BEGIN[ A-Z0-9]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9]*PRIVATE KEY-----/g,
	},

	// --- Cloud providers ---
	{
		name: "aws-access-key",
		regex:
			/\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
	},
	{ name: "gcp-api-key", regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
	// GCP service-account private_key_id + client_email are covered by generic/private-key.

	// --- Source hosts ---
	{ name: "github-pat", regex: /\bghp_[0-9A-Za-z]{36}\b/g },
	{ name: "github-oauth", regex: /\bgho_[0-9A-Za-z]{36}\b/g },
	{ name: "github-app", regex: /\b(?:ghu|ghs)_[0-9A-Za-z]{36}\b/g },
	{ name: "github-refresh", regex: /\bghr_[0-9A-Za-z]{36}\b/g },
	{ name: "github-fine-grained", regex: /\bgithub_pat_[0-9A-Za-z_]{82}\b/g },
	{ name: "gitlab-pat", regex: /\bglpat-[0-9A-Za-z\-_]{20}\b/g },

	// --- LLM / AI providers ---
	{ name: "anthropic-key", regex: /\bsk-ant-[0-9A-Za-z\-_]{20,}\b/g },
	{ name: "openai-key", regex: /\bsk-(?:proj-)?[0-9A-Za-z\-_]{20,}\b/g },

	// --- SaaS tokens ---
	{ name: "slack-token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,48}\b/g },
	{
		name: "slack-webhook",
		regex:
			/https:\/\/hooks\.slack\.com\/services\/T[0-9A-Za-z]+\/B[0-9A-Za-z]+\/[0-9A-Za-z]+/g,
	},
	{
		name: "stripe-key",
		regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/g,
	},
	{
		name: "sendgrid-key",
		regex: /\bSG\.[0-9A-Za-z\-_]{22}\.[0-9A-Za-z\-_]{43}\b/g,
	},
	{ name: "twilio-key", regex: /\bSK[0-9a-fA-F]{32}\b/g },
	{ name: "npm-token", regex: /\bnpm_[0-9A-Za-z]{36}\b/g },
	{ name: "pypi-token", regex: /\bpypi-AgEIcHlwaS5vcmc[0-9A-Za-z\-_]{50,}\b/g },
	{ name: "hashicorp-vault", regex: /\b(?:hvs|hvb)\.[0-9A-Za-z\-_]{24,}\b/g },
	{
		name: "square-token",
		regex: /\b(?:sq0atp-|sq0csp-|EAAA)[0-9A-Za-z\-_]{22,}\b/g,
	},
	{ name: "doppler-token", regex: /\bdp\.pt\.[0-9A-Za-z]{43}\b/g },

	// --- JWT ---
	{
		name: "jwt",
		regex: /\beyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g,
	},

	// --- Generic assignment-style (redact only the value group) ---
	// key = value / key: value where key names a secret. Handles BOTH quoted
	// ("v" / 'v') and unquoted .env-style (KEY=value). Value stops at whitespace
	// or a quote. Only the value group is redacted. An optional trailing _id / _ids
	// is tolerated so keys like aws_access_key_id are matched (the _id would
	// otherwise sit between the keyword and the separator and break the match).
	{
		name: "generic-secret-assignment",
		regex:
			/(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|secret[_-]?access[_-]?key|access[_-]?key|auth|credential|private[_-]?key|client[_-]?secret)(?:[_-]?ids?)?["']?\s*[:=]\s*["']?([^\s"'[\]]{12,})/gi,
		secretGroup: 1,
	},
	// Bearer / Authorization headers.
	{
		name: "authorization-bearer",
		regex:
			/(?:authorization|bearer)["']?\s*[:=]?\s*(?:Bearer\s+)?([0-9A-Za-z\-_.=]{20,})/gi,
		secretGroup: 1,
	},
	// Connection strings with inline credentials: proto://user:pass@host
	{
		name: "connection-string-password",
		regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s:/@]{6,})@/gi,
		secretGroup: 1,
	},
];
