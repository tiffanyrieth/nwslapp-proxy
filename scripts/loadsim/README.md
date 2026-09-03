# Read-load simulation — the 1k-user pre-publish READ gate

`sim.mjs` measures the **read** load a real user base puts on the account-wide Cloudflare Workers
**100k requests/day** cap. It simulates a **NORMAL session**: cold-open the app, browse ~10–15 min across
the WHOLE app (Home, Schedule, Standings, Teams, a few team rosters, a Fan Zone game or two, the Feed),
and leave. That is the real load — it happens on **any** day and has **nothing to do with match count**.
It's what nearly hit the request ceiling around ~900 users on a cold open before the proxy request-shaping
fixes. Prior stress passes counted WRITES and treated reads as unlimited; this closes that gap.

**Not the centerpiece — the in-app live poll.** Lock-screen V2-LA is PUSHED (APNs broadcast → the device
receives it passively) so it costs **zero reads**. The in-app `/scoreboard` poll is foreground-only and
throttled; ~1 user in 1,000 parks in the app watching a match, not the 1,000. We model the *ambient* poll
(it does run while foreground, but bounded by the SHORT session) and expose a `--parked-min` knob for the
rare sitter so we can SEE it's bounded — never treat it as the driver.

**Never touches analytics.** Standalone Node hitting GET reads only — never POSTs `/analytics`/`/telemetry`
(code-verified: only `handleAnalyticsIngest` writes `analytics_counters`). Nothing to clear from the admin
portal. Sole prod footprint = the Workers request COUNT (resets 00:00 UTC = 8pm ET).

## Faithful per-session model (derived from the app's real fetches)
| Phase | Proxy reads |
|---|---|
| **Cold open** (fires every session; Home/Schedule/Feed prewarm at launch) | `/config` (always-network) · `/scoreboard` NWSL season · `/scoreboard?league=concacaf.w.champions_cup` · `/scoreboard?league=usa.nwsl.cup` (if following) · `/headshots` · `/team-videos` · `/feed` = **~7** |
| **Browse** (the real variable cost) | Schedule/Standings/Teams tab visits = **0 new** (ESPN-direct / prewarmed) · each team roster opened = `/roster` + `/team-stats` = **+2** · each Fan Zone game = **+2** (Trivia/KHG; Bracket 0) · a feed re-fetch on scope change = **+1** |
| **Ambient poll** (app-level, foreground-only, bounded by session length) | windowed `/scoreboard` (same URL → edge-coalesces) at **300s** normally, **75s** if a live game is on the board |
| **Tail — parked sitter** (`--parked-min`, default 0; the rare 1-in-1,000) | extra `/scoreboard` polls + `/summary`@60s while on a match detail |

## Committed prediction (BEFORE calibration — falsifiable)
Assumptions (the REAL knobs — vary these, not "match count"): session 12 min, 3 rosters/session,
1 Fan Zone/session, 1 feed-refresh, 3 sessions/user/day, follow 2 clubs.

| Day type | per-session reads | **predicted 1k daily** | vs 100k |
|---|---|---|---|
| **Normal browsing** (no live game) | 18 | **~54,000** | UNDER ✓ |
| Live game on the board (ambient poll 75s) | 25 | ~75,000 | UNDER ✓ (tighter) |
| *Tail: one 90-min in-app sitter* | 188 (that one session) | — (×1 person, not ×1k) | shows the poll is a bounded TAIL |

The daily total is **browsing × users × sessions/day** — cold-open + rosters + Fan Zone dominate. A live
game only speeds the ambient poll (75s vs 300s); it does not multiply with match count (one windowed
`/scoreboard` returns all live matches in a single request). The calibration replaces the per-session
figure with a MEASURED one; the daily then rides the sessions/day + browse-depth assumptions (the residual
uncertainty to sanity-check post-launch).

## Commands
```bash
node scripts/loadsim/sim.mjs --dry-run                 # normal browsing day — model + prediction (no network)
node scripts/loadsim/sim.mjs --dry-run --live          # a live game is on (ambient poll 75s)
node scripts/loadsim/sim.mjs --dry-run --parked-min=90 --users=1   # the rare in-app sitter (bounded tail)

node scripts/loadsim/sim.mjs --users=100               # PROD calibration (~100 normal sessions)
node scripts/loadsim/sim.mjs --users=100 --live        # PROD calibration, live-game ambient poll
node scripts/loadsim/sim.mjs --burst=300               # cold launch-storm coalescing test (PROD)
```
Base defaults to prod; override with `PROXY_BASE=http://localhost:8787` or `--base=`. Browse knobs:
`--session-min --rosters --fanzone --feed-refresh --sessions-per-day --live --parked-min --follow`.

## Run protocol (estimate-then-calibrate — one UTC day, before 8pm ET)
1. Prediction committed above (falsifiable).
2. **Snapshot** the Cloudflare Usage "Requests today" (drifts ~65/hr from idle crons; 2026-09-02 baselines 1,698 → 1,763).
3. **Run** `--users=100` (and again `--users=100 --live`) against prod — each issues ~1.6–2.5k reads in seconds.
4. **Re-snapshot.** Cross-check: dashboard delta ≈ the harness's reported "total reads issued" (+ idle). Divergence = something un-modeled; investigate before trusting it.
5. **Extrapolate:** per-session = total ÷ 100; × sessions/day × 1000. Compare to the ~54k / ~75k predictions and 100k.
6. **Burst:** `--burst=300` → expect ~1 MISS + rest HIT (coalesced ✓).
7. **Verdict** → record in `docs/stress-testing.md §7`.

## Pass bars
- Normal-day 1k daily reads **well under 100k** (expect ~54k); live-day under 100k (expect ~75k). · ESPN
  origin flat under the burst (coalesced). · **0 errors / non-2xx**. If a day type is tight, the levers are
  client request reduction (schedule-aligned TTL, split slow IG route, `/config` fetch fix, trim launch
  scoreboards) — per the stress-test resume pin — not dropping features.

## Note on local `wrangler dev`
Intended as the pre-prod smoke, but it doesn't boot here (Node 26 + workerd `ERR_IPC_CHANNEL_CLOSED`) and
the local env lacks `ESPN_UA`/Apify so reads would 403 anyway. Request-generation is validated via
`--dry-run`; the HTTP loop is standard. The owner's ~100-session prod calibration is the first live run —
safe (dry-run-proven logic, ~1.6–2.5k recoverable reads, self-reports errors).
