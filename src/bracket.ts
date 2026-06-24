// Bracket Battle — the engine's PURE core (no I/O). Builds the bracket draw, tallies a
// round, and advances. Kept dependency-free + side-effect-free so every rule is unit-
// tested (test/bracket.spec.ts); the I/O layer (ESPN fetch, Supabase REST, cron) in
// bracket-engine.ts just wires these together. Mirrors the app's scoring 1·1·2·2·3·3.

// ── Rounds ───────────────────────────────────────────────────────────────────
// Keyed (like the app's BracketRound) by how many ENTRANTS contest the round.
export const ROUND_ENTRANTS = [64, 32, 16, 8, 4, 2] as const;

/** Per-correct-pick value for a round (tiered 1·1·2·2·3·3 by round size). Qualifying
 *  rounds (negative codes — see the qualifying section below) are all worth 1. */
export function roundPoints(entrants: number): number {
  if (entrants < 0) return 1; // qualifying
  switch (entrants) {
    case 64: return 1;
    case 32: return 1;
    case 16: return 2;
    case 8: return 2;
    case 4: return 3;
    case 2: return 3;
    default: return 1;
  }
}

export function roundTitle(entrants: number): string {
  if (entrants < 0) return `Qualifying ${entrants + 5}`; // -4→Q1 … -1→Q4
  switch (entrants) {
    case 8: return "Quarterfinals";
    case 4: return "Semifinals";
    case 2: return "Final";
    default: return `Round of ${entrants}`;
  }
}

/** Hours a round stays open: early rounds 48h, QF/SF/Final 72h (owner cadence). The
 *  engine overrides this with bracket_config early/late day-windows; this is the fallback
 *  + the pure-test reference. Qualifying counts as early. */
export function roundHours(entrants: number): number {
  if (entrants < 0) return 48; // qualifying — early
  return entrants <= 8 ? 72 : 48;
}

/** Early rounds get the shorter voting window: qualifying + the first two main rounds
 *  (Round of 64, Round of 32). Round of 16 onward is "late". */
export function isEarlyRound(code: number): boolean {
  return code < 0 || code >= 32;
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface Entrant {
  id: string;
  name: string;
  jersey: number | null;
  team: string;
  seed: number; // 1 = top
}

export interface Matchup {
  slot: number;
  round: number; // entrant-count of the round (64, 32, …)
  aId: string;
  bId: string;
  points: number;
}

// ── Bracket maths ─────────────────────────────────────────────────────────────

/** Smallest power of two ≥ n (min 2). 60 → 64, 16 → 16, 70 → 128. */
export function nextPow2(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

/**
 * Standard single-elimination seed order for a bracket of `size` (a power of two):
 * the seed number sitting in each bracket slot, so favourites are maximally spread
 * (1 plays the weakest, can only meet 2 in the final). size 4 → [1,4,3,2].
 */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    const next: number[] = [];
    for (const s of order) {
      next.push(s);
      next.push(sum - s);
    }
    order = next;
  }
  return order;
}

/**
 * Build the FIRST round from a seeded entrant list (any size). The bracket size is the
 * next power of two ≥ pool; the top `size − pool` seeds get BYES (no round-1 matchup,
 * they enter round 2). Round-1 matchups avoid same-team collisions where possible.
 * Returns the matchups (only real A-vs-B pairs) plus the bye'd entrant ids in seed order.
 */
export function buildFirstRound(entrants: Entrant[]): { matchups: Matchup[]; byeIds: string[] } {
  const pool = entrants.length;
  const size = nextPow2(pool);
  const round = size; // the round is named by the full bracket size
  const points = roundPoints(round);
  const bySeed = new Map(entrants.map((e) => [e.seed, e]));
  const order = seedOrder(size); // order[slot] = seed in that slot (1..size)

  // A slot holds a real entrant if its seed ≤ pool; seeds > pool are empty (byes).
  const slotEntrant = (slot: number): Entrant | undefined => bySeed.get(order[slot]);

  const matchups: Matchup[] = [];
  const byes: Entrant[] = [];
  let slotIndex = 0;
  for (let i = 0; i < size; i += 2) {
    const a = slotEntrant(i);
    const b = slotEntrant(i + 1);
    if (a && b) {
      matchups.push({ slot: slotIndex++, round, aId: a.id, bId: b.id, points });
    } else if (a || b) {
      byes.push((a ?? b)!); // the real entrant gets a bye to round 2
    }
  }

  avoidSameTeam(matchups, entrants);
  const byeIds = byes.sort((x, y) => x.seed - y.seed).map((e) => e.id); // top seeds first
  return { matchups, byeIds };
}

/**
 * Greedily break same-team round-1 matchups: when A and B share a team, swap B with the
 * B-side entrant of another matchup whose teams both differ — without creating a new
 * collision. Deterministic (scans in slot order). Some collisions may be unavoidable
 * (e.g. a team with very many entrants); those are left as-is rather than looping forever.
 */
export function avoidSameTeam(matchups: Matchup[], entrants: Entrant[]): void {
  const team = new Map(entrants.map((e) => [e.id, e.team]));
  for (let i = 0; i < matchups.length; i++) {
    const m = matchups[i];
    if (team.get(m.aId) !== team.get(m.bId)) continue;
    for (let j = 0; j < matchups.length; j++) {
      if (j === i) continue;
      const n = matchups[j];
      // Swap m.b ↔ n.b if it resolves m without breaking n.
      const okM = team.get(m.aId) !== team.get(n.bId);
      const okN = team.get(n.aId) !== team.get(m.bId);
      const distinct = team.get(n.bId) !== team.get(m.bId);
      if (okM && okN && distinct) {
        const tmp = m.bId; m.bId = n.bId; n.bId = tmp;
        break;
      }
    }
  }
}

// ── Tally + advance ───────────────────────────────────────────────────────────

export interface MatchupVotes {
  slot: number;
  aId: string;
  bId: string;
  aVotes: number;
  bVotes: number;
  seedA: number;
  seedB: number;
}

export interface MatchupResult {
  slot: number;
  winnerId: string;
  splitAPercent: number; // A's share, 0–100
  voteCount: number;
}

/**
 * Resolve one matchup from its raw vote counts. Majority wins; a TIE (including 0–0)
 * advances the HIGHER seed (lower seed number) — deterministic + explainable.
 */
export function tallyMatchup(v: MatchupVotes): MatchupResult {
  const total = v.aVotes + v.bVotes;
  const aWins = v.aVotes > v.bVotes || (v.aVotes === v.bVotes && v.seedA <= v.seedB);
  const splitA = total === 0 ? (v.seedA <= v.seedB ? 100 : 0) : Math.round((v.aVotes / total) * 100);
  return {
    slot: v.slot,
    winnerId: aWins ? v.aId : v.bId,
    splitAPercent: splitA,
    voteCount: total,
  };
}

/**
 * Build the next round's matchups from the just-resolved round's winners (in slot order)
 * plus any bye'd entrants (seed order) that are entering now. Winners + byes are
 * concatenated and paired sequentially. `byeIds` is only non-empty advancing INTO round 2.
 */
export function nextRoundMatchups(
  advancingIds: string[],
  nextRound: number,
): Matchup[] {
  const points = roundPoints(nextRound);
  const matchups: Matchup[] = [];
  for (let i = 0; i + 1 < advancingIds.length; i += 2) {
    matchups.push({
      slot: matchups.length,
      round: nextRound,
      aId: advancingIds[i],
      bId: advancingIds[i + 1],
      points,
    });
  }
  return matchups;
}

/** Spread bye'd entrants evenly among the round-1 winners (so top seeds don't bunch
 * together when they enter round 2). Returns the round-2 entrant order. */
export function interleaveByes(winners: string[], byes: string[]): string[] {
  if (byes.length === 0) return winners.slice();
  const out: string[] = [];
  const gap = Math.max(1, Math.floor((winners.length + byes.length) / byes.length));
  let bi = 0;
  for (let i = 0; i < winners.length; i++) {
    if (bi < byes.length && i % gap === 0) out.push(byes[bi++]);
    out.push(winners[i]);
  }
  while (bi < byes.length) out.push(byes[bi++]);
  return out;
}

/** The round-entrant-count that follows `round` (64→32→…→2), or null after the final. */
export function nextRound(round: number): number | null {
  const i = ROUND_ENTRANTS.indexOf(round as (typeof ROUND_ENTRANTS)[number]);
  if (i < 0 || i === ROUND_ENTRANTS.length - 1) return null;
  return ROUND_ENTRANTS[i + 1];
}

// ── Qualifying / large-pool structure ─────────────────────────────────────────
// Pools larger than 64 run rolling-entry QUALIFYING rounds before a standard 64-player
// main bracket. Round CODES match the app's BracketRound raw values: main rounds are the
// entrant-count (64..2); qualifying rounds are NEGATIVE (q1 = −4, q2 = −3, q3 = −2,
// q4 = −1), each 32 matchups worth 1 point. q1 is always the first round played (the
// lowest seeds). Both the Worker (writer) and the iOS app (reader) decode `round` the same
// way — this is the cross-repo contract.
//
// Invariants (no player dropped, every round ≤32 matchups):
//   • The top 32 seeds BYE straight into the Round of 64.
//   • The other 32 Round-of-64 slots are filled by qualifiers (the last QR's winners).
//   • Each QR is 64 players → 32 winners. q1 = the lowest 64 seeds; each later QR mixes
//     the prior 32 winners with the next-higher 32 seeds entering.
//   • q = (size − 64) / 32, so size ∈ {96,128,160,192} ⇒ q ∈ {1,2,3,4}; size 64 ⇒ q 0.
// Supported sizes top out at 192 (q ≤ 4, matching the app's four qualifying enum cases);
// a larger requested pool snaps DOWN to 192 (the lowest seeds drop — the caller logs it).

/** q1..q4 round codes, in play order (q1 first). */
export const QUAL_CODES = [-4, -3, -2, -1] as const;

export function isQualifying(code: number): boolean { return code < 0; }

/** Human 1-based qualifying index for a code (−4 → 1 … −1 → 4). */
export function qualIndex(code: number): number { return code + 5; }

/** The largest SUPPORTED bracket size ≤ the requested pool. ≤64 passes through (the
 *  classic round-1-bye path handles 33..64); 65..95 → 64; 96+ snaps to 64+32·q, q≤4. */
export function plannedSize(poolCount: number): number {
  if (poolCount <= 64) return poolCount;
  if (poolCount < 96) return 64;
  return 64 + 32 * Math.min(4, Math.floor((poolCount - 64) / 32));
}

export interface BracketStructure {
  size: number;                          // 64/96/128/160/192 (after snapping)
  qualifyingCount: number;               // 0..4
  rounds: number[];                      // ordered round codes, e.g. [-4,-3,64,32,16,8,4,2]
  entrySeeds: Record<number, number[]>;  // round code → the seeds NEWLY entering that round
}

function seedRange(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let s = lo; s <= hi; s++) out.push(s);
  return out;
}

/**
 * Plan the full round structure for a pool. For ≤64 it's the classic main bracket (qualifying
 * count 0; first-round byes handle a non-power-of-two pool via buildFirstRound). For >64 it
 * lays out the qualifying rounds + their rolling entry-seed schedule and the main bracket.
 */
export function planStructure(poolCount: number): BracketStructure {
  const size = plannedSize(poolCount);
  if (size <= 64) {
    const first = nextPow2(Math.max(size, 2));
    const rounds = ROUND_ENTRANTS.filter((r) => r <= first) as unknown as number[];
    return { size, qualifyingCount: 0, rounds, entrySeeds: {} };
  }
  const q = (size - 64) / 32; // 1..4
  const codes = QUAL_CODES.slice(0, q); // q1..qq
  const entrySeeds: Record<number, number[]> = {};
  // q1: the lowest 64 seeds.
  entrySeeds[codes[0]] = seedRange(size - 63, size);
  // q2..qq: each brings in the next-higher 32 seeds.
  for (let k = 2; k <= q; k++) {
    entrySeeds[codes[k - 1]] = seedRange(size - 63 - 32 * (k - 1), size - 32 - 32 * (k - 1));
  }
  // The top 32 seeds enter (bye) at the Round of 64, joining the 32 qualifiers.
  entrySeeds[64] = seedRange(1, 32);
  const rounds = [...codes, 64, 32, 16, 8, 4, 2];
  return { size, qualifyingCount: q, rounds, entrySeeds };
}

/** The round code that follows `code` in a structure, or null after the Final. Works for
 *  qualifying codes and main rounds alike (drives both generation and the app's flow). */
export function nextCodeIn(structure: BracketStructure, code: number): number | null {
  const i = structure.rounds.indexOf(code);
  if (i < 0 || i === structure.rounds.length - 1) return null;
  return structure.rounds[i + 1];
}

/**
 * Build a round from a group of participants by SEED SPREAD (best vs worst), like the main
 * draw — used for q1 (64 fresh entrants) and any all-fresh group. `participants` need not be
 * a power of two; the next power of two frames the bracket and the surplus top seeds get a
 * bye (returned separately), mirroring buildFirstRound. `roundCode` stamps the matchups.
 */
export function buildSeededRound(
  participants: Entrant[],
  roundCode: number,
): { matchups: Matchup[]; byeIds: string[] } {
  const sorted = [...participants].sort((a, b) => a.seed - b.seed);
  const pool = sorted.length;
  const bracket = nextPow2(Math.max(pool, 2));
  const points = roundPoints(roundCode);
  // Local re-rank 1..pool by seed so seedOrder spreads them regardless of global seeds.
  const byLocal = new Map(sorted.map((e, i) => [i + 1, e]));
  const order = seedOrder(bracket);
  const matchups: Matchup[] = [];
  const byes: Entrant[] = [];
  let slot = 0;
  for (let i = 0; i < bracket; i += 2) {
    const a = byLocal.get(order[i]);
    const b = byLocal.get(order[i + 1]);
    if (a && b) matchups.push({ slot: slot++, round: roundCode, aId: a.id, bId: b.id, points });
    else if (a || b) byes.push((a ?? b)!);
  }
  avoidSameTeam(matchups, participants);
  return { matchups, byeIds: byes.sort((x, y) => x.seed - y.seed).map((e) => e.id) };
}

/**
 * Build the matchups for a round generated AT TALLY: the prior round's `winners` (slot
 * order) merged with any `newEntrants` entering now (seed order), paired sequentially.
 * `interleaveByes` spreads the fresh entrants among the survivors so top seeds don't bunch.
 * The engine applies `avoidSameTeam` afterward (it holds every advancing entrant's team).
 */
export function buildMergedRound(
  winners: string[],
  newEntrants: Entrant[],
  roundCode: number,
): Matchup[] {
  const fresh = [...newEntrants].sort((a, b) => a.seed - b.seed);
  const advancing = interleaveByes(winners, fresh.map((e) => e.id));
  return nextRoundMatchups(advancing, roundCode);
}

/**
 * Assemble the 64 Round-of-64 entrants for a large (>64) pool: the 32 bye holders keep
 * their original seeds (1-32); the 32 qualifier winners get EFFECTIVE seeds 33-64 by
 * their original-seed rank (best survivor → 33, worst → 64). Feed the result to
 * `buildSeededRound(…, 64)` so seedOrder spreads all 64 across the quadrants (1v64,
 * 32v33, seeds 1 & 2 in opposite halves) — instead of `buildMergedRound`'s sequential
 * pairing, which let top seeds bunch into the same quadrant. Pure — unit-tested.
 */
export function roundOf64Entrants(byeHolders: Entrant[], qualifierWinners: Entrant[]): Entrant[] {
  const ranked = [...qualifierWinners]
    .sort((a, b) => a.seed - b.seed)
    .map((e, i) => ({ ...e, seed: 33 + i }));
  return [...byeHolders, ...ranked];
}
