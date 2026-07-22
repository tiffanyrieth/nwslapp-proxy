// Know Her Game — the weekly "how well do you know this player?" quiz that replaces
// the passive Player Spotlight. This module holds the reusable, testable pieces:
//   • the content schema + a single validator (shared shape with scripts/load_knowher.mjs
//     and the app's KnowHerGame model),
//   • roster-learning ELIGIBILITY (who's pickable this season — starts ≥ 1), reusing the
//     bracket engine's ESPN roster/stats primitives,
//   • the operator ADMIN surface (paste content → KV, flip manual/auto mode, view state).
//
// The route that SERVES the pool (GET /knowher) lives in index.ts alongside the other
// cached route handlers (handleTrivia/handleSpotlight) so it reuses their edge-cache
// helpers. Content is MANUAL for launch: the owner pastes vetted Q&A into the admin, which
// writes KV `knowher-pool-v1`. The AUTO weekly generator is deferred (docs/know-her-game.md
// §5); its pipe (eligibility, mode flag, admin) is built now so nothing gets retrofitted.

import { fetchTeamAbbrs, fetchRoster, fetchStatsForMany } from "./bracket-engine.ts";
import { adminAuthed, adminRealm } from "./admin-auth.ts";

export const KNOWHER_POOL_KEY = "knowher-pool-v1"; // KV: the live pool document (this week's players)
export const KNOWHER_MODE_KEY = "knowher:mode"; // KV: "manual" | "auto" (default manual)
// Per-season "already featured" ledger (docs §4 "once per season, hard"): key `knowher:featured:{season}`.
// A player featured this season is removed from the eligible pool so the weekly pick advances through the
// roster (a season = a learning curriculum) instead of repeating stars. First per-team+season KV state.
export const KNOWHER_FEATURED_PREFIX = "knowher:featured:"; // + season, e.g. "knowher:featured:2026"

// The four question categories mirror the app's F3 labels (docs §7):
//   herGame = Her game · herStory = Her story · herWorld = Her world · trueOrFalse = True or false
export const KNOWHER_CATEGORIES = new Set(["herGame", "herStory", "herWorld", "trueOrFalse"]);
const MIN_QUESTIONS = 8; // NYT-model ~10 floor with a little flex (docs §2); 8 stat + 1–2 fun
const MAX_QUESTIONS = 25; // 10 is the FLOOR, not a cap — a rich player (lots of good facts) can go higher (owner)

export interface KnowHerQuestion {
  id: string;
  category: "herGame" | "herStory" | "herWorld" | "trueOrFalse";
  prompt: string;
  options: string[]; // exactly 4 for MC, exactly 2 (True/False) for trueOrFalse
  correctIndex: number; // 0-based, within options
  revealFact?: string; // the "learn" payoff surfaced on the result screen
}

export interface KnowHerPlayer {
  teamAbbreviation: string;
  espnAthleteId: string; // the app resolves the headshot via HeadshotStore from this id
  espnTeamId?: string; // numeric ESPN team id, STAMPED server-side at publish (not from the AI) — lets the
                       // match-watcher target this team's followers for the biweekly KHG push
  playerName: string;
  jerseyNumber: number;
  position: string;
  tagline: string; // one-line intro hook (F2)
  questions: KnowHerQuestion[];
}

export interface KnowHerPool {
  weekKey: string; // e.g. "2026-W27" — the Mon–Sun window this pool is live for
  season: number; // e.g. 2026
  round?: number; // 1-based edition index this season, STAMPED server-side at publish — the picker's "Round N"
  players: KnowHerPlayer[]; // one featured player per team (never a team the user doesn't follow)
}

/** Validate an unknown value against the pool schema. Returns the typed pool or a
 *  human-readable error. The SAME rules run in scripts/load_knowher.mjs (JS copy) and the
 *  admin pasteContent op, so bad content can never reach KV from either path. */
export function validateKnowHerPool(raw: unknown): { pool: KnowHerPool } | { error: string } {
  const doc = raw as Partial<KnowHerPool> | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { error: "pool must be a JSON object" };
  if (typeof doc.weekKey !== "string" || !doc.weekKey.trim()) return { error: "missing/blank weekKey" };
  if (!Number.isInteger(doc.season)) return { error: "season must be an integer year" };
  if (!Array.isArray(doc.players) || doc.players.length === 0) return { error: "players must be a non-empty array" };

  const teamsSeen = new Set<string>();
  for (let i = 0; i < doc.players.length; i++) {
    const p = doc.players[i] as Partial<KnowHerPlayer>;
    const at = `players[${i}] (${p?.playerName ?? "?"})`;
    if (typeof p?.teamAbbreviation !== "string" || !p.teamAbbreviation.trim()) return { error: `${at}: missing teamAbbreviation` };
    const abbr = p.teamAbbreviation.toUpperCase();
    if (teamsSeen.has(abbr)) return { error: `${at}: duplicate team ${abbr} (one player per team)` };
    teamsSeen.add(abbr);
    if (typeof p.espnAthleteId !== "string" || !p.espnAthleteId.trim()) return { error: `${at}: missing espnAthleteId` };
    if (typeof p.playerName !== "string" || !p.playerName.trim()) return { error: `${at}: missing playerName` };
    if (!Number.isInteger(p.jerseyNumber) || (p.jerseyNumber as number) < 0) return { error: `${at}: jerseyNumber must be a non-negative integer` };
    if (typeof p.position !== "string" || !p.position.trim()) return { error: `${at}: missing position` };
    if (typeof p.tagline !== "string" || !p.tagline.trim()) return { error: `${at}: missing tagline` };
    if (!Array.isArray(p.questions) || p.questions.length < MIN_QUESTIONS || p.questions.length > MAX_QUESTIONS) {
      return { error: `${at}: must have ${MIN_QUESTIONS}–${MAX_QUESTIONS} questions (has ${p.questions?.length ?? 0})` };
    }
    const qids = new Set<string>();
    for (let j = 0; j < p.questions.length; j++) {
      const q = p.questions[j] as Partial<KnowHerQuestion>;
      const qat = `${at} question ${j} (id=${q?.id ?? "?"})`;
      if (typeof q?.id !== "string" || !q.id.trim()) return { error: `${qat}: missing/blank id` };
      if (qids.has(q.id)) return { error: `${qat}: duplicate question id` };
      qids.add(q.id);
      if (!KNOWHER_CATEGORIES.has(q.category as string)) return { error: `${qat}: invalid category "${q.category}"` };
      if (typeof q.prompt !== "string" || !q.prompt.trim()) return { error: `${qat}: missing/blank prompt` };
      const tf = q.category === "trueOrFalse";
      const wantOpts = tf ? 2 : 4;
      if (!Array.isArray(q.options) || q.options.length !== wantOpts) {
        return { error: `${qat}: ${tf ? "trueOrFalse" : "MC"} needs exactly ${wantOpts} options` };
      }
      if (q.options.some((o) => typeof o !== "string" || !o.trim())) return { error: `${qat}: every option must be a non-blank string` };
      if (!Number.isInteger(q.correctIndex) || (q.correctIndex as number) < 0 || (q.correctIndex as number) >= wantOpts) {
        return { error: `${qat}: correctIndex must be 0–${wantOpts - 1}` };
      }
      if (q.revealFact !== undefined && (typeof q.revealFact !== "string")) return { error: `${qat}: revealFact must be a string` };
    }
  }
  return { pool: doc as KnowHerPool };
}

/** Serve only the requested teams' entries (case-insensitive). Empty `teams` → the whole
 *  pool (the app filters client-side to its follows in that case). Pure. */
export function filterPoolByTeams(pool: KnowHerPool, teams: string[]): KnowHerPool {
  if (teams.length === 0) return pool;
  const want = new Set(teams.map((t) => t.toUpperCase()));
  return { ...pool, players: pool.players.filter((p) => want.has(p.teamAbbreviation.toUpperCase())) };
}

/** ISO-8601 week (Monday-start) as "YYYY-Www" — the weekKey convention the pool stamps and the app's
 *  KnowHerGameStore parses. TS twin of the helper in scripts/assemble_knowher_prompt.mjs — the shared
 *  test (test/knowher.test.ts) locks both implementations to the same cases; change them in lock-step.
 *  Used by the serving path's staleness telemetry (a pool left behind the current week = the weekly
 *  automation silently failed — must be loud, never invisible). */
export function isoWeekKey(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // shift to the Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export interface EligiblePlayer {
  athleteId: string;
  name: string;
  jersey: number | null;
  position: string;
  team: string;
  // Bio fields from the ESPN roster — the weekly generation prompt's player block byte-matches the
  // proven Rodman format ("age 24, USA"), so /knowher/todo serves them alongside the stats. null when
  // ESPN omits them (the assembler then drops that fragment rather than fabricating).
  age: number | null;
  country: string | null;
  starts: number;
  minutes: number;
  appearances: number;
  // Attached so /knowher/todo can hand the weekly generator VERIFIED stats (it must USE these numbers,
  // never look them up — docs §5b). Keys resolved live from ESPN's `offensive` category.
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  // Keeper stats (ESPN `goalKeeping` category) — a GOALKEEPER pick's offensive numbers are all zero,
  // which would strand the generator's "USE THESE NUMBERS" rule with nothing usable. Zero for outfield
  // players; the assembler emits a keeper stat line (clean sheets / saves) when position is GK.
  cleanSheets: number;
  saves: number;
}

/** Minimum season minutes for a NON-STARTER to be eligible for Know Her Game. Starters (starts ≥ 1) are
 *  always eligible regardless of minutes; this floor gates only the season-tail supersubs, filtering pure
 *  roster filler (4th GKs, emergency call-ups, a one-off 10-minute cameo). Owner rule (2026-07-21). */
export const KHG_MIN_MINUTES = 100;

/** Pure ranking + gate + season-tail fallback (docs §4), split out so it's unit-testable without the
 *  network. The eligible pool = STARTERS (starts ≥ 1) always, PLUS non-starters with ≥ KHG_MIN_MINUTES
 *  minutes, minus already-featured ids. Ranked core-starters-first: starts desc, then minutes desc. This
 *  single ranking makes the "season-tail fallback" emerge for free — while any unfeatured STARTER remains
 *  it sorts to the top; once all starters are featured (removed via the ledger), the highest-minutes
 *  SUPERSUB (starts 0, minutes ≥ 100) is next. Sub-threshold / unplayed players drop out. DYNAMIC RE-ENTRY
 *  is automatic: this runs on LIVE stats each cycle, so a returning-from-injury player who crosses 100' (or
 *  makes a start) becomes eligible for the next edition. The tiebreak is athleteId (NOT name → not A–Z, so
 *  no club/player is permanently buried); combined with once-per-season removal, that satisfies §4's
 *  "deterministic, fair" ordering without a separate week seed. */
export function rankEligible(players: EligiblePlayer[], excludeIds: Set<string> = new Set()): EligiblePlayer[] {
  const eligible = players.filter(
    (p) => !excludeIds.has(p.athleteId) && (p.starts >= 1 || p.minutes >= KHG_MIN_MINUTES),
  );
  eligible.sort((a, b) => b.starts - a.starts || b.minutes - a.minutes || (a.athleteId < b.athleteId ? -1 : 1));
  return eligible;
}

/** This week's featured pick for a team = the top of the ranked, not-yet-featured pool (or null if none
 *  left). Pure. Progression across the season comes from the once-per-season ledger removing each pick. */
export function pickWeeklyFeatured(eligible: EligiblePlayer[]): EligiblePlayer | null {
  return eligible[0] ?? null;
}

/** Roster-learning eligible pool for one team+season (docs §4). Reuses the bracket engine's ESPN
 *  primitives, then defers gate/rank/fallback to the pure `rankEligible`. Best-effort per player; a
 *  stat-fetch failure just excludes that player (never throws). Pass the season's featured ids to skip
 *  already-featured players. */
export async function computeEligiblePlayers(
  teamAbbr: string,
  year: number,
  excludeIds: Set<string> = new Set(),
): Promise<EligiblePlayer[]> {
  const want = teamAbbr.toUpperCase();
  const teams = await fetchTeamAbbrs();
  const team = teams.find((t) => t.abbr === want);
  if (!team) return [];
  const roster = await fetchRoster(team.id, team.abbr);
  const ids = roster.map((p) => p.id).filter((id) => !excludeIds.has(id));
  const stats = await fetchStatsForMany(ids, year);

  const players: EligiblePlayer[] = roster.map((p) => {
    const s = stats.get(p.id);
    return {
      athleteId: p.id,
      name: p.name,
      jersey: p.jersey,
      position: p.position,
      team: p.team,
      age: p.age ?? null,
      country: p.country ?? null,
      starts: Math.round(s?.["general.starts"] ?? 0),
      minutes: Math.round(s?.["general.minutes"] ?? 0),
      appearances: Math.round(s?.["general.appearances"] ?? 0),
      goals: Math.round(s?.["offensive.totalGoals"] ?? 0),
      assists: Math.round(s?.["offensive.goalAssists"] ?? 0),
      shots: Math.round(s?.["offensive.totalShots"] ?? 0),
      shotsOnTarget: Math.round(s?.["offensive.shotsOnTarget"] ?? 0),
      cleanSheets: Math.round(s?.["goalKeeping.cleanSheet"] ?? 0),
      saves: Math.round(s?.["goalKeeping.saves"] ?? 0),
    };
  });
  return rankEligible(players, excludeIds);
}

// ── Featured ledger (once-per-season) ───────────────────────────────────────────
export interface FeaturedEntry {
  athleteId: string;
  teamAbbr: string;
  weekKey: string;
}
interface FeaturedLedger {
  season: number;
  featured: FeaturedEntry[];
}

/** The set of athleteIds already featured this season (empty if the ledger doesn't exist yet). */
export async function readFeaturedIds(env: KnowHerEnv, season: number): Promise<Set<string>> {
  const doc = (await env.FEED_TAGS.get(`${KNOWHER_FEATURED_PREFIX}${season}`, "json")) as FeaturedLedger | null;
  return new Set((doc?.featured ?? []).map((f) => f.athleteId));
}

/** Mark players featured for the season (idempotent — re-marking an existing id is a no-op, so re-pasting
 *  the same pool to fix a typo is harmless). Called on every live pool write. Returns the ledger size. */
export async function markFeatured(
  env: KnowHerEnv,
  season: number,
  weekKey: string,
  players: Array<{ athleteId: string; teamAbbr: string }>,
): Promise<number> {
  const key = `${KNOWHER_FEATURED_PREFIX}${season}`;
  const doc = ((await env.FEED_TAGS.get(key, "json")) as FeaturedLedger | null) ?? { season, featured: [] };
  const seen = new Set(doc.featured.map((f) => f.athleteId));
  for (const p of players) {
    if (p.athleteId && !seen.has(p.athleteId)) {
      doc.featured.push({ athleteId: p.athleteId, teamAbbr: p.teamAbbr, weekKey });
      seen.add(p.athleteId);
    }
  }
  await env.FEED_TAGS.put(key, JSON.stringify(doc));
  return doc.featured.length;
}

/** The 1-based ROUND number for `weekKey` this season = the count of DISTINCT weekKeys the ledger has
 *  featured, including this one. Robust to a skipped/failed cycle (it counts editions actually PUBLISHED,
 *  not elapsed weeks, so a missed Monday doesn't inflate the number). Idempotent: re-publishing the same
 *  weekKey doesn't advance it. Stamped into the pool at publish for the picker's "Round N" display. */
export async function roundNumberForWeek(env: KnowHerEnv, season: number, weekKey: string): Promise<number> {
  const doc = (await env.FEED_TAGS.get(`${KNOWHER_FEATURED_PREFIX}${season}`, "json")) as FeaturedLedger | null;
  const weeks = new Set((doc?.featured ?? []).map((f) => f.weekKey));
  weeks.add(weekKey); // include this edition even before markFeatured runs
  return weeks.size;
}

/** Remove one athleteId from the season ledger (operator fix for a mistaken feature). Returns true if it
 *  was present. */
export async function unfeature(env: KnowHerEnv, season: number, athleteId: string): Promise<boolean> {
  const key = `${KNOWHER_FEATURED_PREFIX}${season}`;
  const doc = (await env.FEED_TAGS.get(key, "json")) as FeaturedLedger | null;
  if (!doc) return false;
  const before = doc.featured.length;
  doc.featured = doc.featured.filter((f) => f.athleteId !== athleteId);
  if (doc.featured.length === before) return false;
  await env.FEED_TAGS.put(key, JSON.stringify(doc));
  return true;
}

// ── Operator admin ────────────────────────────────────────────────────────────
// GET /knowher/admin = the page (HTTP Basic gated); POST /knowher/admin/api = key-gated ops.
// Same BRACKET_ADMIN_KEY secret as the other admin routes. Manual-mode content lives here.

export interface KnowHerEnv {
  FEED_TAGS: KVNamespace;
  BRACKET_ADMIN_KEY?: string;
  /** Dedicated secret for the automated weekly /knowher/ingest POST — deliberately NOT the master
   *  BRACKET_ADMIN_KEY (the weekly Claude routine holds this key, so its blast radius is one feature
   *  and it rotates independently of every other admin surface). */
  KNOWHER_INGEST_KEY?: string;
}

const ADMIN_REALM = adminRealm("Know Her Game Admin");

export async function handleKnowHerAdmin(request: Request, env: KnowHerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!adminAuthed(request, env.BRACKET_ADMIN_KEY)) {
    return new Response("Authentication required.", { status: 401, headers: { "WWW-Authenticate": ADMIN_REALM } });
  }
  if (request.method === "GET" && url.pathname === "/knowher/admin") {
    return new Response(KNOWHER_ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed. Use POST.", { status: 405, headers: { Allow: "POST" } });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* {} */
  }
  try {
    const result = await knowHerAdminOp(env, String(body.op ?? ""), body);
    const status = (result as { error?: string }).error ? 400 : 200;
    return new Response(JSON.stringify(result), { status, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const msg = `${(e as Error).message ?? e}`;
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

/** The ONE publish path: validate → replace the live pool in KV → mark this pool's players
 *  featured-this-season (idempotent) so they drop out of future eligibility. Shared by the operator's
 *  admin `pasteContent` op AND the automated weekly `/knowher/ingest` — publishing must always run
 *  markFeatured or the once-per-season pick rotation stalls (the KV-direct load_knowher.mjs script
 *  bypasses it; never use that for weekly publishing). */
export async function publishKnowHerPool(
  env: KnowHerEnv,
  poolInput: unknown,
): Promise<{ ok: true; weekKey: string; playerCount: number; featuredThisSeason: number; note: string } | { error: string }> {
  const v = validateKnowHerPool(poolInput);
  if ("error" in v) return { error: v.error };
  // Stamp each player's numeric ESPN team id (abbr→id via the shared teams map) so the match-watcher can
  // target the team's followers for the biweekly KHG push without its own abbr→id table. Best-effort: a
  // lookup miss just leaves espnTeamId undefined (the watcher skips that team + logs), never blocks publish.
  try {
    const teams = await fetchTeamAbbrs();
    const idByAbbr = new Map(teams.map((t) => [t.abbr.toUpperCase(), String(t.id)]));
    for (const p of v.pool.players) {
      const id = idByAbbr.get(p.teamAbbreviation.toUpperCase());
      if (id) p.espnTeamId = id;
    }
  } catch {
    /* leave espnTeamId unset; the watcher fails open + diags */
  }
  // The 1-based edition index this season → the picker's "Round N". Derived from the ledger (distinct
  // published weekKeys incl. this one) so a skipped cycle doesn't inflate it.
  v.pool.round = await roundNumberForWeek(env, v.pool.season, v.pool.weekKey);
  await env.FEED_TAGS.put(KNOWHER_POOL_KEY, JSON.stringify(v.pool));
  const featuredThisSeason = await markFeatured(
    env, v.pool.season, v.pool.weekKey,
    v.pool.players.map((p) => ({ athleteId: p.espnAthleteId, teamAbbr: p.teamAbbreviation })),
  );
  return { ok: true, weekKey: v.pool.weekKey, playerCount: v.pool.players.length, featuredThisSeason, note: "Live within ~5 min (the /knowher edge cache TTL)." };
}

async function knowHerAdminOp(env: KnowHerEnv, op: string, body: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "state": {
      const mode = (await env.FEED_TAGS.get(KNOWHER_MODE_KEY)) ?? "manual";
      const pool = (await env.FEED_TAGS.get(KNOWHER_POOL_KEY, "json")) as KnowHerPool | null;
      const season = pool?.season ?? new Date().getUTCFullYear();
      const featuredThisSeason = (await readFeaturedIds(env, season)).size;
      return {
        mode,
        featuredThisSeason,
        pool: pool
          ? {
              weekKey: pool.weekKey,
              season: pool.season,
              playerCount: pool.players.length,
              players: pool.players.map((p) => ({
                team: p.teamAbbreviation,
                name: p.playerName,
                questions: p.questions.length,
              })),
            }
          : null,
      };
    }
    case "setMode": {
      const mode = body.mode === "auto" ? "auto" : "manual";
      await env.FEED_TAGS.put(KNOWHER_MODE_KEY, mode);
      return { ok: true, mode };
    }
    case "pasteContent":
      return publishKnowHerPool(env, body.pool);
    case "upsertPlayer": {
      // Merge ONE player into the existing pool (replace by team, or add) — so a single player's
      // JSON can be pasted without re-sending the whole 16-team pool. Keeps the pool's weekKey/season.
      const pool = (await env.FEED_TAGS.get(KNOWHER_POOL_KEY, "json")) as KnowHerPool | null;
      if (!pool) return { error: "No pool loaded yet — paste a full pool first, then you can update one player." };
      // Validate the player by wrapping it in the current pool frame (reuses the full validator).
      const v = validateKnowHerPool({ weekKey: pool.weekKey, season: pool.season, players: [body.player] });
      if ("error" in v) return { error: v.error };
      const player = v.pool.players[0];
      const abbr = player.teamAbbreviation.toUpperCase();
      const others = pool.players.filter((p) => p.teamAbbreviation.toUpperCase() !== abbr);
      const updated: KnowHerPool = { ...pool, players: [...others, player] };
      await env.FEED_TAGS.put(KNOWHER_POOL_KEY, JSON.stringify(updated));
      await markFeatured(env, updated.season, updated.weekKey, [{ athleteId: player.espnAthleteId, teamAbbr: abbr }]);
      return { ok: true, updatedTeam: abbr, playerName: player.playerName, questions: player.questions.length,
               playerCount: updated.players.length, note: "Live within ~5 min (the /knowher edge cache TTL)." };
    }
    case "eligible": {
      const team = String(body.team ?? "").toUpperCase();
      if (!team) return { error: "team required" };
      const year = Number(body.year) || new Date().getUTCFullYear();
      // Exclude players already featured this season so the view shows who's still pickable.
      const featured = await readFeaturedIds(env, year);
      const players = await computeEligiblePlayers(team, year, featured);
      return { team, year, count: players.length, featuredThisSeason: featured.size, players };
    }
    case "unfeature": {
      const season = Number(body.season) || new Date().getUTCFullYear();
      const athleteId = String(body.athleteId ?? "").trim();
      if (!athleteId) return { error: "athleteId required" };
      const removed = await unfeature(env, season, athleteId);
      return { ok: removed, athleteId, season, note: removed ? "Removed from the season ledger — pickable again." : "Not in the ledger." };
    }
    default:
      return { error: `unknown op "${op}"` };
  }
}

// Self-contained operator page. Basic-auth gated (browser prompt = BRACKET_ADMIN_KEY);
// the browser auto-attaches the credential to the same-origin POST calls. Functional, not pretty.
const KNOWHER_ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Know Her Game — Admin</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:16px; background:#111; color:#eee; font:14px/1.45 -apple-system,system-ui,sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:#f5a623; margin:22px 0 8px; border-bottom:1px solid #333; padding-bottom:4px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:6px 0; }
  button { background:#2a2a2e; color:#eee; border:1px solid #444; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:13px; }
  button:hover { background:#36363c; } button.go { border-color:#c8841a; color:#f5a623; }
  input, select, textarea { background:#1c1c1e; color:#eee; border:1px solid #444; border-radius:6px; padding:6px 8px; font-size:13px; font-family:inherit; }
  textarea { width:100%; min-height:220px; font:12px/1.4 ui-monospace,Menlo,monospace; }
  table { border-collapse:collapse; width:100%; margin:4px 0; } th,td { text-align:left; padding:5px 8px; border-bottom:1px solid #2a2a2a; } th { color:#999; font-size:12px; }
  #msg { margin:8px 0; padding:8px 10px; border-radius:6px; background:#1c2a1c; min-height:18px; white-space:pre-wrap; } #msg.err { background:#2a1c1c; color:#f99; }
  .card { background:#1a1a1d; border:1px solid #2c2c30; border-radius:8px; padding:10px 12px; } small { color:#888; } .muted { color:#888; }
</style>
</head>
<body>
<h1>Know Her Game — Admin</h1>
<small>Operator-only. Nothing here is user-facing.</small>
<div class="row" style="margin-top:10px"><button class="go" onclick="refresh()">Refresh</button><span id="mode" class="muted"></span></div>
<div id="msg"></div>

<h2>Current pool</h2>
<div id="state" class="card">—</div>

<h2>Mode</h2>
<div class="row">
  <button onclick="setMode('manual')">Set MANUAL (serve pasted pool)</button>
  <button onclick="setMode('auto')">Set AUTO (weekly generator — deferred)</button>
</div>

<h2>Eligible players (roster-learning: played this season, not yet featured)</h2>
<div class="row"><input id="team" placeholder="team abbr e.g. WAS" style="width:160px"><button onclick="eligible()">Look up</button></div>
<div id="elig" class="card muted">—</div>
<small class="muted">Starters (starts ≥ 1) rank first; season-tail supersubs (0 starts, minutes &gt; 0) follow. Already-featured players are excluded.</small>

<h2>Un-feature a player (fix a mistake)</h2>
<small>Removes an athleteId from this season's featured ledger so they're pickable again.</small>
<div class="row"><input id="unfeatId" placeholder="espnAthleteId e.g. 317423" style="width:200px"><button onclick="unfeature()">Un-feature</button></div>

<h2>Update ONE player</h2>
<small>Paste a SINGLE player object (with "teamAbbreviation", "espnAthleteId", … and its "questions"). Merges into the pool BY TEAM — the other players stay put. This is the quick per-player edit.</small>
<textarea id="oneplayer" placeholder='{ "teamAbbreviation": "WAS", "espnAthleteId": "317423", "playerName": "…", "jerseyNumber": 2, "position": "Forward", "tagline": "…", "questions": [ … ] }'></textarea>
<div class="row"><button class="go" onclick="saveOnePlayer()">Validate + update this player</button></div>

<h2>Replace the WHOLE pool</h2>
<small>A full pool document: { "weekKey":"2026-W27", "season":2026, "players":[ … all teams … ] }. REPLACES everything. Validated before it goes live.</small>
<textarea id="pool" placeholder='{ "weekKey": "2026-W27", "season": 2026, "players": [ ... ] }'></textarea>
<div class="row"><button class="go" onclick="save()">Validate + replace whole pool</button></div>

<script>
const msg = (t, err) => { const m = document.getElementById('msg'); m.textContent = t; m.className = err ? 'err' : ''; };
async function api(op, extra) {
  const r = await fetch('/knowher/admin/api', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ op, ...(extra||{}) }) });
  return r.json();
}
async function refresh() {
  try {
    const s = await api('state');
    document.getElementById('mode').textContent = 'mode: ' + s.mode + ' · featured this season: ' + (s.featuredThisSeason ?? 0);
    const el = document.getElementById('state');
    if (!s.pool) { el.textContent = 'No pool loaded yet.'; return; }
    let html = '<b>' + s.pool.weekKey + '</b> · season ' + s.pool.season + ' · ' + s.pool.playerCount + ' players<table><tr><th>Team</th><th>Player</th><th>Qs</th></tr>';
    for (const p of s.pool.players) html += '<tr><td>' + p.team + '</td><td>' + p.name + '</td><td>' + p.questions + '</td></tr>';
    el.innerHTML = html + '</table>';
    msg('Refreshed.');
  } catch (e) { msg(String(e), true); }
}
async function setMode(m) { try { const r = await api('setMode', { mode:m }); if (r.error) return msg(r.error, true); msg('Mode → ' + r.mode); refresh(); } catch (e) { msg(String(e), true); } }
async function eligible() {
  const team = document.getElementById('team').value.trim().toUpperCase();
  if (!team) return msg('Enter a team abbr.', true);
  msg('Looking up ' + team + '…');
  try {
    const r = await api('eligible', { team });
    if (r.error) return msg(r.error, true);
    let html = team + ' — ' + r.count + ' eligible<table><tr><th>Player</th><th>#</th><th>Pos</th><th>Starts</th><th>Min</th><th>Apps</th><th>ESPN id</th></tr>';
    for (const p of r.players) html += '<tr><td>' + p.name + '</td><td>' + (p.jersey??'') + '</td><td>' + p.position + '</td><td>' + p.starts + '</td><td>' + p.minutes + '</td><td>' + p.appearances + '</td><td>' + p.athleteId + '</td></tr>';
    document.getElementById('elig').innerHTML = html + '</table>';
    msg('Found ' + r.count + ' eligible for ' + team + '.');
  } catch (e) { msg(String(e), true); }
}
async function unfeature() {
  const athleteId = document.getElementById('unfeatId').value.trim();
  if (!athleteId) return msg('Enter an espnAthleteId.', true);
  try { const r = await api('unfeature', { athleteId }); if (r.error) return msg(r.error, true); msg(r.note + ' (' + athleteId + ')'); refresh(); }
  catch (e) { msg(String(e), true); }
}
async function saveOnePlayer() {
  let v;
  try { v = JSON.parse(document.getElementById('oneplayer').value); } catch (e) { return msg('Invalid JSON: ' + e.message, true); }
  // Accept a bare player object OR a pool doc wrapping ONE player (what the generator emits).
  let player = v;
  if (v && Array.isArray(v.players)) {
    if (v.players.length !== 1) return msg('That looks like a full pool (' + v.players.length + ' players) — use "Replace the WHOLE pool" below.', true);
    player = v.players[0];
  }
  msg('Validating…');
  try { const r = await api('upsertPlayer', { player }); if (r.error) return msg('Rejected: ' + r.error, true); msg('Updated ' + r.updatedTeam + ' (' + r.playerName + ', ' + r.questions + ' Qs). Pool now ' + r.playerCount + ' players. ' + r.note); refresh(); }
  catch (e) { msg(String(e), true); }
}
async function save() {
  let pool;
  try { pool = JSON.parse(document.getElementById('pool').value); } catch (e) { return msg('Invalid JSON: ' + e.message, true); }
  msg('Validating…');
  try { const r = await api('pasteContent', { pool }); if (r.error) return msg('Rejected: ' + r.error, true); msg('Saved ' + r.playerCount + ' players. ' + r.note); refresh(); }
  catch (e) { msg(String(e), true); }
}
refresh();
</script>
</body>
</html>`;
