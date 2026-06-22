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

export interface BracketEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // Optional KV (the full Worker Env carries it) — backs NO-SILENT-FAILURES diag telemetry,
  // surfaced in the owner's GET /telemetry/recent. Best-effort; absent in pure unit contexts.
  FEED_TAGS?: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };
}

const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl";

// ── Config (bracket_config; read every tick) ───────────────────────────────────

type Mode = "manual" | "auto";
type ManualAction = "advance_round" | "close_edition" | "start_edition" | "pause" | "resume";

interface BracketConfig {
  mode: Mode;
  season: string;
  defaultPoolSize: number;
  earlyRoundDays: number;
  lateRoundDays: number;
  breakDays: number;
  manualAction: ManualAction | null;
  themeRotation: "alternate" | "sequential";
  usedThemesThisSeason: string[];
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

async function fetchTeamAbbrs(): Promise<{ id: string; abbr: string }[]> {
  const json = (await (await fetch(`${ESPN_SITE}/teams`)).json()) as {
    sports?: { leagues?: { teams?: { team?: { id?: string; abbreviation?: string } }[] }[] }[];
  };
  const teams = json.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return teams
    .map((t) => ({ id: t.team?.id ?? "", abbr: (t.team?.abbreviation ?? "").toUpperCase() }))
    .filter((t) => t.id && t.abbr);
}

async function fetchRoster(teamId: string, abbr: string): Promise<RosterPlayer[]> {
  const json = (await (await fetch(`${ESPN_SITE}/teams/${teamId}/roster`)).json()) as {
    athletes?: { id?: string; displayName?: string; jersey?: string; position?: { abbreviation?: string } }[];
  };
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

/**
 * Build a stats-edition entrant list: every player of `group` (or all positions when null)
 * across the 16 teams, up to `cap`, seeded by ROUND-ROBIN INTERLEAVE across teams (a
 * visibility proxy — each club's players spread through the seed range, which keeps same-team
 * players out of the early rounds). 16 roster fetches total → fits the Workers subrequest
 * budget. NOTE: this is roster-depth seeding, NOT exact season-stat ranking (goals+assists,
 * save% …) — that needs per-athlete Core API stats and is tracked as a follow-up; the edition
 * still records its `seeding_stat` for display, and a heuristic-seeding diag is emitted.
 */
async function buildStatsPool(env: BracketEnv, group: "F" | "M" | "D" | "G" | null, cap: number): Promise<Entrant[]> {
  const teams = await fetchTeamAbbrs();
  const rosters = await Promise.all(teams.map((t) => fetchRoster(t.id, t.abbr)));
  const byTeam = rosters.map((r) =>
    r.filter((p) => group === null || POSITION_GROUP[p.position] === group)
      .sort((a, b) => (a.jersey ?? 999) - (b.jersey ?? 999)),
  );
  const ordered: RosterPlayer[] = [];
  for (let depth = 0; ordered.length < cap; depth++) {
    let added = false;
    for (const team of byTeam) {
      const p = team[depth];
      if (p) {
        ordered.push(p);
        added = true;
        if (ordered.length >= cap) break;
      }
    }
    if (!added) break;
  }
  await emitDiag(env, "bracketStatSeedHeuristic", `${group ?? "ALL"} pool ${ordered.length} (roster-depth)`);
  return ordered.map((p, i) => ({ id: p.id, name: p.name, jersey: p.jersey, team: p.team, seed: i + 1 }));
}

// ── Edition generation ─────────────────────────────────────────────────────────

/** Voting-window close time for a round code, from config (early/late day windows). */
function roundCloseISO(code: number, now: number, config: BracketConfig): string {
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
  const year = new Date(now).getUTCFullYear();
  const editionCount = (await sbGet<{ id: string }[]>(env, "bracket_editions?select=id")).length;
  const order = editionCount + 1;
  const used = new Set(config.usedThemesThisSeason);
  const wantCreative = config.themeRotation === "sequential" ? true : editionCount % 2 === 0;

  const pickCreative = async (): Promise<string | null> => {
    const rows = await sbGet<{ id: string; theme_label: string; title: string }[]>(
      env, "bracket_creative_editions?status=eq.ready&select=id,theme_label,title&order=created_at.asc&limit=10");
    const row = rows.find((r) => !used.has(r.id));
    if (!row) return null;
    // Creative editions are theme-only: the player pool comes from ESPN rosters (the WHOLE
    // league — all positions — seeded by the same visibility heuristic as stats editions).
    // Only the theme label differs; matchup cards show name/jersey/team, no content lines.
    const pool = await buildStatsPool(env, null, config.defaultPoolSize);
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
    const pool = await buildStatsPool(env, group, config.defaultPoolSize);
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

// ── The tick ──────────────────────────────────────────────────────────────────

interface EditionRow { id: string; current_round: number; round_closes_at: string | null; is_active: boolean; pool_size: number | null; }

async function getActiveEdition(env: BracketEnv): Promise<EditionRow | null> {
  const rows = await sbGet<EditionRow[]>(
    env, "bracket_editions?is_active=eq.true&select=id,current_round,round_closes_at,is_active,pool_size&limit=1");
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

/** Manual mode: act on the queued operator action, then clear it. */
async function handleManual(env: BracketEnv, config: BracketConfig, active: EditionRow | null, now: number): Promise<string> {
  const action = config.manualAction;
  if (!action) return "manual: idle (no pending action)";

  let result: string;
  switch (action) {
    case "advance_round":
      result = active ? await tallyAndAdvance(env, active, now, config, false) : "manual advance: no active edition";
      break;
    case "close_edition":
      result = active ? await tallyAndAdvance(env, active, now, config, true) : "manual close: no active edition";
      break;
    case "start_edition":
      result = active ? `manual start: edition ${active.id} already active` : await generateNext(env, config, now);
      break;
    case "pause":
      if (active) await sbPatch(env, "bracket_editions", `id=eq.${active.id}`, { round_closes_at: null });
      result = active ? `manual: round paused on ${active.id}` : "manual pause: no active edition";
      break;
    case "resume":
      if (active) {
        await sbPatch(env, "bracket_editions", `id=eq.${active.id}`, {
          round_opened_at: new Date(now).toISOString(),
          round_closes_at: roundCloseISO(active.current_round, now, config),
        });
      }
      result = active ? `manual: round resumed on ${active.id}` : "manual resume: no active edition";
      break;
    default:
      result = `manual: unknown action "${action}"`;
      await emitDiag(env, "bracketUnknownAction", String(action));
  }
  await setConfigValue(env, "manual_action", null); // one-shot — clear after acting
  return result;
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
  for (const v of votes) {
    perUserTotal.set(v.user_id, (perUserTotal.get(v.user_id) ?? 0) + 1);
    if (winnerByMatchup.get(v.matchup_id) === v.entrant_id) {
      perUserPts.set(v.user_id, (perUserPts.get(v.user_id) ?? 0) + pts);
      perUserCorrect.set(v.user_id, (perUserCorrect.get(v.user_id) ?? 0) + 1);
    }
  }
  await accumulateScores(env, ed.id, perUserPts, now);
  await accumulateUserStats(env, ed.id, round, perUserCorrect, perUserTotal, now);
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

/** Accumulate per-edition accuracy backing for the Leaderboard "Your Stats" tab: cumulative
 *  correct/total picks + the user's best single round (by accuracy). Service-role write. */
async function accumulateUserStats(
  env: BracketEnv, editionId: string, round: number,
  perUserCorrect: Map<string, number>, perUserTotal: Map<string, number>, now: number,
): Promise<void> {
  if (perUserTotal.size === 0) return;
  interface StatRow { user_id: string; correct_picks: number; total_picks: number; best_round: number | null; best_round_correct: number; best_round_total: number; }
  const existing = await sbGet<StatRow[]>(
    env, `bracket_user_edition_stats?edition_id=eq.${editionId}&select=user_id,correct_picks,total_picks,best_round,best_round_correct,best_round_total`);
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
    return {
      user_id: uid, edition_id: editionId,
      correct_picks: (prev?.correct_picks ?? 0) + rc,
      total_picks: (prev?.total_picks ?? 0) + rt,
      best_round, best_round_correct: brc, best_round_total: brt,
      updated_at: new Date(now).toISOString(),
    };
  });
  await sbUpsert(env, "bracket_user_edition_stats", rows, "user_id,edition_id");
}
