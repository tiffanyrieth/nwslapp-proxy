#!/usr/bin/env node
// Club-news health check — NO SILENT FAILURES gate (Home "Club News", B3b).
//
// Curls GET /team-videos?teams=<abbr> for ALL 16 NWSL clubs and asserts each returns at
// least one `newsArticle` card. Prints a pass/fail table and EXITS NON-ZERO if any club
// is empty — so a broken per-club source is a loud failure in the deploy flow, before it
// ever reaches a user. (The Worker also emits `clubNewsEmpty`/`clubNewsFallback` diag
// telemetry at runtime; this is the proactive, deploy-time companion.)
//
// Usage:
//   node scripts/health_check_club_news.mjs                 # against production
//   node scripts/health_check_club_news.mjs http://localhost:8787   # against wrangler dev
//   npm run healthcheck
//
// Each request adds a unique `_hc` param to bypass the route's edge cache so the check
// reflects fresh discovery (the per-club KV cache may still serve recent results — that's
// fine: we're asserting the club HAS news, cached or live).

const BASE = (process.argv[2] || process.env.PROXY_BASE || "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");

const CLUBS = ["LA", "BAY", "BOS", "CHI", "DEN", "GFC", "HOU", "KC", "LOU", "NC", "ORL", "POR", "SD", "SEA", "UTA", "WAS"];

// Clubs that legitimately have ~no article-news anywhere yet (brand-new expansion sides
// with no official site content AND no press coverage). An empty result for these is
// reality, not a regression, so it WARNS instead of hard-failing — but it's still printed
// and the Worker still emits clubNewsEmpty telemetry (never hidden). Remove a club here
// once it starts generating news so a real future breakage fails loudly again.
const EXPECTED_THIN = new Set(["DEN"]);

async function checkClub(abbr) {
	const url = `${BASE}/team-videos?teams=${abbr}&_hc=${Date.now()}-${abbr}`;
	try {
		const r = await fetch(url);
		if (!r.ok) return { abbr, ok: false, count: 0, note: `HTTP ${r.status}` };
		const body = await r.json();
		const cards = Array.isArray(body) ? body : (body.cards ?? []);
		const articles = cards.filter((c) => c?.layout === "newsArticle");
		const sourceTypes = [...new Set(articles.map((c) => c?.sourceType))].join(",");
		const sample = articles[0]?.headline?.slice(0, 46) ?? "—";
		return { abbr, ok: articles.length > 0, count: articles.length, note: `${sourceTypes || "—"}  ${sample}` };
	} catch (e) {
		return { abbr, ok: false, count: 0, note: `fetch failed: ${e.message}` };
	}
}

const results = await Promise.all(CLUBS.map(checkClub));
const empty = results.filter((r) => !r.ok);
const hardFail = empty.filter((r) => !EXPECTED_THIN.has(r.abbr));
const warnThin = empty.filter((r) => EXPECTED_THIN.has(r.abbr));

console.log(`\nClub-news health check — ${BASE}\n`);
for (const r of results) {
	const icon = r.ok ? "✅" : EXPECTED_THIN.has(r.abbr) ? "⚠️ " : "❌";
	console.log(`  ${icon} ${r.abbr.padEnd(4)} ${String(r.count).padStart(2)}  ${r.note}`);
}
console.log(`\n${results.length - empty.length}/${results.length} clubs returned article-news.`);

if (warnThin.length > 0) {
	console.log(`⚠️  Known-thin (expected, not a failure): ${warnThin.map((r) => r.abbr).join(", ")} — brand-new club(s) with no news yet.`);
}
if (hardFail.length > 0) {
	console.error(`\n❌ FAIL — ${hardFail.length} club(s) unexpectedly empty: ${hardFail.map((r) => r.abbr).join(", ")}`);
	console.error("   Check the CLUB_NEWS config (src/index.ts) + GET /telemetry/recent for clubNewsEmpty events.");
	process.exit(1);
}
console.log("✅ PASS — every club has article-news (known-thin clubs excepted).\n");
