#!/usr/bin/env node
// Bracket Battle health check — NO SILENT FAILURES gate (Fan Zone, the Worker engine).
//
// Reads the LIVE bracket state from Supabase (public anon key — bracket_editions/entrants/
// matchups are world-readable) and asserts the active edition is structurally sound, so a
// half-working engine (a stuck round, a missing tally, an impossible pool) fails LOUD in the
// deploy flow instead of sitting silently broken. The Worker also emits diag telemetry at
// runtime (GET /telemetry/recent); this is the proactive, deploy-time companion.
//
// Checks (against the one active edition, if any):
//   • pool_size is a supported bracket (64/96/128/160/192) or legacy-null
//   • the edition has entrants
//   • the current round has at least one matchup, and ≤32 (the hard per-round cap)
//   • EVERY non-current round's matchups are resolved (a community_winner_id) — an
//     unresolved past round means a tally never ran
//   • the current round isn't long overdue (round_closes_at far in the past = a stuck
//     advance); a null close time is a manual PAUSE (warned, not failed)
// No active edition is a PASS ("the game comes and goes" — it's hidden between editions).
//
// Usage:
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… node scripts/health_check_bracket.mjs
//   npm run healthcheck   (runs club-news then this)
// Without creds it prints a loud SKIP and exits 0 so the chained healthcheck still runs.

const URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPPORTED_POOLS = new Set([64, 96, 128, 160, 192]);
const OVERDUE_GRACE_MS = 90 * 60 * 1000; // 90 min > the 5-min cron + buffer

if (!URL || !KEY) {
  console.log("\nBracket health check — ⏭️  SKIPPED (set SUPABASE_URL + SUPABASE_ANON_KEY to run).\n");
  process.exit(0);
}

async function sb(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`Supabase GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

const fails = [];
const warns = [];

try {
  const editions = await sb(
    "bracket_editions?is_active=eq.true&select=id,current_round,round_closes_at,pool_size,total_rounds&limit=1");

  console.log(`\nBracket health check — ${URL}\n`);

  if (editions.length === 0) {
    console.log("  ✅ No active edition (between editions — the game is hidden, by design).\n");
    process.exit(0);
  }

  const ed = editions[0];
  const entrants = await sb(`bracket_entrants?edition_id=eq.${encodeURIComponent(ed.id)}&select=entrant_id`);
  const matchups = await sb(
    `bracket_matchups?edition_id=eq.${encodeURIComponent(ed.id)}&select=round,community_winner_id`);

  const current = matchups.filter((m) => m.round === ed.current_round);
  const staleUnresolved = matchups.filter((m) => m.round !== ed.current_round && !m.community_winner_id);

  console.log(`  Edition:        ${ed.id}`);
  console.log(`  Pool size:      ${ed.pool_size ?? "(legacy null)"}`);
  console.log(`  Current round:  ${ed.current_round}  (${current.length} matchups)`);
  console.log(`  Entrants:       ${entrants.length}`);
  console.log(`  Closes at:      ${ed.round_closes_at ?? "(paused — manual)"}\n`);

  if (ed.pool_size != null && !SUPPORTED_POOLS.has(ed.pool_size)) {
    fails.push(`pool_size ${ed.pool_size} is not a supported bracket (64/96/128/160/192)`);
  }
  if (entrants.length === 0) fails.push("edition has no entrants");
  if (current.length === 0) fails.push(`current round ${ed.current_round} has no matchups`);
  if (current.length > 32) fails.push(`current round has ${current.length} matchups (>32 cap)`);
  if (staleUnresolved.length > 0) {
    fails.push(`${staleUnresolved.length} matchup(s) in non-current rounds are unresolved (a tally never ran)`);
  }
  if (ed.round_closes_at == null) {
    warns.push("round is paused (round_closes_at is null) — manual mode hold");
  } else if (Date.now() - new Date(ed.round_closes_at).getTime() > OVERDUE_GRACE_MS) {
    fails.push(`current round closed >90 min ago but hasn't advanced (stuck tally?)`);
  }
} catch (e) {
  fails.push(`fetch failed: ${e.message}`);
}

for (const w of warns) console.log(`  ⚠️  ${w}`);
if (fails.length > 0) {
  for (const f of fails) console.error(`  ❌ ${f}`);
  console.error("\n❌ FAIL — bracket state is unsound. Check GET /telemetry/recent for bracket diag events.\n");
  process.exit(1);
}
console.log("✅ PASS — active edition is structurally sound.\n");
