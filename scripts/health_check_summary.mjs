#!/usr/bin/env node
// Summary health check — NO SILENT FAILURES gate (Match Detail: lineups, play-by-play, stats).
//
// A live/finished match's ESPN /summary carries the starting XIs (rosters[].roster) and the
// key-events timeline (keyEvents). The proxy caches /summary per event. The failure this guards
// against: a pre-kickoff EMPTY shell cached with a long TTL and then served — empty — through the
// whole live game and past full-time (the "stale summary" bug fixed by preKickoffTTL). For every
// recent in/post event we:
//   1. fetch the proxy /summary the SAME way the app does (no cache-bust) and read the cache header,
//   2. fetch it again cache-busted (forces a fresh ESPN pass-through),
// then classify:
//   - cache-busted populated + cached populated            -> ✅ healthy
//   - cache-busted populated + cached EMPTY (stale serve)  -> ❌ FAIL (a user sees empty right now)
//   - cache-busted EMPTY (ESPN itself has nothing)         -> ⚠️ WARN (ESPN gap, not our bug)
// The cache-busted leg is the hard gate: an in/post event whose FRESH ESPN summary has no lineup is
// the only case we can't fix here; everything else that's empty is our cache and fails the deploy.
//
// Usage:
//   node scripts/health_check_summary.mjs                          # against production
//   node scripts/health_check_summary.mjs http://localhost:8787    # against wrangler dev
//   npm run healthcheck

const BASE = (process.argv[2] || process.env.PROXY_BASE || "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard?limit=500";
const MIN_STARTERS = 11; // a real XI; every played match has 11 starters per side

// Count starting-XI players across both rosters in a summary body.
function playerCount(summary) {
	const rosters = Array.isArray(summary?.rosters) ? summary.rosters : [];
	return rosters.reduce((n, r) => n + (Array.isArray(r?.roster) ? r.roster.length : 0), 0);
}
function keyEventCount(summary) {
	return Array.isArray(summary?.keyEvents) ? summary.keyEvents.length : 0;
}

async function recentEvents() {
	const r = await fetch(ESPN_SCOREBOARD, { headers: { Accept: "application/json" } });
	if (!r.ok) throw new Error(`scoreboard HTTP ${r.status}`);
	const json = await r.json();
	const events = Array.isArray(json?.events) ? json.events : [];
	// Only in/post events: a genuinely-future ("pre") match legitimately has no lineup yet.
	return events
		.map((e) => ({
			id: e?.id,
			state: e?.status?.type?.state,
			label: (e?.competitions?.[0]?.competitors ?? []).map((c) => c?.team?.abbreviation ?? "?").join("–"),
		}))
		.filter((e) => e.id && (e.state === "in" || e.state === "post"));
}

async function fetchSummary(id, bust) {
	const url = bust ? `${BASE}/summary?event=${id}&_hc=${Date.now()}-${id}` : `${BASE}/summary?event=${id}`;
	const r = await fetch(url);
	if (!r.ok) return { ok: false, note: `HTTP ${r.status}` };
	const body = await r.json();
	return { ok: true, players: playerCount(body), events: keyEventCount(body), cache: r.headers.get("x-proxy-cache") ?? "?" };
}

async function checkEvent(ev) {
	try {
		const [cached, fresh] = await Promise.all([fetchSummary(ev.id, false), fetchSummary(ev.id, true)]);
		if (!fresh.ok) return { ...ev, verdict: "FAIL", note: `fresh ${fresh.note}` };
		if (fresh.players < MIN_STARTERS) {
			return { ...ev, verdict: "WARN", note: `ESPN summary itself has ${fresh.players} players (feed gap)` };
		}
		// A serve is stale if the cached body is materially emptier than a fresh fetch:
		// no XI (players) OR an empty timeline while ESPN already has key events.
		const stale = [];
		if (cached.ok && cached.players < MIN_STARTERS) stale.push(`players ${cached.players}<${fresh.players}`);
		if (cached.ok && fresh.events > 0 && cached.events === 0) stale.push(`events ${cached.events}<${fresh.events}`);
		if (stale.length) {
			return { ...ev, verdict: "FAIL", note: `STALE CACHE (${cached.cache}): ${stale.join(", ")}` };
		}
		return { ...ev, verdict: "OK", note: `${cached.players}p/${cached.events}ev (${cached.cache})` };
	} catch (e) {
		return { ...ev, verdict: "FAIL", note: `fetch failed: ${e.message}` };
	}
}

let events;
try {
	events = await recentEvents();
} catch (e) {
	console.error(`\nSummary health check — ❌ could not resolve scoreboard: ${e.message}\n`);
	process.exit(1);
}

console.log(`\nSummary health check — ${BASE}\n`);
if (events.length === 0) {
	console.log("  (no live/finished matches on the current scoreboard — nothing to check)\n");
	process.exit(0);
}

const results = await Promise.all(events.map(checkEvent));
const icon = { OK: "✅", WARN: "⚠️ ", FAIL: "❌" };
for (const r of results) {
	console.log(`  ${icon[r.verdict]} ${r.label.padEnd(9)} ${r.state.padEnd(4)} ${r.note}`);
}

const failed = results.filter((r) => r.verdict === "FAIL");
const warned = results.filter((r) => r.verdict === "WARN");
console.log(`\n${results.length - failed.length}/${results.length} events served a populated summary${warned.length ? ` (${warned.length} ESPN feed gap)` : ""}.`);

if (failed.length > 0) {
	console.error(`\n❌ FAIL — ${failed.length} event(s) served empty/stale: ${failed.map((r) => r.label).join(", ")}`);
	console.error("   A live/finished match is showing empty lineups/plays. Check chooseSummaryTTL / the /summary cache.");
	process.exit(1);
}
console.log("✅ PASS — every live/finished match serves a populated summary (or a genuine ESPN feed gap).\n");
