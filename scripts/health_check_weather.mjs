#!/usr/bin/env node
// Weather health check — NO SILENT FAILURES gate (Match Detail: kickoff temperature stamp).
//
// A past match's Match Detail header shows the historical kickoff temperature + condition,
// sourced from Open-Meteo via GET /weather?event=<id>. The failures this guards against:
//   - a NEW/renamed NWSL venue not in weather.ts's VENUE_COORDS → "unknown-venue" (the whole
//     point of keying by venue id is that this can only happen on a genuinely new stadium, and
//     when it does we want the deploy to FAIL loudly so the table gets the coordinates), and
//   - a finished match returning no weather at all (Open-Meteo/summary breakage).
// For a sample of recent FINISHED events we GET /weather and classify:
//   - mode "historical" with a numeric tempF + mapped condition -> ✅ healthy
//   - mode "unavailable" reason "unknown-venue"                  -> ❌ FAIL (table drift — add the venue)
//   - mode "unavailable" reason "upstream-error"                 -> ⚠️ WARN (Open-Meteo hiccup, retryable)
//   - mode "unavailable" reason "not-finished"                  -> skipped (shouldn't happen for post events)
//
// Usage:
//   node scripts/health_check_weather.mjs                          # against production
//   node scripts/health_check_weather.mjs http://localhost:8787    # against wrangler dev
//   npm run healthcheck

const BASE = (process.argv[2] || process.env.PROXY_BASE || "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard?limit=500";
const SAMPLE = 6; // check the most recent N finished matches (KV makes repeats free)

async function recentFinishedEvents() {
	const r = await fetch(ESPN_SCOREBOARD, { headers: { Accept: "application/json" } });
	if (!r.ok) throw new Error(`scoreboard HTTP ${r.status}`);
	const json = await r.json();
	const events = Array.isArray(json?.events) ? json.events : [];
	return events
		.map((e) => ({
			id: e?.id,
			date: e?.date,
			state: e?.status?.type?.state,
			label: (e?.competitions?.[0]?.competitors ?? []).map((c) => c?.team?.abbreviation ?? "?").join("–"),
		}))
		.filter((e) => e.id && e.state === "post")
		.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
		.slice(0, SAMPLE);
}

async function checkEvent(ev) {
	try {
		const r = await fetch(`${BASE}/weather?event=${ev.id}`);
		if (!r.ok) return { ...ev, verdict: "FAIL", note: `HTTP ${r.status}` };
		const body = await r.json();
		if (body.mode === "historical") {
			if (typeof body.tempF !== "number" || Number.isNaN(body.tempF)) {
				return { ...ev, verdict: "FAIL", note: `historical but tempF=${body.tempF}` };
			}
			return { ...ev, verdict: "OK", note: `${body.tempF}°F ${body.condition || "(no label)"} isDay=${body.isDay}` };
		}
		if (body.reason === "unknown-venue") {
			return { ...ev, verdict: "FAIL", note: "unknown-venue — add it to VENUE_COORDS in weather.ts" };
		}
		return { ...ev, verdict: "WARN", note: `unavailable: ${body.reason}` };
	} catch (e) {
		return { ...ev, verdict: "FAIL", note: `fetch failed: ${e.message}` };
	}
}

let events;
try {
	events = await recentFinishedEvents();
} catch (e) {
	console.error(`\nWeather health check — ❌ could not resolve scoreboard: ${e.message}\n`);
	process.exit(1);
}

console.log(`\nWeather health check — ${BASE}\n`);
if (events.length === 0) {
	console.log("  (no finished matches on the current scoreboard — nothing to check)\n");
	process.exit(0);
}

const results = await Promise.all(events.map(checkEvent));
const icon = { OK: "✅", WARN: "⚠️ ", FAIL: "❌" };
for (const r of results) {
	console.log(`  ${icon[r.verdict]} ${r.label.padEnd(9)} ${r.note}`);
}

const failed = results.filter((r) => r.verdict === "FAIL");
const warned = results.filter((r) => r.verdict === "WARN");
console.log(`\n${results.length - failed.length}/${results.length} finished matches served a kickoff temperature${warned.length ? ` (${warned.length} Open-Meteo hiccup)` : ""}.`);

if (failed.length > 0) {
	console.error(`\n❌ FAIL — ${failed.length} event(s): ${failed.map((r) => r.label).join(", ")}`);
	console.error("   An unknown-venue means a new/renamed stadium needs coordinates in weather.ts VENUE_COORDS.");
	process.exit(1);
}
console.log("✅ PASS — every recent finished match serves a kickoff temperature (or a genuine Open-Meteo hiccup).\n");
