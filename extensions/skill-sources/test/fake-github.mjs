/**
 * Fake GitHub for the skill-sources tests, serving the git trees API and raw
 * downloads from state.repos:
 * { "<owner>/<repo>": { HEAD: "<default ref>", refs: { "<ref>": { "<path>": text | { text, mode } } } } }.
 *
 * state.apiStatus ({ status, headers }) makes every API call answer with that
 * status; state.truncated marks tree listings as truncated; state.corrupt makes
 * raw downloads return content that does not match the listed blob SHA.
 */

import { blobSha } from "../sources.mjs";

export const SKILL = (name, body = "Body.") => `---\nname: ${name}\ndescription: Test skill.\n---\n\n${body}\n`;

const text = (c) => (typeof c === "string" ? c : c.text);
const resp = (status, body = "", headers = {}) => new Response(body, { status, headers });
const refsOf = (repo, ref) => repo?.refs[ref === "HEAD" ? repo.HEAD : ref];

function treeListing(state, u) {
	const m = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/.exec(u.pathname);
	const spec = decodeURIComponent(m[3]);
	const i = spec.indexOf(":");
	const files = refsOf(state.repos[`${m[1]}/${m[2]}`], i < 0 ? spec : spec.slice(0, i));
	const prefix = i < 0 || !spec.slice(i + 1) ? "" : `${spec.slice(i + 1)}/`;
	const below = Object.entries(files ?? {}).filter(([p]) => p.startsWith(prefix));
	if (!below.length) return resp(404);
	const recursive = u.searchParams.has("recursive");
	const tree = [];
	const dirs = new Set();
	for (const [p, c] of below) {
		const rel = p.slice(prefix.length);
		if (!recursive && rel.includes("/")) {
			dirs.add(rel.split("/")[0]);
			continue;
		}
		const buf = Buffer.from(text(c));
		tree.push({ path: rel, type: "blob", mode: c.mode ?? "100644", sha: blobSha(buf), size: buf.length });
	}
	for (const d of dirs) tree.push({ path: d, type: "tree", mode: "040000", sha: "t" });
	return Response.json({ sha: "root", tree, truncated: Boolean(state.truncated) });
}

function rawFile(state, u) {
	const [owner, repoName, ...rest] = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	const repo = state.repos[`${owner}/${repoName}`];
	for (let i = 1; i < rest.length; i++) {
		const c = refsOf(repo, rest.slice(0, i).join("/"))?.[rest.slice(i).join("/")];
		if (c !== undefined) return resp(200, state.corrupt ? "tampered" : text(c));
	}
	return resp(404);
}

/** Returns { fetch, calls } where calls lists every requested URL. */
export function fakeGitHub(state) {
	const calls = [];
	const fetch = async (url) => {
		calls.push(url);
		const u = new URL(url);
		if (u.hostname !== "api.github.com") return rawFile(state, u);
		if (state.apiStatus) return resp(state.apiStatus.status, "", state.apiStatus.headers);
		return treeListing(state, u);
	};
	return { fetch, calls };
}
