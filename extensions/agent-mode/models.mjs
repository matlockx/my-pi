/**
 * Picks the newest model of a family (opus, sonnet, haiku, …) from a model list.
 *
 * Model ids carry the family as one dash-separated token and the version as
 * the short numeric tokens around it, in either order: `claude-opus-5-5`,
 * `claude-opus-4-1-20250805`, `claude-3-5-sonnet-20241022`. An 8-digit token
 * is a release date. Ids without the family token or without a version are
 * ignored.
 */

/**
 * Returns { version: number[], date: number } for an id of family, or null
 * when the id does not belong to the family or carries no version.
 */
export function parseModelId(id, family) {
	const tokens = String(id).toLowerCase().split("-");
	if (!tokens.includes(family)) return null;
	const version = [];
	let date = 0;
	for (const t of tokens) {
		if (/^\d{8}$/.test(t)) date = Number(t);
		else if (/^\d{1,2}$/.test(t)) version.push(Number(t));
	}
	return version.length ? { version, date } : null;
}

function compareVersions(a, b) {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d) return d;
	}
	return 0;
}

/** Positive when candidate a ranks above b: higher version, then undated alias, then preferred provider. */
function compareCandidates(a, aInfo, b, bInfo, preferProvider) {
	return (
		compareVersions(aInfo.version, bInfo.version) ||
		Number(bInfo.date !== 0) - Number(aInfo.date !== 0) ||
		Number(a.provider === preferProvider) - Number(b.provider === preferProvider)
	);
}

/**
 * Returns the model of family with the highest version from models (objects
 * with `id` and `provider`), or null when none matches. On equal versions an
 * undated alias wins over a dated snapshot, then a model of preferProvider.
 */
export function newestOfFamily(models, family, preferProvider) {
	let best = null;
	let bestInfo = null;
	for (const m of models) {
		const info = parseModelId(m.id, family);
		if (!info) continue;
		if (!best || compareCandidates(m, info, best, bestInfo, preferProvider) > 0) {
			best = m;
			bestInfo = info;
		}
	}
	return best;
}
