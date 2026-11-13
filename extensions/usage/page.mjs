/**
 * HTML pages of the usage reports: one self-contained file per period (digest.mjs data) and an
 * index. Inline CSS and SVG, light and dark themes, tooltips from `title` attributes, no scripts.
 * Every text from the repository (titles, projects, labels, device names) is HTML-escaped.
 */

import { OTHER, TOKEN_PRICE } from "./digest.mjs";

const KIND_NAMES = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TOKEN_NAMES = { input: "Fresh input", cacheWrite: "Cache write", cacheRead: "Cache read", output: "Output" };
const TOP_PROJECTS = 10;
const TOP_FEATURES = 8;

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Text without private-use characters (Nerd Font icons in session titles), which most fonts draw as boxes. */
export const plain = (s) => String(s).replace(/[\uE000-\uF8FF\u{F0000}-\u{10FFFD}]/gu, "").trim();

/** Dollar amount: whole dollars from 100 up, cents below. */
export function money(v) {
	if (!v) return "$0";
	return v >= 100 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
}

/** Count with a k, M or B suffix. */
export function compact(n) {
	if (n < 1e3) return String(Math.round(n));
	if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
	return n < 1e9 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e9).toFixed(2)}B`;
}

const pct = (f, digits = 0) => `${(f * 100).toFixed(digits)}%`;

/** "45 min", "3 h", "3 h 20 min". */
export function duration(ms) {
	const min = Math.round(ms / 60_000);
	if (min < 60) return `${min} min`;
	return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min / 60} h`;
}

const clock = (ms, tz) =>
	new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);

/** Smallest of 1, 2, 2.5 or 5 times a power of ten that is at least v. */
export function niceMax(v) {
	if (!(v > 0)) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	return [1, 2, 2.5, 5, 10].map((f) => f * p).find((n) => n >= v);
}

// Series colour class: s0..s5 for named series, so for OTHER.
const seriesClass = (names, name) => (name === OTHER || names.indexOf(name) < 0 ? "so" : `s${names.indexOf(name) % 6}`);

function legend(names) {
	return `<div class="legend">${names.map((n) => `<span><i class="sw ${seriesClass(names, n)}"></i>${esc(n)}</span>`).join("")}</div>`;
}

function card(title, sub, body, cls = "") {
	return `<section class="card ${cls}"><header><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ""}</header>${body}</section>`;
}

// --- KPIs

const KPIS = [
	{ label: "API-equivalent cost", get: (t) => t.cost, fmt: money, up: "warn" },
	{ label: "Requests", get: (t) => t.requests, fmt: compact },
	{ label: "Sessions", get: (t) => t.sessions, fmt: String },
	{ label: "Active hours", get: (t) => t.activeHours, fmt: String },
	{ label: "Output tokens", get: (t) => t.output, fmt: compact },
	{ label: "Cache hit", get: (t) => t.cacheHit, fmt: (v) => pct(v, 1), up: "good", points: true },
];

function delta(k, a, b) {
	if (!(b > 0)) return a > 0 ? `<span class="delta flat">new</span>` : "";
	const d = k.points ? a - b : (a - b) / b;
	const shown = k.points ? `${(Math.abs(d) * 100).toFixed(1)} pt` : pct(Math.abs(d));
	let tone = "flat";
	if (Math.abs(d) >= 0.005 && k.up) tone = (d > 0) === (k.up === "good") ? "good" : "warn";
	return `<span class="delta ${tone}">${d >= 0 ? "▲" : "▼"} ${shown}</span>`;
}

function kpis(d) {
	const word = { daily: "the day before", weekly: "the week before", monthly: "the month before" }[d.period.kind];
	return `<section class="kpis">${KPIS.map((k) => {
		const a = k.get(d.totals);
		const b = k.get(d.previousTotals);
		return `<div class="kpi"><div class="kpi-label">${k.label}</div><div class="kpi-value">${k.fmt(a)}</div><div class="kpi-foot">${delta(k, a, b)}<span>${k.fmt(b)} ${word}</span></div></div>`;
	}).join("")}</section>`;
}

// --- Horizontal bars (HTML)

/** Rows of label, stacked bar and value; items {name, value, parts?: Map}, partNames give colours. */
function bars(items, partNames = [], fmt = money) {
	const max = Math.max(0, ...items.map((i) => i.value)) || 1;
	const row = (i) => {
		const parts = i.parts?.size ? [...i.parts] : [[partNames[0] ?? OTHER, i.value]];
		const segs = parts
			.sort(([a], [b]) => partNames.indexOf(a) - partNames.indexOf(b))
			.map(([p, v]) => `<span class="seg ${seriesClass(partNames, p)}" style="width:${((v / max) * 100).toFixed(2)}%" title="${esc(p)}: ${fmt(v)}"></span>`)
			.join("");
		return `<div class="bar-row"><div class="bar-label" title="${esc(i.name)}">${esc(i.name)}</div><div class="bar-track">${segs}</div><div class="bar-value">${fmt(i.value)}</div></div>`;
	};
	return `<div class="bars">${items.map(row).join("")}</div>`;
}

function topWithRest(items, n) {
	if (items.length <= n) return items;
	const rest = items.slice(n);
	const parts = new Map();
	for (const i of rest) for (const [p, v] of i.parts ?? []) parts.set(p, (parts.get(p) ?? 0) + v);
	return [...items.slice(0, n), { name: `${rest.length} more`, value: rest.reduce((s, i) => s + i.value, 0), parts }];
}

function projectsCard(d) {
	if (!d.projects.length) return "";
	const names = d.accountNames;
	return card("Projects", "Cost per project folder, split by account.", (names.length > 1 ? legend(names) : "") + bars(topWithRest(d.projects, TOP_PROJECTS), names));
}

function featuresCard(d) {
	if (!d.features.length) return "";
	const total = d.totals.cost || 1;
	const auto = d.automatic / total;
	const split = `<div class="split"><span class="seg s0" style="width:${pct(1 - auto, 2)}" title="Your prompts: ${money(d.totals.cost - d.automatic)}"></span><span class="seg s2" style="width:${pct(auto, 2)}" title="Automatic: ${money(d.automatic)}"></span></div>
<div class="split-legend"><span><i class="sw s0"></i>Your prompts ${pct(1 - auto)}</span><span><i class="sw s2"></i>Automatic ${pct(auto)} · ${money(d.automatic)}</span></div>`;
	return card(
		"Features",
		"What started each request: your prompts and slash commands, or an extension (quick-review fixes, jflow watcher, side calls).",
		split + bars(d.features.slice(0, TOP_FEATURES)),
	);
}

// --- Time charts (SVG)

function columns(d) {
	const W = 1000;
	const H = 260;
	const [L, R, T, B] = [52, 8, 14, 28];
	const list = d.timeline;
	const top = niceMax(Math.max(0, ...list.map((b) => b.value)));
	const slot = (W - L - R) / list.length;
	const y = (v) => T + (1 - v / top) * (H - T - B);
	const names = [...d.series, OTHER];
	const out = [];
	for (let i = 0; i <= 4; i++) {
		const v = (top * i) / 4;
		const tick = top >= 10 ? `$${Math.round(v).toLocaleString("en-US")}` : money(v);
		out.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${tick}</text>`);
	}
	const every = list.length > 24 ? 2 : d.period.kind === "daily" ? 3 : 1;
	list.forEach((b, i) => {
		const x = L + i * slot + slot * 0.14;
		const w = slot * 0.72;
		if (b.weekday >= 5) out.push(`<rect class="weekend" x="${(L + i * slot).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${H - T - B}"/>`);
		let base = 0;
		for (const name of names) {
			const v = b.parts.get(name) ?? 0;
			if (v <= 0) continue;
			out.push(`<rect class="${seriesClass(d.series, name)}" x="${x.toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${w.toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}" rx="1.5"><title>${esc(b.label)} · ${esc(name)}: ${money(v)}</title></rect>`);
			base += v;
		}
		if (b.value > 0 && list.length <= 24 && d.period.kind !== "daily") out.push(`<text class="val" x="${(x + w / 2).toFixed(1)}" y="${(y(b.value) - 5).toFixed(1)}" text-anchor="middle">${money(b.value)}</text>`);
		if (i % every === 0) out.push(`<text class="axis" x="${(x + w / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(b.label)}</text>`);
	});
	return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost over time">${out.join("")}</svg>`;
}

function timeCard(d) {
	if (!d.totals.requests) return "";
	const what = d.period.kind === "daily" ? "Cost per hour" : "Cost per day";
	return card(what, `Split by the top projects; ${d.period.kind === "daily" ? "local hours" : "weekends shaded"}, ${esc(d.tz)}.`, legend([...d.series, OTHER]) + columns(d));
}

function heatCell(v, max, title) {
	const level = max > 0 ? Math.round((v / max) * 100) : 0;
	return `<div class="cell" style="background:color-mix(in srgb, var(--accent) ${level}%, var(--cell))" title="${esc(title)}"></div>`;
}

function heatmapCard(d) {
	if (!d.heatmap || !d.totals.requests) return "";
	const max = Math.max(...d.heatmap.flat());
	const head = `<div></div>${Array.from({ length: 24 }, (_, h) => `<div class="hh">${h % 3 ? "" : String(h).padStart(2, "0")}</div>`).join("")}`;
	const rows = d.heatmap.map((row, wd) => `<div class="hd">${WEEKDAYS[wd]}</div>${row.map((v, h) => heatCell(v, max, `${WEEKDAYS[wd]} ${String(h).padStart(2, "0")}:00 · ${money(v)}`)).join("")}`).join("");
	return card("When you work", "Cost per weekday and local hour.", `<div class="heat">${head}${rows}</div>`);
}

function calendarCard(d) {
	if (d.period.kind !== "monthly" || !d.totals.requests) return "";
	const max = Math.max(...d.timeline.map((b) => b.value));
	const blanks = Array.from({ length: d.timeline[0].weekday }, () => `<div></div>`).join("");
	const days = d.timeline
		.map((b) => {
			const level = max > 0 ? Math.round((b.value / max) * 100) : 0;
			return `<div class="day" style="background:color-mix(in srgb, var(--accent) ${level}%, var(--cell))" title="${esc(b.key)}: ${money(b.value)}"><b>${esc(b.label)}</b><span>${b.value ? money(b.value) : ""}</span></div>`;
		})
		.join("");
	const weeks = d.weeks?.length ? `<h3 class="minor">Per ISO week</h3>${bars(d.weeks)}` : "";
	return card("Calendar", "Cost per day of the month.", `<div class="cal">${WEEKDAYS.map((w) => `<div class="hd">${w}</div>`).join("")}${blanks}${days}</div>${weeks}`);
}

// --- Limits

function limitChart(limits, d) {
	const W = 1000;
	const H = 200;
	const [L, R, T, B] = [44, 8, 10, 24];
	const { start, end } = d.period;
	const x = (t) => L + ((t - start) / (end - start)) * (W - L - R);
	const y = (v) => T + (1 - Math.min(Math.max(v, 0), 1)) * (H - T - B);
	const out = [];
	for (const v of [0, 0.25, 0.5, 0.75, 1]) out.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${pct(v)}</text>`);
	out.push(`<line class="warnline" x1="${L}" x2="${W - R}" y1="${y(0.9)}" y2="${y(0.9)}"/>`);
	const every = d.period.kind === "daily" ? 3 : d.period.kind === "weekly" ? 1 : 3;
	d.timeline.forEach((b, i) => {
		if (i % every === 0) out.push(`<text class="axis" x="${x(b.start).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`);
	});
	limits.forEach((l, i) => {
		const segments = [];
		let seg = [];
		l.points.forEach(([t, v], j) => {
			if (j && t - l.points[j - 1][0] > 3 * 3_600_000) segments.push((seg = []));
			else if (!segments.length) segments.push(seg);
			seg.push([x(t), y(v), t, v]);
		});
		for (const s of segments) {
			for (let j = 1; j < s.length; j++)
				if (s[j - 1][3] >= 1) out.push(`<rect class="full" x="${s[j - 1][0].toFixed(1)}" y="${T}" width="${(s[j][0] - s[j - 1][0]).toFixed(1)}" height="${H - T - B}"><title>${esc(l.label)} at 100%</title></rect>`);
			const line = s.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" L");
			out.push(`<path class="area s${i}" d="M${s[0][0].toFixed(1)},${y(0)} L${line} L${s.at(-1)[0].toFixed(1)},${y(0)} Z"/>`);
			out.push(`<path class="line s${i}" d="M${line}"/>`);
			for (const [px, py, t, v] of s) out.push(`<circle class="dot s${i}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5"><title>${esc(l.label)} · ${clock(t, d.tz)}: ${pct(v)}</title></circle>`);
		}
	});
	const keys = `<div class="legend">${limits.map((l, i) => `<span><i class="sw s${i}"></i>${esc(l.label)}</span>`).join("")}<span><i class="sw full"></i>at 100%</span></div>`;
	return `${keys}<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Limit usage">${out.join("")}</svg>`;
}

function chip(label, value, tone = "", title = "") {
	return `<div class="chip ${tone}"${title ? ` title="${esc(title)}"` : ""}><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function paceChip(l, tz) {
	const p = l.pace;
	if (p.used >= 1) return chip(`${l.label} pace`, "full until reset", "bad", `Resets ${clock(p.resetsAt, tz)}`);
	if (p.fullAt) return chip(`${l.label} pace`, `100% by ${clock(p.fullAt, tz)}`, "warn", `At the window's average rate so far; resets ${clock(p.resetsAt, tz)}`);
	return chip(`${l.label} pace`, `${pct(p.atReset)} at reset`, "good", `At the window's average rate so far; resets ${clock(p.resetsAt, tz)}`);
}

function limitChips(l, tz) {
	const out = [chip(`${l.label} peak`, pct(l.peak), l.peak >= 1 ? "bad" : l.peak >= 0.9 ? "warn" : "")];
	if (l.increase !== undefined) out.push(chip(`${l.label} used`, `+${pct(l.increase, 1)}`));
	if (l.fullMs) out.push(chip(`${l.label} at 100%`, duration(l.fullMs), "bad"));
	else if (l.above90Ms) out.push(chip(`${l.label} at 90%+`, duration(l.above90Ms), "warn"));
	if (l.pace) out.push(paceChip(l, tz));
	if (l.untracked)
		out.push(
			chip(
				"Untracked use",
				Number.isFinite(l.untracked) ? `${l.untracked.toFixed(1)}× usual` : "no tracked cost",
				"warn",
				`${l.label} rose more than the tracked cost explains: usage outside omp sessions (claude.ai, other tools), a device not synced, or a changed limit rate.`,
			),
		);
	return out;
}

function accountBlock(a, d) {
	const hint = a.labelled
		? ""
		: `<p class="note">This account has no label. Add <code>"${esc(a.id)}": "&lt;name&gt;"</code> to <code>accounts.json</code> at the repository root.</p>`;
	// A month of 5-hour windows is a wall of spikes; the monthly chart keeps the long windows, the chips keep the 5-hour figures.
	const charted = d.period.kind === "monthly" ? a.limits.filter((l) => l.duration >= 24 * 3_600_000) : a.limits;
	const chart = charted.length ? limitChart(charted, d) : "";
	const body = a.limits.length ? `<div class="chips">${a.limits.flatMap((l) => limitChips(l, d.tz)).join("")}</div>${chart}` : `<p class="muted">No limit use recorded for this account in the period.</p>`;
	return `<div class="account"><div class="account-head"><h3>${esc(a.label)}</h3><span>${money(a.cost)} · ${compact(a.requests)} requests</span></div>${hint}${body}</div>`;
}

function limitsCard(d) {
	if (!d.accounts.length) return "";
	return card("Limits", "How full each subscription limit got. Pace projects the window's average rate so far to its reset.", d.accounts.map((a) => accountBlock(a, d)).join(""));
}

// --- Sessions and efficiency

function sessionsCard(d) {
	if (!d.sessions.length) return "";
	const max = d.sessions[0].value || 1;
	const rows = d.sessions
		.map(
			(s) => `<tr><td><div class="title">${esc(plain(s.title))}</div><div class="sub">${esc(s.accounts.join(", "))}</div></td><td>${esc(s.project)}</td><td class="num">${s.hours}</td><td class="num">${compact(s.requests)}</td><td class="num">${money(s.requests ? s.value / s.requests : 0)}</td><td class="costcell"><div class="mini"><span style="width:${((s.value / max) * 100).toFixed(1)}%"></span></div><b>${money(s.value)}</b></td></tr>`,
		)
		.join("");
	return card(
		"Top sessions",
		"The most expensive sessions of the period. Active h counts the hours with requests.",
		`<div class="scroll"><table class="sessions"><thead><tr><th>Session</th><th>Project</th><th class="num">Active h</th><th class="num">Requests</th><th class="num">$ / req</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`,
	);
}

function tokenCard(d) {
	const mix = d.tokenMix;
	if (!mix.some((m) => m.tokens)) return "";
	const names = mix.map((m) => TOKEN_NAMES[m.name]);
	const split = `<div class="split">${mix.map((m, i) => `<span class="seg s${i}" style="width:${pct(m.costShare, 2)}" title="${TOKEN_NAMES[m.name]}: ${pct(m.costShare, 1)} of cost"></span>`).join("")}</div>`;
	const list = mix.map((m, i) => `<div class="kv"><span><i class="sw s${i}"></i>${names[i]}</span><b>${compact(m.tokens)}</b><em>${pct(m.costShare)} of cost</em></div>`).join("");
	const ratios = `cache write ${TOKEN_PRICE.cacheWrite}×, cache read ${TOKEN_PRICE.cacheRead}×, output ${TOKEN_PRICE.output}× the input price`;
	return card(
		"Where the tokens go",
		`Anthropic tokens by kind; cost shares estimated from list-price ratios (${ratios}).`,
		`${split}${list}<div class="kv total"><span>Cache hit</span><b>${pct(d.totals.cacheHit, 1)}</b><em>${money(d.totals.costPerRequest)} per request</em></div>`,
	);
}

function mixCard(title, sub, items) {
	if (!items.length) return "";
	if (items.length === 1) return card(title, sub, `<p class="single">All requests: <b>${esc(items[0].name)}</b></p>`);
	return card(title, sub, bars(items.slice(0, 6)));
}

function devicesFooter(d) {
	const chips = d.devices
		.map((v) => {
			const stale = v.lastSeen < d.period.end;
			return `<div class="chip ${stale ? "warn" : ""}" title="${stale ? "Not synced since the period ended: its last hours may be missing." : "Synced after the period ended."}"><span>${esc(v.name)}</span><b>${money(v.cost)}</b><em>last sync ${clock(v.lastSeen, d.tz)}</em></div>`;
		})
		.join("");
	return `<footer><div class="chips">${chips}</div><p>Costs are API-equivalent (list prices of the logged tokens), not billed amounts. Limit figures come from the providers' usage endpoints; shares and pace are estimates. Generated ${clock(d.generatedAt, d.tz)} by ${esc(d.generator)}.</p></footer>`;
}

// --- Page shell

const CSS = `
:root{--bg:#f5f6fb;--card:#fff;--fg:#0f172a;--muted:#64748b;--border:#e5e7f0;--cell:#eef0f7;--accent:#6366f1;--good:#059669;--warn:#d97706;--bad:#dc2626;
--c0:#6366f1;--c1:#14b8a6;--c2:#f59e0b;--c3:#ec4899;--c4:#22c55e;--c5:#0ea5e9;--co:#a3acc2;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0a0f1f;--card:#111a2e;--fg:#e6e9f5;--muted:#8b96b0;--border:#1f2a44;--cell:#17213a;--accent:#818cf8;--co:#4b5675}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 48px}
.hero{border-radius:22px;padding:28px 30px;color:#fff;background:radial-gradient(1200px 300px at 0% 0%,#22d3ee55,transparent),linear-gradient(120deg,#4f46e5,#7c3aed 55%,#db2777);box-shadow:0 18px 50px -20px #4f46e5aa}
.hero .eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:12px;opacity:.8}.hero h1{margin:6px 0 8px;font-size:34px;line-height:1.15;letter-spacing:-.02em}
.hero nav{display:flex;gap:10px;flex-wrap:wrap;font-size:13px}.hero nav a,.hero nav span{background:#ffffff22;border:1px solid #ffffff33;padding:4px 11px;border-radius:999px;text-decoration:none}
.hero nav a:hover{background:#ffffff38}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin:18px 0}
.kpi,.card{background:var(--card);border:1px solid var(--border);border-radius:18px;box-shadow:0 1px 2px #0000000a,0 8px 24px -18px #1e1b4b40}
.kpi{padding:16px 16px 14px}.kpi-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.kpi-value{font-size:27px;font-weight:700;letter-spacing:-.02em;margin:4px 0 6px;font-variant-numeric:tabular-nums}.kpi-foot{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted);flex-wrap:wrap}
.delta{font-weight:650;padding:1px 7px;border-radius:999px;font-size:12px}.delta.good{color:var(--good);background:color-mix(in srgb,var(--good) 14%,transparent)}
.delta.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}.delta.flat{color:var(--muted);background:var(--cell)}
.card{padding:20px 22px;margin:0 0 18px;min-width:0}.card header{margin-bottom:12px}.card h2{margin:0;font-size:18px;letter-spacing:-.01em}.card header p{margin:3px 0 0;color:var(--muted);font-size:13px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}.grid3{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:18px}.grid2>.card,.grid3>.card{margin:0}.row{margin-bottom:18px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--muted);margin:2px 0 10px}.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.s0{background:var(--c0);fill:var(--c0);stroke:var(--c0)}.s1{background:var(--c1);fill:var(--c1);stroke:var(--c1)}.s2{background:var(--c2);fill:var(--c2);stroke:var(--c2)}
.s3{background:var(--c3);fill:var(--c3);stroke:var(--c3)}.s4{background:var(--c4);fill:var(--c4);stroke:var(--c4)}.s5{background:var(--c5);fill:var(--c5);stroke:var(--c5)}.so{background:var(--co);fill:var(--co);stroke:var(--co)}
.sw.full{background:color-mix(in srgb,var(--bad) 30%,transparent)}
.bars{display:grid;gap:7px}.bar-row{display:grid;grid-template-columns:minmax(90px,190px) 1fr 72px;gap:12px;align-items:center;font-size:13.5px}
.bar-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar-track{display:flex;height:14px;border-radius:7px;background:var(--cell);overflow:hidden}
.bar-value{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}.seg{height:100%;display:block}.seg+.seg{box-shadow:-1px 0 0 var(--card)}
.split{display:flex;height:22px;border-radius:11px;overflow:hidden;background:var(--cell);margin:2px 0 8px}.split-legend{display:flex;gap:18px;font-size:13px;color:var(--muted);margin-bottom:14px;flex-wrap:wrap}
.chart{width:100%;height:auto;display:block;overflow:visible}.chart .grid{stroke:var(--border);stroke-width:1}.chart .axis{fill:var(--muted);font-size:12px}.chart .val{fill:var(--fg);font-size:12px;font-weight:600}
.chart .weekend{fill:var(--cell);opacity:.7}.chart .line{fill:none;stroke-width:2.5;stroke-linejoin:round}.chart .area{opacity:.12;stroke:none}.chart .dot{opacity:0;stroke:none}.chart .dot:hover{opacity:1}
.chart .warnline{stroke:var(--warn);stroke-dasharray:5 5;opacity:.7}.chart .full{fill:var(--bad);opacity:.16}
.account+.account{margin-top:22px;padding-top:20px;border-top:1px dashed var(--border)}.account-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.account h3{margin:0 0 8px;font-size:15.5px}.account-head span{color:var(--muted);font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 12px}.chip{border:1px solid var(--border);background:var(--cell);border-radius:12px;padding:6px 11px;font-size:12.5px;display:flex;gap:8px;align-items:baseline}
.chip span{color:var(--muted)}.chip b{font-variant-numeric:tabular-nums}.chip em{color:var(--muted);font-style:normal;font-size:11.5px}
.chip.good{border-color:color-mix(in srgb,var(--good) 40%,transparent)}.chip.good b{color:var(--good)}.chip.warn{border-color:color-mix(in srgb,var(--warn) 45%,transparent);background:color-mix(in srgb,var(--warn) 9%,var(--card))}.chip.warn b{color:var(--warn)}
.chip.bad{border-color:color-mix(in srgb,var(--bad) 45%,transparent);background:color-mix(in srgb,var(--bad) 9%,var(--card))}.chip.bad b{color:var(--bad)}
.note{font-size:13px;background:color-mix(in srgb,var(--warn) 10%,var(--card));border:1px solid color-mix(in srgb,var(--warn) 35%,transparent);border-radius:10px;padding:8px 12px;margin:0 0 10px}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.muted{color:var(--muted)}
.heat{display:grid;grid-template-columns:34px repeat(24,1fr);gap:3px;font-size:11px;color:var(--muted)}.heat .cell{aspect-ratio:1;border-radius:4px}.hh{text-align:left}.hd{align-self:center}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;font-size:11px;color:var(--muted)}.cal .hd{text-align:center}
.day{border-radius:10px;padding:6px 7px;min-height:52px;display:flex;flex-direction:column;justify-content:space-between;color:var(--fg)}.day b{font-size:12px}.day span{font-size:11px;font-variant-numeric:tabular-nums}
h3.minor{font-size:13px;color:var(--muted);font-weight:600;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.scroll{overflow-x:auto}table.sessions{width:100%;border-collapse:collapse;font-size:13.5px}.sessions th{text-align:left;font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em;padding:0 10px 8px;border-bottom:1px solid var(--border)}
.sessions td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}.sessions tr:last-child td{border-bottom:0}.sessions tr:hover td{background:var(--cell)}
.sessions .title{font-weight:600}.sessions .sub{color:var(--muted);font-size:12px}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.costcell{min-width:170px}.costcell b{font-variant-numeric:tabular-nums}.mini{height:6px;border-radius:3px;background:var(--cell);margin:6px 0 4px;overflow:hidden}.mini span{display:block;height:100%;background:linear-gradient(90deg,var(--c0),var(--c3))}
.kv{display:grid;grid-template-columns:1fr auto 110px;gap:10px;font-size:13.5px;padding:6px 0;border-bottom:1px solid var(--border)}.kv em{color:var(--muted);font-style:normal;text-align:right;font-size:12.5px}.kv b{font-variant-numeric:tabular-nums}.kv.total{border-bottom:0;padding-top:10px}
.single{color:var(--muted);margin:0}.single b{color:var(--fg)}
.empty{text-align:center;padding:40px 20px;color:var(--muted)}.empty b{display:block;font-size:20px;color:var(--fg);margin-bottom:4px}
footer{margin-top:8px;font-size:12.5px;color:var(--muted)}footer p{max-width:820px}
.index{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:18px}.index ul{list-style:none;margin:0;padding:0}.index li a{display:flex;justify-content:space-between;padding:9px 12px;border-radius:10px;text-decoration:none}
.index li a:hover{background:var(--cell)}.index li a span{color:var(--muted);font-size:12.5px}
@media (max-width:960px){.kpis{grid-template-columns:repeat(3,1fr)}.grid2,.grid3,.index{grid-template-columns:1fr}}
@media (max-width:560px){.kpis{grid-template-columns:repeat(2,1fr)}.hero h1{font-size:26px}.bar-row{grid-template-columns:110px 1fr 64px}}
`;

function shell(title, body) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main class="wrap">${body}</main></body></html>
`;
}

/** File path of a report relative to the reports directory. */
export const reportPath = (period) => `${period.kind}/${period.key}.html`;

/** The report page of one period. */
export function renderReport(d) {
	const kind = KIND_NAMES[d.period.kind];
	const hero = `<header class="hero"><div class="eyebrow">Agent usage · ${kind} report</div><h1>${esc(d.label)}</h1>
<nav><a href="../index.html">All reports</a><a href="../${reportPath(d.previous)}">← ${esc(d.previous.key)}</a><span>${esc(d.tz)}</span></nav></header>`;
	if (!d.totals.requests && !d.accounts.some((a) => a.limits.length))
		return shell(`${kind} usage · ${d.period.key}`, `${hero}${kpis(d)}${card("No tracked usage", "", `<div class="empty"><b>Nothing ran in this period.</b>No device recorded a request or a limit snapshot.</div>`)}${devicesFooter(d)}`);
	const body = [
		hero,
		kpis(d),
		limitsCard(d),
		timeCard(d),
		`<div class="grid2 row">${projectsCard(d)}${featuresCard(d)}</div>`,
		d.period.kind === "daily" ? "" : `<div class="grid2 row">${heatmapCard(d)}${d.period.kind === "monthly" ? calendarCard(d) : mixCard("Agents", "Main session versus subagents.", d.agents)}</div>`,
		sessionsCard(d),
		`<div class="grid3 row">${tokenCard(d)}${mixCard("Models", "Cost per model.", d.models)}${d.period.kind === "weekly" ? mixCard("Devices", "Cost per device.", d.devices.map((v) => ({ name: v.name, value: v.cost })).filter((v) => v.value > 0)) : mixCard("Agents", "Main session versus subagents.", d.agents)}</div>`,
		devicesFooter(d),
	];
	return shell(`${kind} usage · ${d.period.key}`, body.join("\n"));
}

/** The index page; reports is { daily: [key…], weekly: […], monthly: […] }, newest first. */
export function renderIndex(reports) {
	const columns = Object.entries(KIND_NAMES)
		.map(([kind, name]) => {
			const keys = reports[kind] ?? [];
			const items = keys.length ? keys.map((k) => `<li><a href="${kind}/${esc(k)}.html"><b>${esc(k)}</b><span>open →</span></a></li>`).join("") : `<li class="muted">None yet.</li>`;
			return card(name, `${keys.length} report${keys.length === 1 ? "" : "s"}`, `<ul>${items}</ul>`);
		})
		.join("");
	return shell(
		"Agent usage reports",
		`<header class="hero"><div class="eyebrow">Agent usage</div><h1>Reports</h1><nav><span>Daily, weekly and monthly, written by the first device to sync after a period ends.</span></nav></header><div class="index">${columns}</div>`,
	);
}
