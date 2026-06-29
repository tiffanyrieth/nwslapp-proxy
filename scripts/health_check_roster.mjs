#!/usr/bin/env node
// Roster health check — NO SILENT FAILURES gate (Teams "Squad", roster resilience).
//
// Resolves every NWSL club's ESPN team id from the live /teams directory, then curls
// GET /roster?team=<id> for each and asserts a PLAUSIBLE squad (>= MIN players). The
// proxy serves ESPN's live roster when it's full and falls back to the last-known-good
// KV cache when ESPN comes back short — so a club below MIN here means BOTH the live
// endpoint is broken AND there's no cached roster to fall back to: a real, loud gap.
// EXITS NON-ZERO on any such club so it fails in the deploy flow before reaching a user.
// (The Worker also emits rosterStaleServe / rosterImplausibleNoCache diag at runtime;
// this is the proactive, deploy-time companion.)
//
// Usage:
//   node scripts/health_check_roster.mjs                 # against production
//   node scripts/health_check_roster.mjs http://localhost:8787   # against wrangler dev
//   npm run healthcheck

const BASE = (process.argv[2] || process.env.PROXY_BASE || "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");
const ESPN_TEAMS = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/teams";
const MIN = 16; // mirrors ROSTER_GOOD_MIN in src/index.ts — a real NWSL squad is ~22–26

async function resolveTeams() {
	const r = await fetch(ESPN_TEAMS, { headers: { Accept: "application/json" } });
	if (!r.ok) throw new Error(`teams directory HTTP ${r.status}`);
	const json = await r.json();
	// ESPN nests: sports[0].leagues[0].teams[].team {id, abbreviation}
	const entries = json?.sports?.[0]?.leagues?.[0]?.teams ?? [];
	return entries.map((e) => ({ id: e.team?.id, abbr: e.team?.abbreviation ?? "?" })).filter((t) => t.id);
}

async function checkRoster({ id, abbr }) {
	const url = `${BASE}/roster?team=${id}&_hc=${Date.now()}-${id}`;
	try {
		const r = await fetch(url);
		if (!r.ok) return { id, abbr, ok: false, count: 0, note: `HTTP ${r.status}` };
		const body = await r.json();
		const count = Array.isArray(body?.athletes) ? body.athletes.length : 0;
		const cached = body?.proxyCachedAsOf ? `cached@${String(body.proxyCachedAsOf).slice(0, 10)}` : "live";
		return { id, abbr, ok: count >= MIN, count, note: cached };
	} catch (e) {
		return { id, abbr, ok: false, count: 0, note: `fetch failed: ${e.message}` };
	}
}

let teams;
try {
	teams = await resolveTeams();
} catch (e) {
	console.error(`\nRoster health check — ❌ could not resolve team directory: ${e.message}\n`);
	process.exit(1);
}

const results = await Promise.all(teams.map(checkRoster));
const failed = results.filter((r) => !r.ok);

console.log(`\nRoster health check — ${BASE}\n`);
for (const r of results.sort((a, b) => a.abbr.localeCompare(b.abbr))) {
	console.log(`  ${r.ok ? "✅" : "❌"} ${r.abbr.padEnd(4)} ${String(r.count).padStart(2)}  ${r.note}`);
}
console.log(`\n${results.length - failed.length}/${results.length} clubs returned a plausible roster (>= ${MIN}).`);

if (failed.length > 0) {
	console.error(`\n❌ FAIL — ${failed.length} club(s) below ${MIN}: ${failed.map((r) => `${r.abbr}(${r.count})`).join(", ")}`);
	console.error("   ESPN is short AND no last-known-good cache exists. Seed the cache (scripts) or check /telemetry/recent.");
	process.exit(1);
}
console.log("✅ PASS — every club has a plausible roster (live or last-known-good).\n");
