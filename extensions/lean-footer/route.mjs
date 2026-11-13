/**
 * @typedef {{email?: string, accountId?: string, orgName?: string, orgId?: string, projectId?: string}} Identity
 * @typedef {Identity & {active?: boolean}} Account
 */

/**
 * Footer label of the route the next request takes: provider, model id and credential.
 *
 * @param {{provider: string, id: string} | undefined} model Current model of the session.
 * @param {Identity | undefined} identity
 *   OAuth account omp reports for the provider in this session, as returned by
 *   `authStorage.oauth.identity(provider, sessionId)`. Absent when omp sends the provider's API key
 *   instead (an API key set in config or environment, or no OAuth login stored). Before omp binds an
 *   account to the session it is the first stored account, not the account the next request uses.
 * @param {Account[]} [accounts] Stored OAuth accounts of the provider in stored order, as returned by
 *   `authStorage.oauth.accounts(provider, sessionId)`; `active` marks the account bound to the session.
 *   Empty when the host does not report accounts; `identity` is then taken as bound.
 * @param {(account: Account) => number | undefined} [priorityOf] `priority` of the `auth.accountPolicies`
 *   entry matching the account, as reported by `authStorage.oauth.policy`; undefined without one.
 * @returns {string} `<provider>/<model id> · <account>`, e.g. `anthropic/claude-opus-5-5 · a@example.com`.
 *   The account part is `api key` without an identity. While no account is bound it is
 *   `account pending, config default: <account>`, or `account pending, no config default` when no
 *   stored account has a policy priority.
 */
export function routeLabel(model, identity, accounts = [], priorityOf = () => undefined) {
	if (!model) return "no model";
	const route = `${model.provider}/${model.id}`;
	if (!identity) return `${route} · api key`;
	if (accounts.length === 0 || accounts.some((a) => a.active)) return `${route} · ${accountName(identity)}`;
	const preferred = configDefault(accounts, priorityOf);
	return `${route} · account pending, ${preferred ? `config default: ${accountName(preferred)}` : "no config default"}`;
}

/** @param {Identity} account */
function accountName(account) {
	return account.email ?? account.accountId ?? account.orgName ?? account.orgId ?? account.projectId;
}

/**
 * Account with the highest policy priority; on a tie the one stored first, the order omp ranks them in.
 *
 * @param {Account[]} accounts
 * @param {(account: Account) => number | undefined} priorityOf
 * @returns {Account | undefined}
 */
function configDefault(accounts, priorityOf) {
	let best;
	let bestPriority = -Infinity;
	for (const account of accounts) {
		const priority = priorityOf(account);
		if (priority !== undefined && priority > bestPriority) {
			best = account;
			bestPriority = priority;
		}
	}
	return best;
}
