/**
 * Model choice for the agent modes: the configured model when one is set,
 * else the newest model of a family (opus, sonnet, haiku, …).
 *
 * Model ids carry the family as one dash-separated token and the version as
 * the short numeric tokens around it, in either order: `claude-opus-5-5`,
 * `claude-opus-4-1-20250805`, `claude-3-5-sonnet-20241022`. An 8-digit token
 * is a release date.
 */

/** Returns { version: number[], date: number } read from the numeric tokens of id. */
function versionInfo(id) {
	const version = [];
	let date = 0;
	for (const t of String(id).toLowerCase().split("-")) {
		if (/^\d{8}$/.test(t)) date = Number(t);
		else if (/^\d{1,2}$/.test(t)) version.push(Number(t));
	}
	return { version, date };
}

/**
 * Returns { version: number[], date: number } for an id of family, or null
 * when the id does not belong to the family or carries no version.
 */
export function parseModelId(id, family) {
	if (!String(id).toLowerCase().split("-").includes(family)) return null;
	const info = versionInfo(id);
	return info.version.length ? info : null;
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

/** Returns the top-ranked model of candidates ([model, info] pairs), or null when there are none. */
function newestOf(candidates, preferProvider) {
	let best = null;
	for (const c of candidates) {
		if (!best || compareCandidates(c[0], c[1], best[0], best[1], preferProvider) > 0) best = c;
	}
	return best ? best[0] : null;
}

/**
 * Returns the model of family with the highest version from models (objects
 * with `id` and `provider`), or null when none matches. On equal versions an
 * undated alias wins over a dated snapshot, then a model of preferProvider.
 */
export function newestOfFamily(models, family, preferProvider) {
	const candidates = [];
	for (const m of models) {
		const info = parseModelId(m.id, family);
		if (info) candidates.push([m, info]);
	}
	return newestOf(candidates, preferProvider);
}

/**
 * Chooses a model. available lists the models with credentials (`id`,
 * `name`, `provider`); find(provider, id) looks a model up in the whole
 * registry. spec is the configured model, "provider/id" or "id", or undefined.
 *
 * Order: the exact provider/id from find; else the newest available model
 * whose id contains spec's id or whose name contains it (case-insensitive);
 * else the newest available model of family. Returns null when available is
 * empty or nothing matches.
 */
export function pickModel({ available, find }, spec, family, preferProvider) {
	if (!available.length) return null;
	if (spec) {
		const slash = spec.indexOf("/");
		const modelId = slash < 0 ? spec : spec.slice(slash + 1);
		const exact = slash < 0 ? null : find(spec.slice(0, slash), modelId);
		if (exact) return exact;
		const needle = modelId.toLowerCase();
		const matches = available
			.filter((m) => m.id.includes(modelId) || (m.name ?? "").toLowerCase().includes(needle))
			.map((m) => [m, versionInfo(m.id)]);
		const match = newestOf(matches, preferProvider);
		if (match) return match;
	}
	return newestOfFamily(available, family, preferProvider);
}
