#!/usr/bin/env node
// Read-load simulation harness — the 1k-user pre-publish READ gate.
//
// WHAT WE ACTUALLY SIMULATE: a NORMAL user session — cold-open the app, then browse for ~10-15 min
// across the whole app (Home, Schedule, Standings, Teams, a few team ROSTERS, a Fan Zone game or two,
// the Feed) and LEAVE. This is the real load: it happens on ANY day, has NOTHING to do with match
// count, and is what nearly hit the request ceiling at ~900 users on a cold open before the fixes.
//
// NOT the centerpiece: the in-app live `/scoreboard` poll. It's foreground-only, throttled, and used by
// the rare tail user who parks in the app during a live match — ~1 in 1,000, not the 1,000. Lock-screen
// V2-LA is PUSHED (APNs broadcast), so it costs ZERO reads. We model the ambient poll (it does run while
// the app is foreground) but bounded by the SHORT normal session length, plus an explicit `--parked-min`
// knob for the worst-case sitter so we can see it's bounded, not the driver.
//
// Method: Workers requests are LINEAR per user (a cache HIT still counts), so calibrate ~100 sessions,
// count exactly, ×(sessions/day)×1000 = the 1k daily total vs the 100k/day cap. A `--burst` mode covers
// the one non-linear risk: does a cold launch-storm coalesce at the edge or stampede ESPN?
//
// Standalone Node — never POSTs /analytics or /telemetry (code-verified: only handleAnalyticsIngest at
// POST /analytics writes analytics_counters). Hits GET reads only ⇒ NOTHING to clear from the admin
// portal. Only prod footprint = the Workers request COUNT itself (resets 00:00 UTC = 8pm ET).
//
// Usage:
//   node scripts/loadsim/sim.mjs --dry-run                    # normal browsing day, print model + prediction
//   node scripts/loadsim/sim.mjs --dry-run --live             # same, but a live game exists (ambient poll @75s)
//   node scripts/loadsim/sim.mjs --dry-run --parked-min=90 --users=1  # the rare 90-min sitter (bounded tail)
//   node scripts/loadsim/sim.mjs --users=100                  # PROD calibration (~100 normal sessions)
//   node scripts/loadsim/sim.mjs --burst=300                  # cold launch-storm coalescing test (PROD)
//
// Browse knobs (the REAL assumptions — vary these, not "match count"):
//   --session-min=12  --rosters=3  --fanzone=1  --feed-refresh=1  --sessions-per-day=3
//   --live (a live game is on → ambient poll 75s vs 300s)  --parked-min=0 (tail sitter minutes)
//   --follow=WAS,POR  --users=100  --concurrency=40  --base=URL (or PROXY_BASE)  --burst=K  --dry-run

// ---- config ----------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, def) => { const h = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`)); if (!h) return def; const eq = h.indexOf("="); return eq === -1 ? true : h.slice(eq + 1); };
const num = (name, def) => { const v = flag(name, undefined); return v === undefined ? def : Number(v); };

const posBase = args.find((a) => !a.startsWith("--"));
const BASE = (flag("base", undefined) || process.env.PROXY_BASE || posBase || "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");
const USERS = num("users", 100);
const SESSION_MIN = num("session-min", 12);         // a normal 10-15 min browse-and-leave
const ROSTERS = num("rosters", 3);                  // team squads opened while browsing Teams
const FANZONE = num("fanzone", 1);                  // Fan Zone games opened (Trivia/KHG = +2 proxy each; Bracket = 0)
const FEED_REFRESH = num("feed-refresh", 1);        // extra /feed after a follow-scope change (0 or 1)
const LIVE = !!flag("live", false);                 // is a live game on the board? (sets ambient poll 75s vs 300s)
const PARKED_MIN = num("parked-min", 0);            // TAIL: minutes this user parks watching a live match in-app
const WATCH_DETAIL = !!flag("watch-detail", PARKED_MIN > 0); // a parked user sitting on a match DETAIL (/summary poll)
const SESSIONS_PER_DAY = num("sessions-per-day", 3);
const FOLLOW = String(flag("follow", "WAS,POR")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const CONCURRENCY = num("concurrency", 40);
const BURST = num("burst", 0);
const DRY = !!flag("dry-run", false);

// --- build-40 fix toggles (read-load pass): model each change so --dry-run shows the predicted post-fix
// number. `--fix-all` turns them all on. ---
const FIX_ALL = !!flag("fix-all", false);
const on = (name) => FIX_ALL || !!flag(name, false);
const FIX_SCHED_POLL = on("schedule-aware-poll"); // Fix 1: quiet day → 0 ambient poll (was 300s); live keeps 75s
const FIX_SUMMARY_DIRECT = on("summary-direct");  // Fix 2: a LIVE match's /summary goes direct to ESPN (off proxy)
const FIX_TRIM_SCOREBOARD = on("trim-scoreboard");// Fix 5: aux (CC/Challenge/NT) scoreboards NOT at cold open
const FIX_DEFER_FEED = on("defer-feed");          // Fix 4: /feed only on Social-tab open (no launch prewarm)
const FIX_CONFIG_CACHE = on("config-cache");      // Fix 3: /config URLCache-served on repeat launches (amortized)
const GLANCE_SUMMARIES = num("glance-summaries", 3); // ~a brief look into one match detail per session

const POLL_SEC = 75, QUIET_POLL_SEC = 300, SUMMARY_SEC = 60;
const CC_SLUG = "concacaf.w.champions_cup", CHALLENGE_SLUG = "usa.nwsl.cup";
const YEAR = new Date().getUTCFullYear();
const SEASON = `${YEAR}0101-${YEAR}1231`;
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const nowT = Date.now();
const WINDOW = `${ymd(new Date(nowT - 864e5))}-${ymd(new Date(nowT + 864e5))}`;

// ---- request model: a NORMAL browse session --------------------------------
function buildSession(ids) {
	const reqs = [];
	const following = FOLLOW.length > 0;
	const pick = (i) => (ids.teams && ids.teams.length ? ids.teams[i % ids.teams.length] : undefined);

	// 1) COLD OPEN — the fixed launch cost, every session (Home/Schedule/Feed prewarm at launch).
	reqs.push(["config", `/config`]);   // 1/session (Fix 3 saves REPEAT launches within 5 min — an amortized ~0.5-1k/day, not a per-session cut; see prediction note)
	reqs.push(["scoreboard", `/scoreboard?dates=${SEASON}&limit=500`]);                 // NWSL season spine
	if (!FIX_TRIM_SCOREBOARD) {                                                          // Fix 5: aux lazy on Schedule visit
		reqs.push(["scoreboard-aux", `/scoreboard?league=${CC_SLUG}&dates=${SEASON}&limit=500`]);      // Champions Cup
		if (following) reqs.push(["scoreboard-aux", `/scoreboard?league=${CHALLENGE_SLUG}&dates=${SEASON}&limit=500`]); // Challenge Cup
	}
	reqs.push(["headshots", `/headshots`]);
	if (following) reqs.push(["team-videos", `/team-videos?teams=${FOLLOW.join(",")}`]);
	if (following && !FIX_DEFER_FEED) reqs.push(["feed", `/feed?teams=${FOLLOW.join(",")}`]); // Fix 4: prewarm removed → only on Social open (below)

	// 2) BROWSE — the REAL variable cost of a 10-15 min session (day-independent).
	//    Schedule / Standings / Teams tab visits = 0 NEW proxy (ESPN-direct or prewarmed) — noted, not issued.
	for (let i = 0; i < ROSTERS; i++) {                                                  // open a few team squads
		const id = pick(i); if (!id) break;
		reqs.push(["roster", `/roster?team=${id}`]);
		reqs.push(["team-stats", `/team-stats?team=${id}`]);
	}
	for (let i = 0; i < FANZONE; i++) reqs.push(["fanzone(modeled)", `#fanzone`]);       // +2 modeled (edition key not reconstructed)
	if (FEED_REFRESH && following) reqs.push(["feed", `/feed?teams=${FOLLOW.join(",")}`]); // (Fix 4: this is the Social-open feed)

	// 2b) BRIEF MATCH GLANCE — a normal browse step (distinct from the parked sitter): open one match detail
	//     briefly. On a LIVE day it's a live match → its /summary goes DIRECT to ESPN under Fix 2 (OFF the
	//     proxy budget); otherwise a past/future match → proxy /summary. /weather stays on the proxy either way.
	if (ids.eventId && GLANCE_SUMMARIES > 0) {
		for (let i = 0; i < GLANCE_SUMMARIES; i++) {
			if (LIVE && FIX_SUMMARY_DIRECT) continue;   // direct-to-ESPN → not counted as a proxy request
			reqs.push(["summary", `/summary?event=${ids.eventId}`]);
		}
		reqs.push(["weather", `/weather?event=${ids.eventId}`]);
	}

	// 3) AMBIENT POLL — the app-level /scoreboard poll while foreground, bounded by the SHORT session. Normal
	//    day = 300s, live day = 75s. Fix 1 (schedule-aware): on a QUIET day (no live game) the poll is OFF
	//    entirely (0 reads, not one per 300s); a LIVE day keeps 75s unchanged (the core experience).
	if (LIVE) {
		const polls = Math.floor((SESSION_MIN * 60) / POLL_SEC);
		for (let i = 0; i < polls; i++) reqs.push(["scoreboard-poll", `/scoreboard?dates=${WINDOW}&limit=500`]);
	} else if (!FIX_SCHED_POLL) {
		const polls = Math.floor((SESSION_MIN * 60) / QUIET_POLL_SEC);
		for (let i = 0; i < polls; i++) reqs.push(["scoreboard-poll", `/scoreboard?dates=${WINDOW}&limit=500`]);
	} // else: schedule-aware + quiet day → no ambient poll

	// 4) TAIL — the rare user who PARKS watching a live match in-app for --parked-min (default 0). Extra
	//    /scoreboard polls for the parked duration + /summary@60s if sitting on a match DETAIL. This is the
	//    ~1-in-1,000 case; kept as a knob to prove it's bounded, never the default.
	if (PARKED_MIN > 0) {
		const extra = Math.floor((PARKED_MIN * 60) / (LIVE ? POLL_SEC : QUIET_POLL_SEC));
		for (let i = 0; i < extra; i++) reqs.push(["scoreboard-poll", `/scoreboard?dates=${WINDOW}&limit=500`]);
		if (WATCH_DETAIL && ids.eventId) {
			const sums = Math.floor((PARKED_MIN * 60) / SUMMARY_SEC);
			// Fix 2 bounds the sitter tail OFF the proxy: a parked user is watching a LIVE match, so every
			// /summary poll goes direct-to-ESPN — the proxy sees none of it. (Without the fix these were the
			// single worst per-user proxy consumer.) The scoreboard poll stays on the proxy (75s, live-kept).
			for (let i = 0; i < sums; i++) {
				if (LIVE && FIX_SUMMARY_DIRECT) continue;
				reqs.push(["summary", `/summary?event=${ids.eventId}&w=near`]);
			}
			reqs.push(["weather", `/weather?event=${ids.eventId}`]);
		}
	}
	return reqs;
}

// fanzone is modeled (+2 each) but not issued live — add it to counts without a network call.
const FANZONE_MODELED_EACH = 2;

// ---- live id resolution (real team ids + an event id so requests 200) ------
async function resolveIds() {
	try {
		const t = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/teams", { headers: { Accept: "application/json" } });
		const tj = await t.json();
		const teams = (tj?.sports?.[0]?.leagues?.[0]?.teams ?? []).map((e) => e.team?.id).filter(Boolean);
		const sb = await fetch(`${BASE}/scoreboard?dates=${WINDOW}&limit=500`, { headers: { Accept: "application/json" } });
		const sj = await sb.json().catch(() => ({}));
		const events = sj?.events ?? [];
		const eventId = (events.find((e) => e?.status?.type?.state === "in") ?? events[events.length - 1])?.id;
		return { teams, eventId };
	} catch (e) { console.warn(`[resolve] ${e.message}; roster/summary skipped`); return { teams: [], eventId: undefined }; }
}

// ---- HTTP + pool -----------------------------------------------------------
async function fetchOne(path) {
	const t0 = performance.now();
	try {
		const r = await fetch(BASE + path, { headers: { Accept: "application/json" } });
		await r.arrayBuffer();
		return { status: r.status, ok: r.ok, ms: performance.now() - t0, cache: r.headers.get("cf-cache-status") || "n/a" };
	} catch (e) { return { status: 0, ok: false, ms: performance.now() - t0, cache: "ERR", err: e.message }; }
}
async function runPool(tasks, concurrency, onResult) {
	let i = 0;
	const w = async () => { while (i < tasks.length) { const idx = i++; onResult(await fetchOne(tasks[idx].path), tasks[idx]); } };
	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, w));
}
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);

// ---- prediction ------------------------------------------------------------
function perSessionModeled(liveIssuedAvg) {
	return liveIssuedAvg + FANZONE * FANZONE_MODELED_EACH; // add the modeled (not-issued-live) fan-zone reads
}
function printPrediction(perSessionLiveIssued) {
	const per = perSessionModeled(perSessionLiveIssued);
	const daily = per * SESSIONS_PER_DAY * 1000;
	const cadence = LIVE ? `${POLL_SEC}s (live game on board)` : `${QUIET_POLL_SEC}s (no live game)`;
	console.log(`\n  ── PREDICTION — normal browsing, 1,000 users ─────────────────`);
	console.log(`  per-session proxy reads (modeled) : ${per.toFixed(1)}   (live-issued ${perSessionLiveIssued.toFixed(1)} + ${(FANZONE * FANZONE_MODELED_EACH)} modeled Fan Zone)`);
	console.log(`  assumptions: session=${SESSION_MIN}min, rosters/session=${ROSTERS}, fanzone/session=${FANZONE}, feed-refresh=${FEED_REFRESH},`);
	console.log(`               ambient poll=${cadence}, sessions/user/day=${SESSIONS_PER_DAY}, parked-min=${PARKED_MIN}, follow=${FOLLOW.join(",")}`);
	console.log(`  → predicted 1k daily Workers reads : ${Math.round(daily).toLocaleString()}   (cap 100,000; + ~1.7k idle cron burn)`);
	console.log(`  verdict: ${daily < 100000 ? "UNDER cap ✓" : "OVER cap ✗ — needs client request reduction"}`);
	console.log(`  NOTE: this is driven by BROWSING (cold-open + rosters + fan-zone), NOT match count. A live game`);
	console.log(`        only changes the ambient poll cadence (75s vs 300s); nobody is modeled parking for 2h.`);
}

// ---- modes -----------------------------------------------------------------
function planAll(ids) {
	const tasks = [];
	for (let u = 0; u < USERS; u++) for (const [label, path] of buildSession(ids)) if (path[0] !== "#") tasks.push({ label, path });
	return tasks;
}
function endpointTally(items, key = "label") { const m = {}; for (const it of items) m[it[key]] = (m[it[key]] || 0) + 1; return m; }

async function main() {
	console.log(`nwslapp read-load sim (NORMAL BROWSING) → base=${BASE}  users=${USERS}  live=${LIVE}  window=${WINDOW}`);

	if (BURST > 0) {
		const path = `/scoreboard?dates=${WINDOW}&limit=500`;
		console.log(`\n[burst] ${BURST} SIMULTANEOUS cold requests → ${path}`);
		const t0 = performance.now();
		const res = await Promise.all(Array.from({ length: BURST }, () => fetchOne(path)));
		const byCache = {}; let errors = 0, miss = 0;
		for (const r of res) { byCache[r.cache] = (byCache[r.cache] || 0) + 1; if (!r.ok) errors++; if (/MISS|EXPIRED|DYNAMIC/.test(r.cache)) miss++; }
		console.log(`  wall ${(performance.now() - t0).toFixed(0)}ms   errors ${errors}   cache ${Object.entries(byCache).map(([k, v]) => `${k}:${v}`).join(" ")}`);
		console.log(`  origin-ish (MISS/EXPIRED/DYNAMIC) ≈ ${miss}/${BURST} → ${miss <= 3 ? "COALESCED ✓" : "possible stampede — investigate"}`);
		return;
	}

	if (DRY) {
		const ids = { teams: ["T1", "T2", "T3", "T4"], eventId: "E" };
		const sessionReqs = buildSession(ids);
		const issued = sessionReqs.filter((r) => r[1][0] !== "#");
		const tally = endpointTally(issued.map(([label]) => ({ label })));
		console.log(`\n[dry-run] one NORMAL session issues ${issued.length} proxy reads (+ ${FANZONE * FANZONE_MODELED_EACH} modeled Fan Zone):`);
		for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`      ${k.padEnd(16)} ${v}`);
		printPrediction(issued.length);
		return;
	}

	const ids = await resolveIds();
	console.log(`[resolve] teams=${ids.teams.length} eventId=${ids.eventId || "(none live)"}`);
	const tasks = planAll(ids);
	const results = [];
	const t0 = performance.now();
	await runPool(tasks, CONCURRENCY, (res, task) => results.push({ ...res, label: task.label }));
	const wall = (performance.now() - t0) / 1000;
	const byStatus = endpointTally(results, "status"), byCache = endpointTally(results, "cache"), byEp = endpointTally(results);
	const lat = results.map((r) => r.ms); const errors = results.filter((r) => !r.ok).length;
	console.log(`\n  total reads issued    : ${results.length}   (${(results.length / USERS).toFixed(1)}/session live-issued)`);
	console.log(`  errors / non-2xx      : ${errors}`);
	console.log(`  latency p50/p95       : ${pct(lat, 0.5).toFixed(0)}/${pct(lat, 0.95).toFixed(0)}ms`);
	console.log(`  status                : ${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join("  ")}`);
	console.log(`  cf-cache-status       : ${Object.entries(byCache).map(([k, v]) => `${k}:${v}`).join("  ")}`);
	console.log(`  by endpoint           : ${Object.entries(byEp).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ")}`);
	console.log(`  wall ${wall.toFixed(1)}s (${(results.length / wall).toFixed(0)} req/s)`);
	printPrediction(results.length / USERS);
	console.log(`\n  Cross-check: harness issued ${results.length} reads → dashboard "Requests today" delta should ≈ that (+ idle).`);
	if (errors) console.log(`  ❌ ${errors} errors — NOT a clean pass; inspect status above.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
