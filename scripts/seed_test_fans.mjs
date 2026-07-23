#!/usr/bin/env node
//
// seed_test_fans.mjs — populate the Fan Zone with a synthetic test population, pre-launch.
//
// WHY THIS EXISTS
// The Fan Zone is built for a crowd but has one player, so whole surfaces have never been seen:
// populated leaderboards, community answer splits, the Superfan tier ladder, the below-fold "You"
// row (which needs >100 players to reach at all). Design can't be reviewed and bugs can't surface.
// (Case in point: `bracket_scores.display_name` was never written by anything, so every rival
// rendered as "Fan" — invisible while the board had one player. Found only by populating it.)
//
// WHY THIS DOESN'T BREAK THE "ZERO FABRICATED DATA" RULE
// That rule (docs/fan-zone.md §8) forbids the APP inventing rivals client-side — padded counts,
// fake rows synthesized in Swift. This creates REAL rows owned by REAL auth users. The app renders
// them exactly as it will render launch-day traffic and cannot tell the difference. Nothing here
// ships in the app binary. The accounts are purged before launch (`--purge`), and
// health_check_seed_accounts.mjs fails the deploy healthcheck while any still exist.
//
// WHAT GETS SEEDED, AND WHAT DELIBERATELY DOESN'T
// Bracket seeds VOTES ONLY. The real engine then derives community winners, split percentages,
// fan_count, bracket_scores, per-user accuracy/streaks and final ranks (`runBracketTick`). So the
// actual production pipeline computes the leaderboard — nothing downstream is hand-written, and a
// bug in the tally shows up here rather than hiding behind fabricated scores.
// The other games have no server-side engine, so their score rows are written directly.
//
// USAGE
//   node scripts/seed_test_fans.mjs --count 120     # create accounts + populate every game
//   node scripts/seed_test_fans.mjs --dry-run       # print the plan, write nothing
//   node scripts/seed_test_fans.mjs --purge         # delete every seed account (cascades everywhere)
//   node scripts/seed_test_fans.mjs --count 40 --only=bracket,superfan
//
// ENV (both required; --dry-run needs neither)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY     Supabase dashboard → Settings → API
//   PROXY_BASE       optional, defaults to the deployed proxy (quiz pools are read from it)
//   BRACKET_ADMIN_KEY  optional; when set, triggers the tally so bracket scores appear immediately
//
// IDEMPOTENT: re-running reuses existing seed accounts and upserts on each table's natural key, so
// it converges instead of duplicating. All randomness is seeded per-account, so a re-run reproduces
// the same population.
//

import { SEASON_ANCHOR, isoWeekKey, mondayOrdinal } from "./assemble_knowher_prompt.mjs";

// ── Config ──────────────────────────────────────────────────────────────────────

/** The reserved e-mail domain. This is the ONLY handle for teardown and for the launch guard —
 *  every seed account must be findable by it, so never seed an account outside this domain. */
const SEED_DOMAIN = "seed.nwslapp.test";
const SEED_PASSWORD = "seed-fan-not-for-production";

const DEFAULT_COUNT = 120; // > visibleLimit (100) so the below-fold "You" row is reachable
const PROFILE_CHUNK = 200; // rows per PostgREST write — keeps request bodies bounded

/** The 16 NWSL clubs, mirroring the app's `DesignTeamColors.palette` (which is NWSL-scoped by design
 *  and doubles as its "is this an NWSL club?" test). Predict boards are per-club, so seeding all 16
 *  means every club's board is populated, not just the ones the operator happens to follow. */
const CLUBS = ["LA", "BAY", "BOS", "CHI", "DEN", "GFC", "HOU", "KC",
               "NC", "SEA", "ORL", "POR", "LOU", "SD", "UTA", "WAS"];

/** Handle parts. Deliberately plausible rather than "testfan_07": the point is to judge how a real
 *  board READS — column widths, truncation, the visual rhythm of a top-100 list. Teardown keys on
 *  the e-mail domain, never on the name, so plausibility costs nothing. */
const NAME_FIRST = ["Riley", "Jordan", "Casey", "Avery", "Quinn", "Rowan", "Sky", "Emerson", "Harper",
                    "Kai", "Marley", "Sage", "Devon", "Elliot", "Frankie", "Nova", "Reese", "Tatum"];
const NAME_LAST = ["Keeper", "Volley", "Offside", "Pitch", "Header", "Nutmeg", "Corner", "Sweeper",
                   "Striker", "Winger", "Touchline", "Crossbar", "Byline", "Playmaker"];

// ── CLI ─────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const purge = args.includes("--purge");
const count = Number(args.find((a) => a.startsWith("--count"))?.split("=")[1]
  ?? (args.includes("--count") ? args[args.indexOf("--count") + 1] : DEFAULT_COUNT));
const onlyArg = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;
const wants = (game) => !only || only.has(game);

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const PROXY_BASE = (process.env.PROXY_BASE ?? "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!Number.isInteger(count) || count < 1 || count > 5000) {
  fail(`--count must be an integer 1…5000 (got ${count})`);
}
if (!dryRun && (!SUPABASE_URL || !SERVICE_KEY)) {
  fail("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (Supabase dashboard → Settings → API).");
}

// Preflight BOTH credentials' shape before any request. Dashboards elide long values with '…' until
// you click reveal, and a copy taken before revealing carries that character through. Un-guarded it
// surfaces as Node internals — "Cannot convert argument to a ByteString … value of 8230" for a
// header, "Failed to parse URL" for the base — both loud but neither naming the real mistake. Same
// family as the SIWA secret gotcha in CLAUDE.md (a trailing newline signing an invalid JWT).

/** The stray-character check both credentials share. `label` names the env var in the message. */
function assertClean(value, label) {
  const bad = [...value].find((ch) => ch.codePointAt(0) > 126 || ch.codePointAt(0) < 32);
  if (bad) {
    fail(`${label} contains a non-ASCII character (${JSON.stringify(bad)}).\n` +
      "  That usually means a MASKED/TRUNCATED value was copied — the dashboard elides long values\n" +
      "  with '…' until you click reveal. Reveal it first, then copy the WHOLE value.");
  }
  if (value !== value.trim()) {
    fail(`${label} has leading/trailing whitespace — re-export it without the stray space/newline.`);
  }
}

if (!dryRun) {
  assertClean(SUPABASE_URL, "SUPABASE_URL");
  assertClean(SERVICE_KEY, "SUPABASE_SERVICE_ROLE_KEY");

  try {
    const u = new URL(SUPABASE_URL);
    if (u.protocol !== "https:" && u.hostname !== "localhost") {
      fail(`SUPABASE_URL must be https (got "${u.protocol}//").`);
    }
  } catch {
    fail(`SUPABASE_URL isn't a valid URL: "${SUPABASE_URL}"\n` +
      "  Expected exactly:  https://<project-ref>.supabase.co   (no path, no trailing characters)");
  }

  if (!/^(eyJ|sb_)/.test(SERVICE_KEY)) {
    fail(`SUPABASE_SERVICE_ROLE_KEY doesn't look like a Supabase key (starts "${SERVICE_KEY.slice(0, 3)}", length ${SERVICE_KEY.length}).\n` +
      "  Expected a JWT ('eyJ…') or a secret key ('sb_…'). ⚠️ NOT the anon/publishable key — the\n" +
      "  seeder creates auth users, which needs service_role.");
  }
}

// ── Deterministic randomness ────────────────────────────────────────────────────
// Seeded per-account so a re-run produces the SAME population — otherwise every run would reshuffle
// the boards and you'd never be comparing like with like across design iterations.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A long-tailed score in [0, max]. A uniform spread would cluster every fan mid-table and tell you
 *  nothing about how the design handles a runaway leader or a crowded floor; ^2.2 gives the few-high,
 *  many-low shape a real leaderboard has. */
function longTail(rnd, max) {
  return Math.round(max * Math.pow(rnd(), 2.2));
}

function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

/** Stable non-negative hash of a string — gives a question a fixed "difficulty" across all fans. */
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── HTTP ────────────────────────────────────────────────────────────────────────

function authHeaders(extra = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...extra };
}

async function rest(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: authHeaders(init.headers) });
  if (!r.ok) throw new Error(`REST ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

/** Upsert rows in bounded chunks. `onConflict` must name the table's natural key so a re-run
 *  converges rather than erroring on a duplicate. */
async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += PROFILE_CHUNK) {
    const chunk = rows.slice(i, i + PROFILE_CHUNK);
    await rest(`${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(chunk),
    });
  }
  return rows.length;
}

// ── Accounts (Supabase Admin API) ───────────────────────────────────────────────

/** Every existing seed account, paged. The admin list endpoint has no e-mail-domain filter, so we
 *  page and match locally — bounded by how many accounts exist, which we control. */
async function listSeedUsers() {
  const found = [];
  for (let page = 1; page <= 50; page++) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`admin list users → ${r.status} ${await r.text()}`);
    const body = await r.json();
    const users = body.users ?? [];
    if (users.length === 0) break;
    for (const u of users) if ((u.email ?? "").endsWith(`@${SEED_DOMAIN}`)) found.push({ id: u.id, email: u.email });
    if (users.length < 200) break;
  }
  return found;
}

async function createSeedUser(index) {
  const email = `seed+${String(index).padStart(4, "0")}@${SEED_DOMAIN}`;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      email,
      password: SEED_PASSWORD,
      email_confirm: true,
      // The marker a human reads in the dashboard. NOT the teardown key — that's the e-mail domain,
      // because metadata can be edited away while the address can't be, and teardown must not miss one.
      user_metadata: { seed: true, seed_index: index },
    }),
  });
  if (!r.ok) throw new Error(`admin create ${email} → ${r.status} ${await r.text()}`);
  return { id: (await r.json()).id, email };
}

async function deleteUser(id) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!r.ok && r.status !== 404) throw new Error(`admin delete ${id} → ${r.status} ${await r.text()}`);
}

/** Bring the seed population up to `count`, reusing whatever already exists. */
async function ensureAccounts(n) {
  const existing = await listSeedUsers();
  const byIndex = new Map();
  for (const u of existing) {
    const m = /^seed\+(\d+)@/.exec(u.email);
    if (m) byIndex.set(Number(m[1]), u);
  }
  const fans = [];
  let created = 0;
  for (let i = 1; i <= n; i++) {
    let u = byIndex.get(i);
    if (!u) { u = await createSeedUser(i); created++; }
    const rnd = mulberry32(i * 7919);
    fans.push({
      index: i,
      id: u.id,
      email: u.email,
      name: `${pick(rnd, NAME_FIRST)}${pick(rnd, NAME_LAST)}${i % 3 === 0 ? Math.floor(rnd() * 90 + 10) : ""}`,
      rnd,
    });
  }
  console.log(`  accounts: ${fans.length} total (${created} created, ${fans.length - created} reused)`);
  return fans;
}

// ── The season / round context every game keys on ───────────────────────────────

/** Season string — must match the app's `String(AppConfig.currentSeasonYear)`, which holds the
 *  PREVIOUS year through Jan/Feb (NWSL runs Mar–Nov), or seeded rows land in a season the app
 *  never queries and the boards silently stay empty. */
function currentSeasonYear(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() < 2 ? y - 1 : y; // getUTCMonth is 0-based: <2 means Jan/Feb
}

/** The live round number for a quiz slot, mirroring `FanZoneCadence.roundNumber`. Rounds are two
 *  weeks and the two games are staggered by one week, so in any given week one game is dropping a
 *  new round and the other is in week two of its current one. */
function roundContext(now = new Date()) {
  const offset = mondayOrdinal(now) - mondayOrdinal(new Date(`${SEASON_ANCHOR}T00:00:00Z`));
  const slotIsKnowHer = ((offset % 2) + 2) % 2 === 0; // normalise: JS % keeps the dividend's sign
  const openOffset = (slot) => (slotIsKnowHer === (slot === "knowher") ? offset : offset - 1);
  const roundFor = (slot) => {
    const open = openOffset(slot);
    return open >= 0 ? Math.floor(open / 2) + 1 : null;
  };
  return {
    weekOffset: offset,
    knowher: roundFor("knowher"),
    trivia: roundFor("trivia"),
    weekKey: isoWeekKey(now),
    season: currentSeasonYear(now),
  };
}

/** Trivia's edition key — mirrors `FanZoneCadence.editionKey`. */
const triviaEditionKey = (round, seasonYear) => `${seasonYear}-R${String(round).padStart(2, "0")}`;

// ── Games ───────────────────────────────────────────────────────────────────────

/** BRACKET — votes only; the engine derives everything else.
 *  Votes are weighted toward the higher seed (favourites really do win more often), because a
 *  50/50 split on every matchup would make the community-split UI look broken in a way real
 *  traffic never would. */
async function seedBracket(fans, ctx) {
  const editions = await rest("bracket_editions?is_active=eq.true&select=id&limit=1");
  if (!editions?.length) {
    console.log("  bracket: SKIPPED — no active edition (start one via bracket_config manual_action)");
    return 0;
  }
  const editionId = editions[0].id;
  const matchups = await rest(
    `bracket_matchups?edition_id=eq.${editionId}&select=id,round,entrant_a_id,entrant_b_id`);
  if (!matchups?.length) {
    console.log(`  bracket: SKIPPED — edition ${editionId} has no matchups yet`);
    return 0;
  }
  const seeds = await rest(`bracket_entrants?edition_id=eq.${editionId}&select=entrant_id,seed`);
  const seedOf = new Map((seeds ?? []).map((e) => [e.entrant_id, e.seed]));

  const rows = [];
  for (const fan of fans) {
    // A realistic field doesn't have 100% turnout on every round.
    if (fan.rnd() < 0.12) continue;
    for (const m of matchups) {
      const seedA = seedOf.get(m.entrant_a_id) ?? 99;
      const seedB = seedOf.get(m.entrant_b_id) ?? 99;
      const favourA = seedA <= seedB;
      const pickFavourite = fan.rnd() < 0.68;
      rows.push({
        user_id: fan.id, matchup_id: m.id, edition_id: editionId, round: m.round,
        entrant_id: (favourA === pickFavourite) ? m.entrant_a_id : m.entrant_b_id,
      });
    }
  }
  await upsert("bracket_votes", rows, "user_id,matchup_id");
  console.log(`  bracket: ${rows.length} votes across ${matchups.length} matchups (edition ${editionId})`);
  return rows.length;
}

/** PREDICT — per-club season totals + per-week round totals, for ALL 16 clubs.
 *  Max 88/fixture (`PredictionScoring`), so a season total is a multi-fixture accumulation. */
async function seedPredict(fans, ctx) {
  const season = String(ctx.season);
  const seasonRows = [];
  const roundRows = [];
  // The soccer weeks a round board can show. `predict_round_scores` is pruned at ~28 days, so
  // seeding older weeks would be swept by the retention cron — 4 weeks is what stays visible.
  const weeks = [ctx.weekOffset - 3, ctx.weekOffset - 2, ctx.weekOffset - 1, ctx.weekOffset]
    .filter((w) => w >= 1);

  for (const fan of fans) {
    // A fan follows a few clubs, not all 16 — a board where every fan appears on every club's
    // leaderboard is the one shape real traffic will never have.
    const followCount = 1 + Math.floor(fan.rnd() * 3);
    const clubs = new Set();
    while (clubs.size < followCount) clubs.add(pick(fan.rnd, CLUBS));

    for (const club of clubs) {
      const perWeek = weeks.map(() => longTail(fan.rnd, 88));
      const total = perWeek.reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      seasonRows.push({
        user_id: fan.id, team_abbreviation: club, season, display_name: fan.name, points: total,
      });
      weeks.forEach((week, i) => {
        if (perWeek[i] === 0) return;
        roundRows.push({
          user_id: fan.id, team_abbreviation: club, season, week,
          display_name: fan.name, points: perWeek[i],
        });
      });
    }
  }
  await upsert("prediction_scores", seasonRows, "user_id,team_abbreviation,season");
  await upsert("predict_round_scores", roundRows, "user_id,team_abbreviation,season,week");
  console.log(`  predict: ${seasonRows.length} season rows + ${roundRows.length} round rows across ${CLUBS.length} clubs`);
  // Per-user contribution to the Superfan total, returned rather than read back: the numbers are
  // already in hand, and a read-back would be an unbounded select whose failure would silently
  // zero the Superfan rows (exactly what a stub run surfaced).
  const byUser = new Map();
  for (const r of seasonRows) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + r.points);
  return byUser;
}

/** Fetch a quiz pool from the proxy so answers reference REAL question ids — an answer against an
 *  invented id aggregates into a question the app never renders, i.e. invisible no-op rows. */
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

/** QUIZ (Trivia + Know Her Game) — per-question answers feeding the community distribution.
 *  `is_correct` is skewed toward correct with a per-question difficulty, so the bars differentiate
 *  instead of every option drawing the same length. */
async function seedQuiz(fans, ctx, game) {
  const round = game === "trivia" ? ctx.trivia : ctx.knowher;
  if (!round) {
    console.log(`  ${game}: SKIPPED — no round live yet (season week ${ctx.weekOffset})`);
    return new Map();
  }

  // [editionKey, questions[], answersPerFan] triples. `answersPerFan` is null = "answer them all".
  const editions = [];
  if (game === "trivia") {
    const pool = await fetchJSON(`${PROXY_BASE}/trivia`);
    const all = Array.isArray(pool) ? pool : (pool.questions ?? []);
    if (!all.length) { console.log("  trivia: SKIPPED — empty pool"); return new Map(); }
    // ⚠️ We deliberately do NOT try to reproduce the app's exact round slate.
    // `TriviaViewModel.roundSelection` shuffles the id-sorted pool with a seeded generator, and Swift's
    // `shuffled(using:)` consumption pattern is stdlib-internal (Lemire bounded-random) — mirroring it
    // in JS would couple this throwaway script to Swift stdlib internals and silently drift.
    //
    // Instead each fan answers a RANDOM 10 of the pool. That is correct where it matters:
    //   • `quiz_summary.responders`  = distinct users            → exact
    //   • `quiz_summary.avg_correct` = correct / distinct users  → out of 10, the right magnitude
    //     (this is why we can't just answer the whole 41-question pool: the average would read ~20/10)
    //   • per-question rows exist for EVERY question in the pool, so whichever 10 the app actually
    //     renders, all of them have community data.
    editions.push([triviaEditionKey(round, ctx.season), all, 10]);
  } else {
    const pool = await fetchJSON(`${PROXY_BASE}/knowher?teams=${CLUBS.join(",")}`);
    const weekKey = pool.weekKey ?? ctx.weekKey;
    // A KHG edition IS its player's 10 questions and the app shows all of them, so answer all.
    for (const p of pool.players ?? []) {
      const key = `${weekKey}-${String(p.teamAbbreviation).toUpperCase()}-${p.espnAthleteId}`;
      editions.push([key, p.questions ?? [], null]);
    }
    if (!editions.length) { console.log("  knowher: SKIPPED — no featured players in the pool"); return new Map(); }
  }

  const season = String(ctx.season);
  const rows = [];
  for (const [editionKey, questions, answersPerFan] of editions) {
    if (!questions.length) continue;
    for (const fan of fans) {
      // Not everyone plays every edition — KHG especially is per-club.
      if (fan.rnd() < (game === "trivia" ? 0.35 : 0.72)) continue;
      // The subset this fan answered (all of them when answersPerFan is null).
      let asked = questions;
      if (answersPerFan && answersPerFan < questions.length) {
        const idx = questions.map((_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) {           // Fisher-Yates on the fan's own stream
          const j = Math.floor(fan.rnd() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        asked = idx.slice(0, answersPerFan).map((i) => questions[i]);
      }
      for (const q of asked) {
        const optionCount = Math.max(2, (q.options ?? []).length || 4);
        const correctIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : 0;
        // Per-question difficulty, keyed on the question's IDENTITY — not its position in this fan's
        // shuffled subset, which would give the same question a different difficulty per fan and
        // average every bar back to the same height, defeating the point.
        const difficulty = 0.35 + (hashCode(String(q.id)) % 50) / 100;
        const gotIt = fan.rnd() < difficulty;
        let selected = correctIndex;
        if (!gotIt) {
          selected = Math.floor(fan.rnd() * optionCount);
          if (selected === correctIndex) selected = (selected + 1) % optionCount;
        }
        rows.push({
          user_id: fan.id, game, edition_key: editionKey,
          question_id: String(q.id), selected_index: selected,
          is_correct: selected === correctIndex, season,
        });
      }
    }
  }
  await upsert("quiz_answers", rows, "user_id,game,edition_key,question_id");
  console.log(`  ${game}: ${rows.length} answers across ${editions.length} edition(s), round ${round}`);
  // Correct answers per user — the game's contribution to the Superfan total (1 point each,
  // matching GameCenterScores.superfanTotal).
  const byUser = new Map();
  for (const r of rows) if (r.is_correct) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + 1);
  return byUser;
}

/** SUPERFAN — the cross-game season total the ranking reads.
 *  Derived by summing what we actually wrote for each fan, because the app computes its own total
 *  client-side: an independently-invented server number would disagree with the per-game breakdown
 *  on screen and read as a bug. */
async function seedSuperfan(fans, ctx, totals) {
  const season = String(ctx.season);
  const rows = [];
  for (const fan of fans) {
    const t = totals.get(fan.id);
    if (!t || t.total <= 0 || t.games < 1) continue;
    rows.push({
      user_id: fan.id, season, total: t.total, games_played: t.games, display_name: fan.name,
    });
  }
  await upsert("superfan_scores", rows, "user_id,season");
  const qualifying = rows.filter((r) => r.games_played >= 2).length;
  console.log(`  superfan: ${rows.length} rows (${qualifying} qualifying, i.e. ≥2 games)`);
  return rows.length;
}

// ── Teardown ────────────────────────────────────────────────────────────────────

/** Delete every seed account. Every per-user table FKs `auth.users(id) on delete cascade`, so this
 *  one loop removes bracket_votes/scores/stats, prediction_scores, predict_round_scores,
 *  quiz_answers, superfan_scores, profiles and fanzone_progress with it. No orphans by construction. */
async function runPurge() {
  const users = await listSeedUsers();
  if (!users.length) { console.log("Nothing to purge — no seed accounts found."); return; }
  console.log(`Deleting ${users.length} seed accounts (cascades to every per-user table)…`);
  let done = 0;
  for (const u of users) {
    await deleteUser(u.id);
    if (++done % 25 === 0) console.log(`  …${done}/${users.length}`);
  }
  console.log(`✓ Purged ${done} accounts.`);
  console.log("→ Revoke the temporary seed grants (teardown block at the bottom of");
  console.log("   NWSLApp/supabase/migration_seed_grants.sql) — returns the service-role key");
  console.log("   to the reach it had before seeding.");
  console.log("→ Re-run the bracket tally so fan_count/scores reflect the real field:");
  console.log('   curl -X POST -H "x-admin-key: $BRACKET_ADMIN_KEY" ' + `${PROXY_BASE}/bracket/run`);
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  if (purge) return runPurge();

  const ctx = roundContext();
  console.log(`Season ${ctx.season} · season week ${ctx.weekOffset} · KHG round ${ctx.knowher ?? "—"} · Trivia round ${ctx.trivia ?? "—"}`);

  if (dryRun) {
    console.log(`\nDRY RUN — would seed ${count} accounts @${SEED_DOMAIN}:`);
    for (const g of ["bracket", "predict", "knowher", "trivia", "superfan"]) {
      console.log(`  ${wants(g) ? "✓" : "·"} ${g}`);
    }
    console.log(`\nTrivia edition key would be: ${ctx.trivia ? triviaEditionKey(ctx.trivia, ctx.season) : "(no round live)"}`);
    console.log("Nothing was written. Re-run without --dry-run to apply.");
    return;
  }

  console.log(`\nSeeding ${count} fans…`);
  const fans = await ensureAccounts(count);

  // profiles carries the display name for anything that joins it (and the bracket tally now stamps
  // bracket_scores.display_name from here).
  await upsert("profiles", fans.map((f) => ({ id: f.id, display_name: f.name, name_is_custom: true })), "id");
  console.log(`  profiles: ${fans.length} rows`);

  // Track each fan's contribution so the Superfan total agrees with the per-game numbers.
  const totals = new Map(fans.map((f) => [f.id, { total: 0, games: 0 }]));
  const add = (userId, points) => {
    const t = totals.get(userId);
    if (!t) return;
    t.total += points;
    t.games += 1;
  };

  // NOTE Bracket is absent from the Superfan sum on purpose: its points are derived by the ENGINE
  // from the votes we seed, which happens later on the tally tick, so there is no honest number to
  // add here. `superfan_scores` exists only for RANKING (docs/fan-zone.md §6) — the client computes
  // and displays its own total — so a bracket-less server total costs nothing but a slightly lower
  // rank, and inventing one would be the fabrication this whole approach avoids.
  if (wants("bracket")) await seedBracket(fans, ctx);
  if (wants("predict")) {
    for (const [uid, pts] of await seedPredict(fans, ctx)) add(uid, pts);
  }
  for (const game of ["trivia", "knowher"]) {
    if (!wants(game)) continue;
    for (const [uid, correct] of await seedQuiz(fans, ctx, game)) add(uid, correct);
  }
  if (wants("superfan")) await seedSuperfan(fans, ctx, totals);

  console.log("\n✓ Seeded.");
  if (wants("bracket")) {
    if (process.env.BRACKET_ADMIN_KEY) {
      const r = await fetch(`${PROXY_BASE}/bracket/run`, {
        method: "POST", headers: { "x-admin-key": process.env.BRACKET_ADMIN_KEY },
      });
      console.log(`→ Bracket tally triggered: ${r.status} ${(await r.text()).slice(0, 120)}`);
    } else {
      console.log("→ Bracket scores appear after the tally runs. Trigger it now with:");
      console.log('   curl -X POST -H "x-admin-key: $BRACKET_ADMIN_KEY" ' + `${PROXY_BASE}/bracket/run`);
    }
  }
  console.log("→ Tear down before launch:  node scripts/seed_test_fans.mjs --purge");
}

main().catch((e) => fail(e.message));
