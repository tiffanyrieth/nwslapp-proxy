// Bracket Battle — the engine's I/O layer. Wires the pure core (bracket.ts) to ESPN
// (player pool) and Supabase (read votes, write editions/matchups/scores/user-stats) using
// the SERVICE-ROLE key. `runBracketTick` is the whole job: called every poll cycle from
// index.ts's scheduled() and from the admin POST /bracket/run route. Idempotent.
//
// Operating mode is read from `bracket_config` EVERY tick:
//   • mode = "manual" → act ONLY on a queued `manual_action` (advance_round | close_edition
//     | start_edition | pause | resume), then clear it. The operator drives the live game
//     with a single value change in bracket_config — no deploy, no app push.
//   • mode = "auto"   → run the full lifecycle on schedule (generate after the break;
//     tally + advance when the open round closes).
// Both code paths ship together; flip between them with one SQL update of bracket_config.mode.
//
// Pools >64 run rolling-entry QUALIFYING rounds before a 64-player main bracket (see
// planStructure in bracket.ts). Live verification needs SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY as Worker secrets + the qualifying migration applied
// (supabase/migration_bracket_qualifying.sql in the app repo).

import {
  buildFirstRound,
  buildSeededRound,
  buildMergedRound,
  planStructure,
  nextCodeIn,
  isQualifying,
  isEarlyRound,
  QUAL_CODES,
  tallyMatchup,
  nextRound,
  nextRoundMatchups,
  interleaveByes,
  roundPoints,
  nextPow2,
  avoidSameTeam,
  type Entrant,
  type Matchup,
  type MatchupVotes,
} from "./bracket";
import { ADMIN_PAGE_HTML } from "./bracket-admin-page";

export interface BracketEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // Optional KV (the full Worker Env carries it) — backs NO-SILENT-FAILURES diag telemetry,
  // surfaced in the owner's GET /telemetry/recent. Best-effort; absent in pure unit contexts.
  FEED_TAGS?: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };
}

const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl";
const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/usa.nwsl";

// ── Config (bracket_config; read every tick) ───────────────────────────────────

type Mode = "manual" | "auto";
type ManualAction = "advance_round" | "close_edition" | "start_edition" | "pause" | "resume";

export interface BracketConfig {
  mode: Mode;
  season: string;
  defaultPoolSize: number;
  earlyRoundDays: number;
  lateRoundDays: number;
  breakDays: number;
  manualAction: ManualAction | null;
  themeRotation: "alternate" | "sequential";
  usedThemesThisSeason: string[];
  /// How many per-athlete ESPN stat fetches a generation may attempt (free Workers cap is
  /// 50 subrequests/invocation; default keeps the whole generation under it). Raise via
  /// bracket_config on the Workers Paid plan (1000 cap) for full-pool exact seeding.
  statFetchBudget: number;
}

async function getConfig(env: BracketEnv): Promise<BracketConfig> {
  const rows = await sbGet<{ key: string; value: unknown }[]>(env, "bracket_config?select=key,value");
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: string, d: number) => (typeof m.get(k) === "number" ? (m.get(k) as number) : d);
  const str = (k: string, d: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : d);
  const action = m.get("manual_action");
  return {
    mode: str("mode", "manual") === "auto" ? "auto" : "manual",
    season: str("season", String(new Date().getUTCFullYear())),
    defaultPoolSize: num("default_pool_size", 128),
    earlyRoundDays: num("early_round_days", 2),
    lateRoundDays: num("late_round_days", 3),
    breakDays: num("break_days", 10),
    manualAction: typeof action === "string" ? (action as ManualAction) : null,
    themeRotation: str("theme_rotation", "alternate") === "sequential" ? "sequential" : "alternate",
    usedThemesThisSeason: Array.isArray(m.get("used_themes_this_season")) ? (m.get("used_themes_this_season") as string[]) : [],
    statFetchBudget: num("stat_fetch_budget", 20),
  };
}

async function setConfigValue(env: BracketEnv, key: string, value: unknown): Promise<void> {
  await sbUpsert(env, "bracket_config", [{ key, value, updated_at: new Date().toISOString() }], "key");
}

// ── Supabase REST (service role — bypasses RLS) ───────────────────────────────

function sb(env: BracketEnv, path: string): string {
  return `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`;
}
function sbHeaders(env: BracketEnv, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}
async function sbGet<T>(env: BracketEnv, path: string): Promise<T> {
  const r = await fetch(sb(env, path), { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`Supabase GET ${path} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
async function sbInsert(env: BracketEnv, table: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const r = await fetch(sb(env, table), {
    method: "POST",
    headers: sbHeaders(env, { Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase INSERT ${table} → ${r.status} ${await r.text()}`);
}
async function sbPatch(env: BracketEnv, table: string, query: string, body: unknown): Promise<void> {
  const r = await fetch(sb(env, `${table}?${query}`), {
    method: "PATCH",
    headers: sbHeaders(env, { Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase PATCH ${table} → ${r.status} ${await r.text()}`);
}
async function sbDelete(env: BracketEnv, table: string, query: string): Promise<void> {
  const r = await fetch(sb(env, `${table}?${query}`), {
    method: "DELETE",
    headers: sbHeaders(env, { Prefer: "return=minimal" }),
  });
  if (!r.ok) throw new Error(`Supabase DELETE ${table} → ${r.status} ${await r.text()}`);
}
async function sbUpsert(env: BracketEnv, table: string, rows: unknown[], onConflict: string): Promise<void> {
  if (rows.length === 0) return;
  const r = await fetch(sb(env, `${table}?on_conflict=${onConflict}`), {
    method: "POST",
    headers: sbHeaders(env, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase UPSERT ${table} → ${r.status} ${await r.text()}`);
}

/** NO SILENT FAILURES (proxy edition): write one operational event to KV in the same shape
 *  the app's POST /telemetry sink uses, so a bracket gap surfaces in GET /telemetry/recent.
 *  Best-effort + non-PII; never throws (a diag failure must not break the tick). */
async function emitDiag(env: BracketEnv, kind: string, detail: string): Promise<void> {
  try {
    if (!env.FEED_TAGS) return;
    const record = {
      at: new Date().toISOString(),
      app: "proxy",
      os: "worker",
      events: [{ kind: kind.slice(0, 40), detail: detail.slice(0, 80), ts: Date.now() }],
    };
    const key = `diag:${1e15 - Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
    await env.FEED_TAGS.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });
  } catch {
    /* best-effort */
  }
}

// ── ESPN player pool ───────────────────────────────────────────────────────────

interface RosterPlayer { id: string; name: string; jersey: number | null; team: string; position: string; }

/** ESPN intermittently throttles datacenter (Worker) IPs — a single fetch can come back
 *  non-200 (often 429) or otherwise fail, which (pre-retry) left the bracket generator with
 *  an empty roster pool. Retry a few times with a short backoff before giving up. */
async function espnJSON<T>(url: string, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return (await r.json()) as T;
      lastErr = new Error(`${url} → ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`ESPN fetch failed: ${url}`);
}

async function fetchTeamAbbrs(): Promise<{ id: string; abbr: string }[]> {
  const json = await espnJSON<{
    sports?: { leagues?: { teams?: { team?: { id?: string; abbreviation?: string } }[] }[] }[];
  }>(`${ESPN_SITE}/teams`);
  const teams = json.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return teams
    .map((t) => ({ id: t.team?.id ?? "", abbr: (t.team?.abbreviation ?? "").toUpperCase() }))
    .filter((t) => t.id && t.abbr);
}

async function fetchRoster(teamId: string, abbr: string): Promise<RosterPlayer[]> {
  const json = await espnJSON<{
    athletes?: { id?: string; displayName?: string; jersey?: string; position?: { abbreviation?: string } }[];
  }>(`${ESPN_SITE}/teams/${teamId}/roster`);
  return (json.athletes ?? [])
    .filter((a) => a.id && a.displayName)
    .map((a) => ({
      id: a.id!,
      name: a.displayName!,
      jersey: a.jersey ? Number(a.jersey) : null,
      team: abbr,
      position: (a.position?.abbreviation ?? "").toUpperCase(),
    }));
}

const POSITION_GROUP: Record<string, "F" | "M" | "D" | "G"> = {
  F: "F", CF: "F", ST: "F", S: "F", W: "F", RW: "F", LW: "F", FW: "F",
  M: "M", CM: "M", DM: "M", AM: "M", MF: "M",
  D: "D", CB: "D", RB: "D", LB: "D", WB: "D", FB: "D",
  G: "G", GK: "G",
};

/** Every player of `group` (or all positions when null) across the 16 teams, ordered by
 *  ROUND-ROBIN INTERLEAVE across teams (each club's players spread through the list, jersey
 *  order within a team) — this is both the same-team-spreading order AND the roster-depth
 *  fallback seeding when stat data is thin. No cap (the caller ranks + caps). 17 fetches. */
async function rosterCandidates(group: "F" | "M" | "D" | "G" | null): Promise<RosterPlayer[]> {
  const teams = await fetchTeamAbbrs();
  const rosters = await Promise.all(teams.map((t) => fetchRoster(t.id, t.abbr)));
  const byTeam = rosters.map((r) =>
    r.filter((p) => group === null || POSITION_GROUP[p.position] === group)
      .sort((a, b) => (a.jersey ?? 999) - (b.jersey ?? 999)),
  );
  const ordered: RosterPlayer[] = [];
  for (let depth = 0; ; depth++) {
    let added = false;
    for (const team of byTeam) {
      const p = team[depth];
      if (p) { ordered.push(p); added = true; }
    }
    if (!added) break;
  }
  return ordered;
}

// ── Real season-stat seeding (ESPN Core API) ──────────────────────────────────
// Stats/creative editions seed by the edition's stat where the data is cheaply available:
//  • goals_assists (Best Forward) → ONE league-leaders call (top-25 each), no per-athlete.
//  • save_pct / chances_tackles / tackles_interceptions / minutes → per-athlete season
//    stats, fetched up to config.statFetchBudget candidates (the roster-depth-prioritised
//    front of the list — each club's primary players). Candidates with no stat fall to
//    roster-depth order; a diag records how much of the pool is real vs fallback. A failed
//    fetch (e.g. over the subrequest cap) just drops to fallback — never a crash.

function idFromRef(ref?: string): string | null {
  const m = ref?.match(/athletes\/(\d+)/);
  return m ? m[1] : null;
}

interface LeaderLine { goals: number; assists: number; saves: number }

/** League leaders (1 call): athleteId → {goals, assists, saves} for the season. */
async function fetchLeaders(year: number): Promise<Record<string, LeaderLine>> {
  const map: Record<string, LeaderLine> = {};
  try {
    const json = (await (await fetch(`${ESPN_CORE}/seasons/${year}/types/1/leaders`)).json()) as {
      categories?: { name?: string; leaders?: { value?: number; athlete?: { $ref?: string } }[] }[];
    };
    const want: Record<string, keyof LeaderLine> = {
      goals: "goals", goalsLeaders: "goals", assists: "assists", assistsLeaders: "assists", saves: "saves", savesLeaders: "saves",
    };
    for (const cat of json.categories ?? []) {
      const key = want[cat.name ?? ""];
      if (!key) continue;
      for (const l of cat.leaders ?? []) {
        const id = idFromRef(l.athlete?.$ref);
        if (!id) continue;
        const e = map[id] ?? { goals: 0, assists: 0, saves: 0 };
        e[key] = l.value ?? 0;
        map[id] = e;
      }
    }
  } catch { /* leaders unavailable → callers fall to roster-depth */ }
  return map;
}

/** One athlete's season stats, flattened to "category.statName" → value. */
async function fetchAthleteStats(id: string, year: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const json = (await (await fetch(`${ESPN_CORE}/seasons/${year}/types/1/athletes/${id}/statistics`)).json()) as {
    splits?: { categories?: { name?: string; stats?: { name?: string; value?: number }[] }[] };
  };
  for (const cat of json.splits?.categories ?? []) {
    for (const s of cat.stats ?? []) out[`${cat.name}.${s.name}`] = s.value ?? 0;
  }
  return out;
}

/** Fetch many athletes' stats in small concurrent batches (failures drop to undefined). */
async function fetchStatsForMany(ids: string[], year: number): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  const CONC = 8;
  for (let i = 0; i < ids.length; i += CONC) {
    const batch = ids.slice(i, i + CONC);
    const res = await Promise.all(batch.map(async (id) => {
      try { return [id, await fetchAthleteStats(id, year)] as const; } catch { return [id, null] as const; }
    }));
    for (const [id, stats] of res) if (stats) out.set(id, stats);
  }
  return out;
}

/** A comparable seeding score from the edition's stat, or null when the data's absent
 *  (→ the player falls to roster-depth order). save% is computed (the ESPN field is buggy). */
function statScore(seedingStat: string, leaders: LeaderLine | undefined, per: Record<string, number> | undefined): number | null {
  switch (seedingStat) {
    case "goals_assists": {
      if (!leaders) return null;
      const v = leaders.goals + leaders.assists;
      return v > 0 ? v : null;
    }
    case "save_pct": {
      if (!per) return null;
      const saves = per["goalKeeping.saves"] ?? 0, faced = per["goalKeeping.shotsFaced"] ?? 0;
      if (faced <= 0) return null;
      return (saves / faced) * 100 + (per["goalKeeping.cleanSheet"] ?? 0) * 0.1; // % + clean-sheet tiebreak
    }
    case "chances_tackles": {
      if (!per) return null;
      const v = (per["offensive.shotAssists"] ?? 0) + (per["defensive.effectiveTackles"] ?? 0);
      return v > 0 ? v : null;
    }
    case "tackles_interceptions": {
      if (!per) return null;
      const v = (per["defensive.totalTackles"] ?? 0) + (per["defensive.interceptions"] ?? 0);
      return v > 0 ? v : null;
    }
    case "minutes": {
      if (!per) return null;
      const v = per["general.minutes"] ?? 0;
      return v > 0 ? v : null;
    }
    default: return null;
  }
}

/** Seed an edition's pool of `cap` by the real stat where available, roster-depth tail
 *  otherwise. Emits a diag describing how much of the pool is real vs fallback. */
async function seedPool(
  env: BracketEnv, group: "F" | "M" | "D" | "G" | null, seedingStat: string, cap: number, config: BracketConfig, now: number,
): Promise<Entrant[]> {
  const year = new Date(now).getUTCFullYear();
  const candidates = await rosterCandidates(group);
  if (candidates.length === 0) return [];

  const score = new Map<string, number>();
  let attempted = candidates.length;
  if (seedingStat === "goals_assists") {
    const leaders = await fetchLeaders(year);
    for (const c of candidates) { const s = statScore(seedingStat, leaders[c.id], undefined); if (s != null) score.set(c.id, s); }
  } else {
    const budget = Math.max(0, config.statFetchBudget);
    const ids = candidates.slice(0, budget).map((c) => c.id);
    attempted = ids.length;
    const stats = await fetchStatsForMany(ids, year);
    for (const c of candidates) { const s = statScore(seedingStat, undefined, stats.get(c.id)); if (s != null) score.set(c.id, s); }
  }

  // Real-stat scores rank first (desc); everyone else keeps roster-depth order behind them.
  const scored = candidates.filter((c) => score.has(c.id)).sort((a, b) => score.get(b.id)! - score.get(a.id)!);
  const rest = candidates.filter((c) => !score.has(c.id));
  const ordered = [...scored, ...rest].slice(0, cap);

  const real = ordered.filter((c) => score.has(c.id)).length;
  if (real === 0) {
    await emitDiag(env, "bracketStatSeedHeuristic", `${group ?? "ALL"}/${seedingStat}: 0 by stat → roster-depth`);
  } else if (real < ordered.length || attempted < candidates.length) {
    await emitDiag(env, "bracketStatSeedPartial", `${group ?? "ALL"}/${seedingStat}: ${real}/${ordered.length} by stat`);
  }
  return ordered.map((p, i) => ({ id: p.id, name: p.name, jersey: p.jersey, team: p.team, seed: i + 1 }));
}

// ── Edition generation ─────────────────────────────────────────────────────────

/** Voting-window close time for a round code, or NULL in manual mode. Manual mode means the
 *  operator advances rounds by hand, so the round stays open indefinitely — writing no deadline
 *  keeps votes flowing (the app reads null as "Voting open") instead of auto-closing after a
 *  couple of days. Auto mode uses the config early/late day windows. Exported for unit tests. */
export function roundCloseISO(code: number, now: number, config: BracketConfig): string | null {
  if (config.mode === "manual") return null;
  const days = isEarlyRound(code) ? config.earlyRoundDays : config.lateRoundDays;
  return new Date(now + days * 24 * 3600 * 1000).toISOString();
}

async function writeEdition(
  env: BracketEnv,
  ed: { id: string; themeLabel: string; title: string; type: "statsSeeded" | "creative" },
  entrants: Entrant[],
  config: BracketConfig,
  now: number,
  editionOrder: number,
): Promise<string> {
  const structure = planStructure(entrants.length);
  // Trim to the supported bracket size (the lowest seeds drop when a pool exceeds 192).
  const used = entrants.filter((e) => e.seed <= structure.size).sort((a, b) => a.seed - b.seed);
  if (used.length < entrants.length) {
    await emitDiag(env, "bracketPoolTrimmed", `${ed.id} ${entrants.length}→${used.length}`);
  }

  let firstRound: number;
  let matchups: Matchup[];
  if (structure.qualifyingCount > 0) {
    const q1 = new Set(structure.entrySeeds[QUAL_CODES[0]]);
    matchups = buildSeededRound(used.filter((e) => q1.has(e.seed)), QUAL_CODES[0]).matchups;
    firstRound = QUAL_CODES[0];
  } else {
    matchups = buildFirstRound(used).matchups;
    firstRound = matchups[0]?.round ?? nextPow2(Math.max(used.length, 2));
  }
  if (matchups.length === 0) {
    await emitDiag(env, "bracketGenEmpty", `${ed.id} produced 0 matchups`);
    return `skipped: ${ed.id} produced no matchups`;
  }

  await sbInsert(env, "bracket_editions", [{
    id: ed.id, theme_label: ed.themeLabel, title: ed.title, emoji: "", type: ed.type,
    current_round: firstRound, round_opened_at: new Date(now).toISOString(),
    round_closes_at: roundCloseISO(firstRound, now, config), is_active: true, fan_count: 0,
    mode: config.mode, edition_order: editionOrder, pool_size: structure.size,
    total_rounds: structure.rounds.length, started_at: new Date(now).toISOString(),
  }]);
  await sbInsert(env, "bracket_entrants", used.map((e) => ({
    edition_id: ed.id, entrant_id: e.id, seed: e.seed, player_name: e.name,
    jersey_number: e.jersey, team_abbreviation: e.team,
  })));
  await sbInsert(env, "bracket_matchups", matchups.map((m) => ({
    id: `${ed.id}-r${m.round}-s${m.slot}`, edition_id: ed.id, round: m.round, slot: m.slot,
    entrant_a_id: m.aId, entrant_b_id: m.bId, points: m.points,
  })));
  return `generated ${ed.type} edition ${ed.id} (${used.length} entrants, ${structure.qualifyingCount} qualifying rounds, ${matchups.length} round-1 matchups)`;
}

/** Pick + generate the next edition from the owner-curated libraries. Alternates
 *  creative ↔ stats (config.themeRotation), skipping themes used this season. Creative is
 *  the soul; it leads when one is ready and the rotation calls for it. */
async function generateNext(env: BracketEnv, config: BracketConfig, now: number): Promise<string> {
  // Alternate off the MOST RECENT edition's type — robust to a pre-existing/old edition or a
  // failed generation. Parity on the total edition count is NOT: a stray stats edition (e.g. the
  // old engine's `top-forward-…`) flips it the wrong way, so "previous was stats" wrongly picked
  // stats again. With no history, lead with creative (the soul / recommended first drop).
  const editions = await sbGet<{ type: string }[]>(env, "bracket_editions?select=type&order=created_at.desc");
  const order = editions.length + 1;
  const used = new Set(config.usedThemesThisSeason);
  const wantCreative = config.themeRotation === "sequential" ? true : editions[0]?.type !== "creative";

  const pickCreative = async (): Promise<string | null> => {
    const rows = await sbGet<{ id: string; theme_label: string; title: string }[]>(
      env, "bracket_creative_editions?status=eq.ready&select=id,theme_label,title&order=created_at.asc&limit=10");
    const row = rows.find((r) => !used.has(r.id));
    if (!row) return null;
    // Creative editions are theme-only: the player pool comes from ESPN rosters (the WHOLE
    // league — all positions — seeded by minutes played, a visibility proxy for who the
    // crowd can form an opinion on). Only the theme label differs; cards show name/jersey/team.
    const pool = await seedPool(env, null, "minutes", config.defaultPoolSize, config, now);
    if (pool.length < 8) { await emitDiag(env, "bracketCreativeThin", `${row.id} pool ${pool.length}`); return null; }
    const msg = await writeEdition(env, { id: row.id, themeLabel: row.theme_label, title: row.title, type: "creative" }, pool, config, now, order);
    await sbPatch(env, "bracket_creative_editions", `id=eq.${encodeURIComponent(row.id)}`, { status: "used" });
    await markThemeUsed(env, config, row.id);
    return msg;
  };

  const pickStats = async (): Promise<string | null> => {
    const rows = await sbGet<{ id: string; theme_label: string; title: string; position_filter: string | null; seeding_stat: string }[]>(
      env, "bracket_stats_editions?status=eq.ready&select=id,theme_label,title,position_filter,seeding_stat&order=created_at.asc&limit=10");
    const row = rows.find((r) => !used.has(r.id));
    if (!row) return null;
    const group = (row.position_filter as "F" | "M" | "D" | "G" | null) ?? null;
    const pool = await seedPool(env, group, row.seeding_stat, config.defaultPoolSize, config, now);
    if (pool.length < 8) { await emitDiag(env, "bracketStatsThin", `${row.id} pool ${pool.length}`); return null; }
    const msg = await writeEdition(env, { id: `${row.id}`, themeLabel: row.theme_label, title: row.title, type: "statsSeeded" }, pool, config, now, order);
    await sbPatch(env, "bracket_stats_editions", `id=eq.${encodeURIComponent(row.id)}`, { status: "used" });
    await markThemeUsed(env, config, row.id);
    return msg;
  };

  // Try the preferred type, then fall back to the other so a one-sided library still runs.
  const first = wantCreative ? pickCreative : pickStats;
  const second = wantCreative ? pickStats : pickCreative;
  const msg = (await first()) ?? (await second());
  if (msg) return msg;
  await emitDiag(env, "bracketNoThemeReady", `season ${config.season}`);
  return "idle: no ready edition in either library";
}

async function markThemeUsed(env: BracketEnv, config: BracketConfig, id: string): Promise<void> {
  const next = Array.from(new Set([...config.usedThemesThisSeason, id]));
  await setConfigValue(env, "used_themes_this_season", next);
}

/** Delete every row of a prior edition (children first, then the edition) so a same-id
 *  re-run starts truly fresh — `writeEdition` keys on the theme id, so a completed edition
 *  under that id would otherwise collide and old votes/scores would pollute the new run.
 *  No-op when nothing exists. Emits a diag (this is destructive). */
async function purgeEdition(env: BracketEnv, id: string): Promise<void> {
  const enc = encodeURIComponent(id);
  const existing = await sbGet<{ id: string }[]>(env, `bracket_editions?id=eq.${enc}&select=id&limit=1`);
  if (!existing[0]) return;
  const byEd = `edition_id=eq.${enc}`;
  await sbDelete(env, "bracket_votes", byEd);
  await sbDelete(env, "bracket_scores", byEd);
  await sbDelete(env, "bracket_user_edition_stats", byEd);
  await sbDelete(env, "bracket_matchups", byEd);
  await sbDelete(env, "bracket_entrants", byEd);
  await sbDelete(env, "bracket_editions", `id=eq.${enc}`);
  await emitDiag(env, "bracketEditionPurged", `${id} (re-run via targeted start)`);
}

/** Start a SPECIFIC theme by id — the `start_edition:<themeId>` manual action. Unlike
 *  `generateNext` it ignores rotation AND the used-this-season list, and PURGES any prior
 *  edition under the same id first (so re-running a completed theme starts fresh). Looks the
 *  theme up in the creative library, then the stats library; mirrors generateNext's seeding. */
async function generateTheme(env: BracketEnv, config: BracketConfig, now: number, themeId: string): Promise<string> {
  const enc = encodeURIComponent(themeId);
  const order = (await sbGet<{ id: string }[]>(env, "bracket_editions?select=id")).length + 1;

  // Seed BEFORE purging: a thin/failed pool (e.g. ESPN throttling the Worker) must NOT
  // destroy the existing edition. Purge only once we have a viable pool to replace it with.
  const creative = await sbGet<{ id: string; theme_label: string; title: string }[]>(
    env, `bracket_creative_editions?id=eq.${enc}&select=id,theme_label,title&limit=1`);
  if (creative[0]) {
    const pool = await seedPool(env, null, "minutes", config.defaultPoolSize, config, now);
    if (pool.length < 8) { await emitDiag(env, "bracketCreativeThin", `${themeId} pool ${pool.length}`); return `manual start: ${themeId} pool too thin (${pool.length}) — old edition left intact, retry`; }
    await purgeEdition(env, themeId);
    const msg = await writeEdition(env, { id: creative[0].id, themeLabel: creative[0].theme_label, title: creative[0].title, type: "creative" }, pool, config, now, order);
    await sbPatch(env, "bracket_creative_editions", `id=eq.${enc}`, { status: "used" });
    await markThemeUsed(env, config, themeId);
    return `manual start (targeted): ${msg}`;
  }

  const stats = await sbGet<{ id: string; theme_label: string; title: string; position_filter: string | null; seeding_stat: string }[]>(
    env, `bracket_stats_editions?id=eq.${enc}&select=id,theme_label,title,position_filter,seeding_stat&limit=1`);
  if (stats[0]) {
    const group = (stats[0].position_filter as "F" | "M" | "D" | "G" | null) ?? null;
    const pool = await seedPool(env, group, stats[0].seeding_stat, config.defaultPoolSize, config, now);
    if (pool.length < 8) { await emitDiag(env, "bracketStatsThin", `${themeId} pool ${pool.length}`); return `manual start: ${themeId} pool too thin (${pool.length}) — old edition left intact, retry`; }
    await purgeEdition(env, themeId);
    const msg = await writeEdition(env, { id: stats[0].id, themeLabel: stats[0].theme_label, title: stats[0].title, type: "statsSeeded" }, pool, config, now, order);
    await sbPatch(env, "bracket_stats_editions", `id=eq.${enc}`, { status: "used" });
    await markThemeUsed(env, config, themeId);
    return `manual start (targeted): ${msg}`;
  }

  await emitDiag(env, "bracketManualThemeNotFound", themeId);
  return `manual start: theme "${themeId}" not found in either library`;
}

// ── The tick ──────────────────────────────────────────────────────────────────

interface EditionRow { id: string; current_round: number; round_closes_at: string | null; is_active: boolean; pool_size: number | null; mode: "manual" | "auto" | null; }

async function getActiveEdition(env: BracketEnv): Promise<EditionRow | null> {
  const rows = await sbGet<EditionRow[]>(
    env, "bracket_editions?is_active=eq.true&select=id,current_round,round_closes_at,is_active,pool_size,mode&limit=1");
  return rows[0] ?? null;
}

/** Force the active edition's open round to close NOW so the next tick tallies it.
 *  Verification only (the cron/operator closes rounds on schedule). */
export async function forceCloseActiveRound(env: BracketEnv): Promise<string> {
  const active = await getActiveEdition(env);
  if (!active) return "no active edition to close";
  await sbPatch(env, "bracket_editions", `id=eq.${active.id}`,
    { round_closes_at: new Date(Date.now() - 60_000).toISOString() });
  return `forced close on ${active.id} round ${active.current_round}`;
}

export async function runBracketTick(env: BracketEnv, now: number = Date.now()): Promise<string> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return "skipped: Supabase secrets not set";
  }
  // Guard a swapped/misconfigured secret WITHOUT echoing its value into thrown URLs/stacks.
  if (!env.SUPABASE_URL.startsWith("https://") || !env.SUPABASE_URL.includes(".supabase.co")) {
    return "config error: SUPABASE_URL is not a https://<project>.supabase.co URL — it looks swapped with the service-role key. Re-set both secrets.";
  }
  const config = await getConfig(env);
  const active = await getActiveEdition(env);
  return config.mode === "manual"
    ? await handleManual(env, config, active, now)
    : await handleAuto(env, config, active, now);
}

/** Manual mode: CONSUME the queued operator action (exactly once), then act on it. */
async function handleManual(env: BracketEnv, config: BracketConfig, active: EditionRow | null, now: number): Promise<string> {
  const action = config.manualAction;
  if (!action) return "manual: idle (no pending action)";

  // Consume FIRST, before acting — so a terminal or failing action can't re-fire on every
  // 5-min tick (the original bug: an `advance_round` that never cleared marched an edition to
  // completion). Clear by DELETING the row: `bracket_config.value` is `jsonb NOT NULL`, so the
  // old `setConfigValue(…, null)` sent SQL NULL, the upsert threw, and the action stuck. A
  // missing `manual_action` key reads back as no action in getConfig.
  await sbDelete(env, "bracket_config", "key=eq.manual_action");
  return executeManualAction(env, action, active, now, config);
}

/** Execute ONE operator action immediately, INDEPENDENT of mode/cron. Shared by handleManual
 *  (which consumes the queued action from bracket_config first) and the admin panel (which
 *  calls it directly, so a button acts instantly regardless of mode). Pure dispatch — no queue
 *  read/clear here. `start_edition` (bare = next rotation pick) / `start_edition:<themeId>`
 *  (that exact theme) are handled before the switch since the targeted form carries a suffix. */
export async function executeManualAction(
  env: BracketEnv, action: string, active: EditionRow | null, now: number, config: BracketConfig,
): Promise<string> {
  if (action === "start_edition" || action.startsWith("start_edition:")) {
    if (active) return `manual start: edition ${active.id} already active`;
    const themeId = startEditionThemeId(action);
    return themeId ? await generateTheme(env, config, now, themeId) : await generateNext(env, config, now);
  }

  switch (action) {
    case "advance_round":
      return active ? await tallyAndAdvance(env, active, now, config, false) : "manual advance: no active edition";
    case "close_edition":
      return active ? await tallyAndAdvance(env, active, now, config, true) : "manual close: no active edition";
    case "pause":
      if (active) await sbPatch(env, "bracket_editions", `id=eq.${active.id}`, { round_closes_at: null });
      return active ? `manual: round paused on ${active.id}` : "manual pause: no active edition";
    case "resume":
      if (active) {
        await sbPatch(env, "bracket_editions", `id=eq.${active.id}`, {
          round_opened_at: new Date(now).toISOString(),
          round_closes_at: roundCloseISO(active.current_round, now, config),
        });
      }
      return active ? `manual: round resumed on ${active.id}` : "manual resume: no active edition";
    default:
      await emitDiag(env, "bracketUnknownAction", String(action));
      return `manual: unknown action "${action}"`;
  }
}

/** Parse a `start_edition` action: `start_edition:<themeId>` → the themeId; bare
 *  `start_edition` → null (rotation pick). Exported for unit tests. */
export function startEditionThemeId(action: string): string | null {
  const m = /^start_edition:(.+)$/.exec(action);
  const id = m ? m[1].trim() : "";
  return id.length ? id : null;
}

/** Auto mode: generate after the break, tally + advance when the open round closes. */
async function handleAuto(env: BracketEnv, config: BracketConfig, active: EditionRow | null, now: number): Promise<string> {
  if (!active) {
    const last = await sbGet<{ created_at: string }[]>(env, "bracket_editions?select=created_at&order=created_at.desc&limit=1");
    if (last.length && now - new Date(last[0].created_at).getTime() < config.breakDays * 24 * 3600 * 1000) {
      return "auto: in the break between editions";
    }
    return await generateNext(env, config, now);
  }
  // Defense-in-depth: a manual-mode edition is NEVER auto-advanced, even if the global config
  // is somehow 'auto'. Only an explicit manual_action (handleManual) may step it.
  if (active.mode === "manual") {
    return `auto: skipped — edition ${active.id} is in manual mode`;
  }
  if (active.round_closes_at && new Date(active.round_closes_at).getTime() <= now) {
    return await tallyAndAdvance(env, active, now, config, false);
  }
  return "auto: current round still open";
}

interface MatchupRow { id: string; slot: number; entrant_a_id: string; entrant_b_id: string; points: number; }
interface VoteRow { matchup_id: string; entrant_id: string; user_id: string; }
interface EntrantRow { entrant_id: string; seed: number; team_abbreviation: string; }

/** Close the open round: tally real votes, set winners + splits + counts, score every voter
 *  (points + accuracy backing), then open the next round — or finish the edition (or finish
 *  now when `forceFinish`, the manual close_edition path). */
async function tallyAndAdvance(env: BracketEnv, ed: EditionRow, now: number, config: BracketConfig, forceFinish: boolean): Promise<string> {
  const round = ed.current_round;
  const matchups = await sbGet<MatchupRow[]>(
    env, `bracket_matchups?edition_id=eq.${ed.id}&round=eq.${round}&select=id,slot,entrant_a_id,entrant_b_id,points`);
  const votes = await sbGet<VoteRow[]>(
    env, `bracket_votes?edition_id=eq.${ed.id}&round=eq.${round}&select=matchup_id,entrant_id,user_id`);
  const entrantRows = await sbGet<EntrantRow[]>(
    env, `bracket_entrants?edition_id=eq.${ed.id}&select=entrant_id,seed,team_abbreviation`);
  const seedOf = new Map(entrantRows.map((e) => [e.entrant_id, e.seed]));
  const teamOf = new Map(entrantRows.map((e) => [e.entrant_id, e.team_abbreviation]));

  if (matchups.length === 0) {
    await emitDiag(env, "bracketTallyNoMatchups", `${ed.id} round ${round}`);
    return `error: ${ed.id} round ${round} has no matchups to tally`;
  }

  // Per-matchup vote counts.
  const counts = new Map<string, Map<string, number>>();
  for (const v of votes) {
    const m = counts.get(v.matchup_id) ?? new Map<string, number>();
    m.set(v.entrant_id, (m.get(v.entrant_id) ?? 0) + 1);
    counts.set(v.matchup_id, m);
  }

  const winners: string[] = [];
  for (const m of matchups.sort((a, b) => a.slot - b.slot)) {
    const c = counts.get(m.id) ?? new Map();
    const mv: MatchupVotes = {
      slot: m.slot, aId: m.entrant_a_id, bId: m.entrant_b_id,
      aVotes: c.get(m.entrant_a_id) ?? 0, bVotes: c.get(m.entrant_b_id) ?? 0,
      seedA: seedOf.get(m.entrant_a_id) ?? 999, seedB: seedOf.get(m.entrant_b_id) ?? 999,
    };
    const res = tallyMatchup(mv);
    winners.push(res.winnerId);
    await sbPatch(env, "bracket_matchups", `id=eq.${encodeURIComponent(m.id)}`, {
      community_winner_id: res.winnerId, split_a_percent: res.splitAPercent, vote_count: res.voteCount,
    });
  }

  // Score every voter: correct picks × round points (+ per-edition accuracy backing).
  const winnerByMatchup = new Map(matchups.map((m, i) => [m.id, winners[i]]));
  const pts = roundPoints(round);
  const perUserPts = new Map<string, number>();
  const perUserCorrect = new Map<string, number>();
  const perUserTotal = new Map<string, number>();
  const picksByUser = new Map<string, Map<string, string>>(); // user → (matchup → pick)
  for (const v of votes) {
    perUserTotal.set(v.user_id, (perUserTotal.get(v.user_id) ?? 0) + 1);
    if (winnerByMatchup.get(v.matchup_id) === v.entrant_id) {
      perUserPts.set(v.user_id, (perUserPts.get(v.user_id) ?? 0) + pts);
      perUserCorrect.set(v.user_id, (perUserCorrect.get(v.user_id) ?? 0) + 1);
    }
    let pm = picksByUser.get(v.user_id);
    if (!pm) { pm = new Map(); picksByUser.set(v.user_id, pm); }
    pm.set(v.matchup_id, v.entrant_id);
  }
  // Each user's correctness IN SLOT ORDER this round → the streak fold (carried across
  // rounds in the DB; current resets on a miss, longest is the per-edition best).
  const seqByUser = new Map<string, boolean[]>();
  for (const [uid, picks] of picksByUser) {
    const seq: boolean[] = [];
    for (const m of matchups) {                       // matchups is slot-sorted above
      const pick = picks.get(m.id);
      if (pick !== undefined) seq.push(winnerByMatchup.get(m.id) === pick);
    }
    seqByUser.set(uid, seq);
  }
  await accumulateScores(env, ed.id, perUserPts, now);
  await accumulateUserStats(env, ed.id, round, perUserCorrect, perUserTotal, seqByUser, now);
  await sbPatch(env, "bracket_editions", `id=eq.${ed.id}`, { fan_count: new Set(votes.map((v) => v.user_id)).size });

  // Advance — or finish.
  const finish = async (reason: string): Promise<string> => {
    await sbPatch(env, "bracket_editions", `id=eq.${ed.id}`, { is_active: false, round_closes_at: null, completed_at: new Date(now).toISOString() });
    return `edition ${ed.id} complete — ${reason}`;
  };
  if (forceFinish) return await finish("closed by operator");

  const poolSize = ed.pool_size ?? 0;
  if (poolSize > 64) {
    // Qualifying / large-pool path: structure-driven next round + rolling entry.
    const structure = planStructure(poolSize);
    const nextCode = nextCodeIn(structure, round);
    if (nextCode === null) return await finish("champion crowned");
    const newSeeds = new Set(structure.entrySeeds[nextCode] ?? []);
    const newEntrants: Entrant[] = entrantRows
      .filter((e) => newSeeds.has(e.seed))
      .map((e) => ({ id: e.entrant_id, name: "", jersey: null, team: e.team_abbreviation, seed: e.seed }));
    const next = buildMergedRound(winners, newEntrants, nextCode);
    // Same-team protection through qualifying + Round of 64 + Round of 32.
    if (isQualifying(nextCode) || nextCode >= 32) {
      avoidSameTeam(next, entrantRows.map((e) => ({ id: e.entrant_id, name: "", jersey: null, team: e.team_abbreviation, seed: e.seed })));
    }
    return await writeNextRound(env, ed.id, next, nextCode, now, config, round, matchups.length);
  }

  // Classic ≤64 path (unchanged behavior): nextRound + round-1 byes interleave.
  const nr = nextRound(round);
  if (nr === null) return await finish("champion crowned");
  let advancing = winners;
  if (winners.length < nr) {
    const inMatchups = new Set(matchups.flatMap((m) => [m.entrant_a_id, m.entrant_b_id]));
    const byes = entrantRows.filter((e) => !inMatchups.has(e.entrant_id)).sort((a, b) => a.seed - b.seed).map((e) => e.entrant_id);
    advancing = interleaveByes(winners, byes);
  }
  const next = nextRoundMatchups(advancing, nr);
  return await writeNextRound(env, ed.id, next, nr, now, config, round, matchups.length);
}

/** Persist a freshly-built next round + advance the edition's pointer. Shared by both paths. */
async function writeNextRound(
  env: BracketEnv, editionId: string, next: Matchup[], nextCode: number,
  now: number, config: BracketConfig, fromRound: number, fromCount: number,
): Promise<string> {
  if (next.length === 0) {
    await emitDiag(env, "bracketAdvanceEmpty", `${editionId} ${fromRound}→${nextCode}`);
    return `error: ${editionId} round ${fromRound} produced no next-round matchups`;
  }
  await sbInsert(env, "bracket_matchups", next.map((m) => ({
    id: `${editionId}-r${m.round}-s${m.slot}`, edition_id: editionId, round: m.round, slot: m.slot,
    entrant_a_id: m.aId, entrant_b_id: m.bId, points: m.points,
  })));
  await sbPatch(env, "bracket_editions", `id=eq.${editionId}`, {
    current_round: nextCode, round_opened_at: new Date(now).toISOString(),
    round_closes_at: roundCloseISO(nextCode, now, config),
  });
  return `tallied round ${fromRound} (${fromCount} matchups) → opened round ${nextCode}`;
}

/** Add this round's points onto each voter's per-edition score (PostgREST has no atomic +). */
async function accumulateScores(env: BracketEnv, editionId: string, perUserPts: Map<string, number>, now: number): Promise<void> {
  if (perUserPts.size === 0) return;
  const existing = await sbGet<{ user_id: string; points: number }[]>(
    env, `bracket_scores?edition_id=eq.${editionId}&select=user_id,points`);
  const base = new Map(existing.map((s) => [s.user_id, s.points]));
  const rows = [...perUserPts.entries()].map(([user_id, add]) => ({
    user_id, edition_id: editionId, points: (base.get(user_id) ?? 0) + add, updated_at: new Date(now).toISOString(),
  }));
  await sbUpsert(env, "bracket_scores", rows, "user_id,edition_id");
}

/** Accumulate per-edition backing for the Leaderboard "Your Stats" tab: cumulative
 *  correct/total picks, the user's best single round (by accuracy), and the consecutive-
 *  correct streak (current carried across rounds + resets on a miss; longest = the
 *  per-edition best). Service-role write. */
async function accumulateUserStats(
  env: BracketEnv, editionId: string, round: number,
  perUserCorrect: Map<string, number>, perUserTotal: Map<string, number>,
  seqByUser: Map<string, boolean[]>, now: number,
): Promise<void> {
  if (perUserTotal.size === 0) return;
  interface StatRow { user_id: string; correct_picks: number; total_picks: number; best_round: number | null; best_round_correct: number; best_round_total: number; current_streak: number; longest_streak: number; }
  const existing = await sbGet<StatRow[]>(
    env, `bracket_user_edition_stats?edition_id=eq.${editionId}&select=user_id,correct_picks,total_picks,best_round,best_round_correct,best_round_total,current_streak,longest_streak`);
  const prevById = new Map(existing.map((s) => [s.user_id, s]));
  const rows = [...perUserTotal.keys()].map((uid) => {
    const prev = prevById.get(uid);
    const rc = perUserCorrect.get(uid) ?? 0;
    const rt = perUserTotal.get(uid) ?? 0;
    let best_round = prev?.best_round ?? null;
    let brc = prev?.best_round_correct ?? 0;
    let brt = prev?.best_round_total ?? 0;
    if (rt > 0) {
      const thisAcc = rc / rt;
      const bestAcc = brt > 0 ? brc / brt : -1;
      if (thisAcc > bestAcc) { best_round = round; brc = rc; brt = rt; }
    }
    // Fold this round's picks (slot order) onto the carried current streak.
    let current = prev?.current_streak ?? 0;
    let longest = prev?.longest_streak ?? 0;
    for (const correct of seqByUser.get(uid) ?? []) {
      current = correct ? current + 1 : 0;
      if (current > longest) longest = current;
    }
    return {
      user_id: uid, edition_id: editionId,
      correct_picks: (prev?.correct_picks ?? 0) + rc,
      total_picks: (prev?.total_picks ?? 0) + rt,
      best_round, best_round_correct: brc, best_round_total: brt,
      current_streak: current, longest_streak: longest,
      updated_at: new Date(now).toISOString(),
    };
  });
  await sbUpsert(env, "bracket_user_edition_stats", rows, "user_id,edition_id");
}

// ── Admin panel (operator-only) ─────────────────────────────────────────────────
// Both the page (GET /bracket/admin) AND the control API (POST /bracket/admin/api) are
// gated by BRACKET_ADMIN_KEY. The page uses HTTP Basic auth (the browser's native password
// prompt — username ignored, password = the key) so a plain GET navigation can authenticate
// without a custom header; once authed, the browser auto-attaches the same Authorization to
// the page's same-origin fetch() calls. The API also still accepts the `x-admin-key` header
// so curl/scripts (and /bracket/run et al.) are unaffected. Reuses the engine's private
// helpers so all Supabase logic stays in one place.

type AdminEnv = BracketEnv & { BRACKET_ADMIN_KEY?: string };

const ADMIN_REALM = 'Basic realm="Bracket Admin", charset="UTF-8"';

/** True when the request carries the admin key — either as HTTP Basic auth (password = key,
 *  username ignored) or the `x-admin-key` header. False if no key is configured. */
function adminAuthed(request: Request, key: string | undefined): boolean {
  if (!key) return false;
  if (request.headers.get("x-admin-key") === key) return true;
  const m = /^Basic\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!m) return false;
  let decoded = "";
  try { decoded = atob(m[1].trim()); } catch { return false; }
  return decoded.slice(decoded.indexOf(":") + 1) === key; // "user:pass" → compare pass
}

/** Slug a theme title into an id segment (e.g. "Best Celebration" → "best-celebration"). */
export function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function handleBracketAdmin(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  // 401 + WWW-Authenticate triggers the browser's native password dialog (and re-prompts on a
  // stale credential) — for both the page navigation and any unauthenticated API call.
  if (!adminAuthed(request, env.BRACKET_ADMIN_KEY)) {
    return new Response("Authentication required.", { status: 401, headers: { "WWW-Authenticate": ADMIN_REALM } });
  }
  if (request.method === "GET" && url.pathname === "/bracket/admin") {
    return new Response(ADMIN_PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed. Use POST.", { status: 405, headers: { Allow: "POST" } });
  }
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* {} */ }
  try {
    const result = await bracketAdminOp(env, String(body.op ?? ""), body);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const err = e as Error;
    const safe = `${err.message ?? err}`.replace(/sb_secret_[A-Za-z0-9_]+|sb_publishable_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_.\-]+/g, "[redacted]");
    return new Response(JSON.stringify({ error: safe }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

function libTable(kind: unknown): string {
  return kind === "stats" ? "bracket_stats_editions" : "bracket_creative_editions";
}

async function bracketAdminOp(env: AdminEnv, op: string, body: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "state":
      return adminState(env);
    case "setMode":
      await setConfigValue(env, "mode", body.mode === "auto" ? "auto" : "manual");
      return { ok: true };
    case "action": {
      const config = await getConfig(env);
      const active = await getActiveEdition(env);
      const message = await executeManualAction(env, String(body.action ?? ""), active, Date.now(), config);
      return { ok: true, message };
    }
    case "themeAdd": {
      const title = String(body.title ?? "").trim();
      if (!title) return { error: "title required" };
      const season = Number((await getConfig(env)).season) || new Date().getUTCFullYear();
      const id = `${slug(title)}-${season}`;
      await sbInsert(env, "bracket_creative_editions", [{
        id, theme_label: title.toUpperCase(), title, description: "", status: "ready", season,
      }]);
      return { ok: true, id };
    }
    case "themeEditTitle": {
      const title = String(body.title ?? "").trim();
      if (!title) return { error: "title required" };
      await sbPatch(env, libTable(body.kind), `id=eq.${encodeURIComponent(String(body.id))}`, { title, theme_label: title.toUpperCase() });
      return { ok: true };
    }
    case "themeStatus": {
      const status = ["ready", "parked", "used"].includes(String(body.status)) ? String(body.status) : "ready";
      await sbPatch(env, libTable(body.kind), `id=eq.${encodeURIComponent(String(body.id))}`, { status });
      return { ok: true };
    }
    case "themeDelete":
      await sbDelete(env, libTable(body.kind), `id=eq.${encodeURIComponent(String(body.id))}`);
      return { ok: true };
    case "clearUsedThemes":
      await setConfigValue(env, "used_themes_this_season", []);
      return { ok: true };
    default:
      return { error: `unknown op "${op}"` };
  }
}

/** What `generateNext` WOULD pick next (rotation creative↔stats + creation order, skipping
 *  used + non-ready) — computed read-only, without generating. */
async function nextRotationPick(env: BracketEnv, config: BracketConfig): Promise<{ id: string; title: string; type: string } | null> {
  const editions = await sbGet<{ type: string }[]>(env, "bracket_editions?select=type&order=created_at.desc&limit=1");
  const wantCreative = config.themeRotation === "sequential" ? true : editions[0]?.type !== "creative";
  const used = new Set(config.usedThemesThisSeason);
  const creative = (await sbGet<{ id: string; title: string }[]>(env, "bracket_creative_editions?status=eq.ready&select=id,title&order=created_at.asc")).find((r) => !used.has(r.id));
  const stats = (await sbGet<{ id: string; title: string }[]>(env, "bracket_stats_editions?status=eq.ready&select=id,title&order=created_at.asc")).find((r) => !used.has(r.id));
  if (wantCreative) {
    if (creative) return { ...creative, type: "creative" };
    if (stats) return { ...stats, type: "statsSeeded" };
  } else {
    if (stats) return { ...stats, type: "statsSeeded" };
    if (creative) return { ...creative, type: "creative" };
  }
  return null;
}

async function adminState(env: BracketEnv): Promise<unknown> {
  const config = await getConfig(env);
  const activeRows = await sbGet<Record<string, unknown>[]>(
    env, "bracket_editions?is_active=eq.true&select=id,title,type,current_round,total_rounds,round_opened_at,round_closes_at,is_active,pool_size,mode&limit=1");
  const active = activeRows[0] ?? null;
  let activeOut: Record<string, unknown> | null = null;
  if (active) {
    const votes = await sbGet<{ user_id: string }[]>(
      env, `bracket_votes?edition_id=eq.${encodeURIComponent(String(active.id))}&round=eq.${active.current_round}&select=user_id`);
    activeOut = { ...active, thisRoundVotes: votes.length };
  }
  const creative = await sbGet<unknown[]>(env, "bracket_creative_editions?select=id,title,theme_label,status,created_at&order=created_at.asc");
  const stats = await sbGet<unknown[]>(env, "bracket_stats_editions?select=id,title,theme_label,status,position_filter,seeding_stat,created_at&order=created_at.asc");
  const nextPick = await nextRotationPick(env, config);
  const history = await adminHistory(env);
  return {
    config: {
      mode: config.mode, season: config.season, themeRotation: config.themeRotation,
      usedThemes: config.usedThemesThisSeason, manualAction: config.manualAction,
      defaultPoolSize: config.defaultPoolSize,
    },
    active: activeOut, nextPick, creative, stats, history,
  };
}

/** Completed editions (newest first, capped). Winner = the championship (round 2) matchup's
 *  community winner → entrant name; "—" if the edition was closed before a champion. Total
 *  votes counted from bracket_votes (fine at operator scale; capped to recent editions). */
async function adminHistory(env: BracketEnv): Promise<unknown[]> {
  const eds = await sbGet<Record<string, unknown>[]>(
    env, "bracket_editions?is_active=eq.false&select=id,title,type,total_rounds,current_round,created_at,completed_at&order=created_at.desc&limit=25");
  const out: unknown[] = [];
  for (const e of eds) {
    const enc = encodeURIComponent(String(e.id));
    const votes = await sbGet<{ user_id: string }[]>(env, `bracket_votes?edition_id=eq.${enc}&select=user_id`);
    const finals = await sbGet<{ community_winner_id: string | null }[]>(
      env, `bracket_matchups?edition_id=eq.${enc}&round=eq.2&select=community_winner_id&limit=1`);
    let winner: string | null = null;
    const winnerId = finals[0]?.community_winner_id ?? null;
    if (winnerId) {
      const ent = await sbGet<{ player_name: string }[]>(
        env, `bracket_entrants?edition_id=eq.${enc}&entrant_id=eq.${encodeURIComponent(winnerId)}&select=player_name&limit=1`);
      winner = ent[0]?.player_name ?? winnerId;
    }
    out.push({ ...e, totalVotes: votes.length, winner });
  }
  return out;
}
