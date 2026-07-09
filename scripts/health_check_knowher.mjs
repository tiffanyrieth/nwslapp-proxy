#!/usr/bin/env node
// Know Her Game eligibility health check — NO SILENT FAILURES gate (docs §4/§5b).
//
// The weekly generation feed depends on the roster-learning eligibility engine. This guards:
//   - GET /knowher/eligible?team=  returning an empty pool IN-SEASON (ESPN roster/stats broke, or
//     the featured ledger wrongly excluded everyone) — a silent empty would strand the generator, and
//   - GET /knowher/todo?team=  returning a malformed pick (missing the VERIFIED stats the generator must
//     use, not look up — starts/minutes/goals/assists/shots).
// For a sample of active teams we hit both routes and classify structural soundness. Offseason
// (Dec–Feb) an empty pool is expected, so emptiness is a WARN then, a FAIL in-season.
//
// Usage:
//   node scripts/health_check_knowher.mjs                          # against production
//   node scripts/health_check_knowher.mjs http://localhost:8787    # against wrangler dev
//   npm run healthcheck

const BASE = (process.argv[2] || process.env.PROXY_BASE || "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");
const TEAMS = ["WAS", "KC", "POR", "GFC"]; // a few reliably-active clubs
const MONTH = new Date().getUTCMonth() + 1;
const IN_SEASON = MONTH >= 3 && MONTH <= 11; // NWSL runs ~Mar–Nov
const STAT_KEYS = ["starts", "minutes", "appearances", "goals", "assists", "shots", "shotsOnTarget"];

async function checkTeam(team) {
	try {
		const [elig, todo] = await Promise.all([
			fetch(`${BASE}/knowher/eligible?team=${team}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`eligible HTTP ${r.status}`)))),
			fetch(`${BASE}/knowher/todo?team=${team}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`todo HTTP ${r.status}`)))),
		]);
		const count = elig?.count ?? 0;
		const player = todo?.player ?? null;

		if (count === 0 || !player) {
			return { team, verdict: IN_SEASON ? "FAIL" : "WARN", note: `eligible=${count}, pick=${player ? player.name : "none"}${IN_SEASON ? " (empty in-season)" : " (offseason ok)"}` };
		}
		// A pick must carry every verified stat as a number (the generator USES these, never looks them up).
		const missing = STAT_KEYS.filter((k) => typeof player[k] !== "number" || Number.isNaN(player[k]));
		if (missing.length) return { team, verdict: "FAIL", note: `pick ${player.name} missing numeric stats: ${missing.join(",")}` };
		return { team, verdict: "OK", note: `${count} eligible → ${player.name} (${player.starts}st/${player.minutes}m, ${player.goals}g/${player.assists}a/${player.shots}sh)` };
	} catch (e) {
		return { team, verdict: "FAIL", note: `fetch failed: ${e.message}` };
	}
}

console.log(`\nKnow Her Game eligibility health check — ${BASE} (${IN_SEASON ? "in-season" : "offseason"})\n`);
const results = await Promise.all(TEAMS.map(checkTeam));
const icon = { OK: "✅", WARN: "⚠️ ", FAIL: "❌" };
for (const r of results) console.log(`  ${icon[r.verdict]} ${r.team.padEnd(4)} ${r.note}`);

const failed = results.filter((r) => r.verdict === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} teams served a valid weekly pick with verified stats.`);
if (failed.length > 0) {
	console.error(`\n❌ FAIL — ${failed.length} team(s): ${failed.map((r) => r.team).join(", ")}`);
	console.error("   In-season this means ESPN roster/stats broke or the featured ledger over-excluded — investigate before deploy.");
	process.exit(1);
}
console.log("✅ PASS — Know Her eligibility + /knowher/todo serve valid, stat-attached picks.\n");
