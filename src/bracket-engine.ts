// Bracket Battle — the engine's I/O layer. Wires the pure core (bracket.ts) to ESPN
// (player pool + seeding stats) and Supabase (read votes, write editions/matchups/
// scores) using the SERVICE-ROLE key. `runBracketTick` is the whole job: called hourly
// from index.ts's scheduled() and from the admin POST /bracket/run route. Idempotent —
// it acts only when state demands (generate when nothing's active + the break elapsed;
// tally + advance when the open round has closed).
//
// Self-contained on purpose: index.ts imports only `runBracketTick`. Live verification
// needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set as Worker secrets + the v2 migration
// applied (supabase/migration_bracket_v2.sql in the app repo).

import {
  buildFirstRound,
  tallyMatchup,
  nextRound,
  nextRoundMatchups,
  interleaveByes,
  roundHours,
  roundPoints,
  type Entrant,
  type MatchupVotes,
} from "./bracket";

export interface BracketEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl";
const BREAK_MS = 7 * 24 * 3600 * 1000; // ~1 week between editions
const POOL_CAP = 64; // never seed more than a 64-bracket for stat editions

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

// ── ESPN player pool + seeding stat ───────────────────────────────────────────

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

// ── Edition generation (stats-seeded; all players of a position, byes) ─────────

/** Build a position-edition entrant list: EVERY player of `group` across all 16 teams,
 *  seeded by ROUND-ROBIN INTERLEAVE across teams (seed 1 = team A's first, seed 2 =
 *  team B's first, …) so each club's players are spread through the seed range — which
 *  keeps same-team players out of the early rounds and varies the draw. Within a team,
 *  ordered by jersey. No per-player API calls (16 roster fetches total) → fits the free
 *  Workers subrequest budget. (Exact season-stat seeding is a later option — needs more
 *  subrequests; see the engine notes.) Capped at a 64-bracket. */
async function buildStatsPool(group: "F" | "M" | "D" | "G"): Promise<Entrant[]> {
  const teams = await fetchTeamAbbrs();
  const rosters = await Promise.all(teams.map((t) => fetchRoster(t.id, t.abbr)));
  const byTeam = rosters.map((r) =>
    r.filter((p) => POSITION_GROUP[p.position] === group)
      .sort((a, b) => (a.jersey ?? 999) - (b.jersey ?? 999)),
  );
  const ordered: RosterPlayer[] = [];
  for (let depth = 0; ordered.length < POOL_CAP; depth++) {
    let added = false;
    for (const team of byTeam) {
      const p = team[depth];
      if (p) {
        ordered.push(p);
        added = true;
        if (ordered.length >= POOL_CAP) break;
      }
    }
    if (!added) break; // every team exhausted
  }
  return ordered.map((p, i) => ({
    id: p.id, name: p.name, jersey: p.jersey, team: p.team, seed: i + 1,
  }));
}

async function writeEdition(
  env: BracketEnv,
  ed: { id: string; themeLabel: string; title: string; type: "statsSeeded" | "creative" },
  entrants: Entrant[],
): Promise<void> {
  const { matchups } = buildFirstRound(entrants);
  const round = entrants.length <= 32 ? (entrants.length <= 16 ? 16 : 32) : 64; // first round size proxy
  const closes = new Date(Date.now() + roundHours(round) * 3600 * 1000).toISOString();

  await sbInsert(env, "bracket_editions", [{
    id: ed.id, theme_label: ed.themeLabel, title: ed.title, emoji: "", type: ed.type,
    current_round: matchups[0]?.round ?? round, round_opened_at: new Date().toISOString(),
    round_closes_at: closes, is_active: true, fan_count: 0,
  }]);
  await sbInsert(env, "bracket_entrants", entrants.map((e) => ({
    edition_id: ed.id, entrant_id: e.id, seed: e.seed, player_name: e.name,
    jersey_number: e.jersey, team_abbreviation: e.team,
  })));
  await sbInsert(env, "bracket_matchups", matchups.map((m) => ({
    id: `${ed.id}-r${m.round}-s${m.slot}`, edition_id: ed.id, round: m.round, slot: m.slot,
    entrant_a_id: m.aId, entrant_b_id: m.bId, points: m.points,
  })));
}

// ── The tick ──────────────────────────────────────────────────────────────────

interface EditionRow { id: string; current_round: number; round_closes_at: string | null; is_active: boolean; }

/** Force the active edition's open round to close NOW (round_closes_at → the past) so
 *  the next tick tallies it. Verification only (the cron closes rounds on schedule). */
export async function forceCloseActiveRound(env: BracketEnv): Promise<string> {
  const active = await sbGet<{ id: string; current_round: number }[]>(
    env, "bracket_editions?is_active=eq.true&select=id,current_round&limit=1");
  if (active.length === 0) return "no active edition to close";
  await sbPatch(env, "bracket_editions", `id=eq.${active[0].id}`,
    { round_closes_at: new Date(Date.now() - 60_000).toISOString() });
  return `forced close on ${active[0].id} round ${active[0].current_round}`;
}

export async function runBracketTick(env: BracketEnv, now: number = Date.now()): Promise<string> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return "skipped: Supabase secrets not set";
  }
  // Guard against a misconfigured/swapped secret WITHOUT echoing its value (a bad
  // SUPABASE_URL would otherwise leak into thrown URLs/stacks).
  if (!env.SUPABASE_URL.startsWith("https://") || !env.SUPABASE_URL.includes(".supabase.co")) {
    return "config error: SUPABASE_URL is not a https://<project>.supabase.co URL — it looks swapped with the service-role key. Re-set both secrets.";
  }
  const active = await sbGet<EditionRow[]>(env, "bracket_editions?is_active=eq.true&select=id,current_round,round_closes_at,is_active&limit=1");

  if (active.length === 0) {
    // Nothing live — generate a new edition if the break since the last one has elapsed.
    const last = await sbGet<{ created_at: string }[]>(env, "bracket_editions?select=created_at&order=created_at.desc&limit=1");
    if (last.length && now - new Date(last[0].created_at).getTime() < BREAK_MS) {
      return "idle: in the break between editions";
    }
    return await generateNext(env, now);
  }

  const ed = active[0];
  if (ed.round_closes_at && new Date(ed.round_closes_at).getTime() <= now) {
    return await tallyAndAdvance(env, ed, now);
  }
  return "idle: current round still open";
}

/** Alternate creative (owner-curated library) ↔ stats; creative leads when available. */
async function generateNext(env: BracketEnv, now: number): Promise<string> {
  const year = new Date(now).getUTCFullYear();
  const used = (await sbGet<{ id: string }[]>(env, "bracket_editions?select=id")).length;

  // Prefer an unused creative edition from the library (creative is the soul).
  const creative = await sbGet<{ id: string; theme_label: string; title: string; entries: unknown }[]>(
    env, "bracket_creative_editions?status=eq.ready&select=id,theme_label,title,entries&limit=1",
  );
  if (creative.length && used % 2 === 0) {
    const c = creative[0];
    const entries = c.entries as { player_id: string; player_name: string; jersey_number: number | null; team_abbreviation: string; seed: number }[];
    const entrants: Entrant[] = entries
      .map((e) => ({ id: e.player_id, name: e.player_name, jersey: e.jersey_number, team: e.team_abbreviation, seed: e.seed }))
      .sort((a, b) => a.seed - b.seed);
    await writeEdition(env, { id: `${c.id}`, themeLabel: c.theme_label, title: c.title, type: "creative" }, entrants);
    await sbPatch(env, "bracket_creative_editions", `id=eq.${encodeURIComponent(c.id)}`, { status: "used" });
    return `generated creative edition ${c.id} (${entrants.length} entrants)`;
  }

  // Otherwise a position edition (Top Forward — every forward, team-interleave seeded).
  const pool = await buildStatsPool("F");
  if (pool.length < 8) return "idle: not enough stat data to generate yet";
  const id = `top-forward-${year}-${used}`;
  await writeEdition(env, { id, themeLabel: "TOP FORWARD", title: `Best Forward · ${year}`, type: "statsSeeded" }, pool);
  return `generated stats edition ${id} (${pool.length} entrants)`;
}

interface MatchupRow { id: string; slot: number; entrant_a_id: string; entrant_b_id: string; points: number; }
interface VoteRow { matchup_id: string; entrant_id: string; user_id: string; }
interface EntrantRow { entrant_id: string; seed: number; }

/** Close the open round: tally real votes, set winners + splits + counts, score every
 *  voter, then open the next round (or finish the edition). */
async function tallyAndAdvance(env: BracketEnv, ed: EditionRow, now: number): Promise<string> {
  const round = ed.current_round;
  const matchups = await sbGet<MatchupRow[]>(
    env, `bracket_matchups?edition_id=eq.${ed.id}&round=eq.${round}&select=id,slot,entrant_a_id,entrant_b_id,points`);
  const votes = await sbGet<VoteRow[]>(
    env, `bracket_votes?edition_id=eq.${ed.id}&round=eq.${round}&select=matchup_id,entrant_id,user_id`);
  const entrantRows = await sbGet<EntrantRow[]>(
    env, `bracket_entrants?edition_id=eq.${ed.id}&select=entrant_id,seed`);
  const seedOf = new Map(entrantRows.map((e) => [e.entrant_id, e.seed]));

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

  // Score every voter for this round: correct picks × the round's points.
  const winnerByMatchup = new Map(matchups.map((m, i) => [m.id, winners[i]]));
  const perUser = new Map<string, number>();
  const pts = roundPoints(round);
  for (const v of votes) {
    if (winnerByMatchup.get(v.matchup_id) === v.entrant_id) {
      perUser.set(v.user_id, (perUser.get(v.user_id) ?? 0) + pts);
    }
  }
  // Read current scores to add onto, then upsert (PostgREST has no atomic increment).
  const existing = await sbGet<{ user_id: string; points: number }[]>(
    env, `bracket_scores?edition_id=eq.${ed.id}&select=user_id,points`);
  const base = new Map(existing.map((s) => [s.user_id, s.points]));
  const scoreRows = [...perUser.entries()].map(([user_id, add]) => ({
    user_id, edition_id: ed.id, points: (base.get(user_id) ?? 0) + add, updated_at: new Date(now).toISOString(),
  }));
  await sbUpsert(env, "bracket_scores", scoreRows, "user_id,edition_id");
  await sbPatch(env, "bracket_editions", `id=eq.${ed.id}`,
    { fan_count: new Set(votes.map((v) => v.user_id)).size });

  // Advance: next round from winners (+ byes interleaved when leaving round 1), or finish.
  const nr = nextRound(round);
  if (nr === null) {
    await sbPatch(env, "bracket_editions", `id=eq.${ed.id}`, { is_active: false, round_closes_at: null });
    return `edition ${ed.id} complete — champion crowned`;
  }
  // Byes only enter from round 1: total slots in nr = nr; if winners < nr, the missing are byes.
  let advancing = winners;
  if (winners.length < nr) {
    const allEntrants = await sbGet<EntrantRow[]>(env, `bracket_entrants?edition_id=eq.${ed.id}&select=entrant_id,seed`);
    const inMatchups = new Set(matchups.flatMap((m) => [m.entrant_a_id, m.entrant_b_id]));
    const byes = allEntrants.filter((e) => !inMatchups.has(e.entrant_id)).sort((a, b) => a.seed - b.seed).map((e) => e.entrant_id);
    advancing = interleaveByes(winners, byes);
  }
  const nextMatchups = nextRoundMatchups(advancing, nr);
  await sbInsert(env, "bracket_matchups", nextMatchups.map((m) => ({
    id: `${ed.id}-r${m.round}-s${m.slot}`, edition_id: ed.id, round: m.round, slot: m.slot,
    entrant_a_id: m.aId, entrant_b_id: m.bId, points: m.points,
  })));
  await sbPatch(env, "bracket_editions", `id=eq.${ed.id}`, {
    current_round: nr, round_opened_at: new Date(now).toISOString(),
    round_closes_at: new Date(now + roundHours(nr) * 3600 * 1000).toISOString(),
  });
  return `tallied round ${round} (${matchups.length} matchups) → opened round ${nr}`;
}
