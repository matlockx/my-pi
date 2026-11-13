/**
 * Footer label of the route the next request takes: provider, model id and credential.
 *
 * @param {{provider: string, id: string} | undefined} model Current model of the session.
 * @param {{email?: string, accountId?: string, orgName?: string, orgId?: string, projectId?: string} | undefined} identity
 *   OAuth account omp uses for the provider in this session, as returned by
 *   `authStorage.oauth.identity(provider, sessionId)`. Absent when omp sends the provider's API key
 *   instead (an API key set in config or environment, or no OAuth login stored).
 * @returns {string} `<provider>/<model id> · <account>`, e.g. `anthropic/claude-opus-5-5 · a@example.com`;
 *   the account part is `api key` without an identity.
 */
export function routeLabel(model, identity) {
	if (!model) return "no model";
	const account = identity
		? (identity.email ?? identity.accountId ?? identity.orgName ?? identity.orgId ?? identity.projectId)
		: "api key";
	return `${model.provider}/${model.id} · ${account}`;
}
