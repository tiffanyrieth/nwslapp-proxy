// Bracket Battle — the engine's PURE core (no I/O). Builds the bracket draw, tallies a
// round, and advances. Kept dependency-free + side-effect-free so every rule is unit-
// tested (test/bracket.spec.ts); the I/O layer (ESPN fetch, Supabase REST, cron) in
// bracket-engine.ts just wires these together. Mirrors the app's scoring 1·1·2·2·3·3.

// ── Rounds ───────────────────────────────────────────────────────────────────
// Keyed (like the app's BracketRound) by how many ENTRANTS contest the round.
export const ROUND_ENTRANTS = [64, 32, 16, 8, 4, 2] as const;

/** Per-correct-pick value for a round (tiered 1·1·2·2·3·3 by round size). */
export function roundPoints(entrants: number): number {
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
  switch (entrants) {
    case 8: return "Quarterfinals";
    case 4: return "Semifinals";
    case 2: return "Final";
    default: return `Round of ${entrants}`;
  }
}

/** Hours a round stays open: early rounds 48h, QF/SF/Final 72h (owner cadence). */
export function roundHours(entrants: number): number {
  return entrants <= 8 ? 72 : 48;
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
