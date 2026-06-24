import { describe, it, expect } from "vitest";
import {
  nextPow2,
  seedOrder,
  buildFirstRound,
  tallyMatchup,
  nextRoundMatchups,
  nextRound,
  roundPoints,
  roundTitle,
  isEarlyRound,
  interleaveByes,
  plannedSize,
  planStructure,
  nextCodeIn,
  buildSeededRound,
  buildMergedRound,
  QUAL_CODES,
} from "../src/bracket";
import { roundCloseISO, startEditionThemeId, slug } from "../src/bracket-engine";

describe("slug — admin theme-id derivation", () => {
  it("lowercases, hyphenates, and trims", () => {
    expect(slug("Best Celebration")).toBe("best-celebration");
    expect(slug("  Who Wins a Stare-Down?  ")).toBe("who-wins-a-stare-down");
    expect(slug("Walkout Vibes!! 2026")).toBe("walkout-vibes-2026");
  });
});

describe("startEditionThemeId — targeted manual start parsing", () => {
  it("returns null for a bare start_edition (rotation pick)", () => {
    expect(startEditionThemeId("start_edition")).toBe(null);
  });
  it("extracts the theme id from a targeted start", () => {
    expect(startEditionThemeId("start_edition:who-wins-a-stare-down-2026")).toBe("who-wins-a-stare-down-2026");
  });
  it("trims surrounding whitespace", () => {
    expect(startEditionThemeId("start_edition:  best-goalkeeper-2026  ")).toBe("best-goalkeeper-2026");
  });
  it("returns null for an empty suffix", () => {
    expect(startEditionThemeId("start_edition:")).toBe(null);
  });
});

// Inclusive integer range [lo..hi].
function range(lo: number, hi: number): number[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

// `n` entrants, seeds 1..n, teams spread across 16 by default.
function entrants(n: number, teamOf: (i: number) => string = (i) => `T${i % 16}`) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i + 1}`,
    name: `P${i + 1}`,
    jersey: i + 1,
    team: teamOf(i),
    seed: i + 1,
  }));
}

describe("nextPow2", () => {
  it("rounds up to the next power of two", () => {
    expect(nextPow2(60)).toBe(64);
    expect(nextPow2(64)).toBe(64);
    expect(nextPow2(70)).toBe(128);
    expect(nextPow2(16)).toBe(16);
    expect(nextPow2(2)).toBe(2);
  });
});

describe("seedOrder", () => {
  it("puts seed 1 against the weakest and seed 2 in the other half", () => {
    const o4 = seedOrder(4);
    expect(o4[0]).toBe(1);
    expect(o4[1]).toBe(4); // seed 1 plays seed 4 (the weakest)
    const o8 = seedOrder(8);
    expect(o8[0]).toBe(1);
    expect(o8[1]).toBe(8);
    // seed 1 and seed 2 are in different round-1 pairs (can only meet in the final).
    const pairOf = (s: number) => Math.floor(o8.indexOf(s) / 2);
    expect(pairOf(1)).not.toBe(pairOf(2));
  });
  it("is a permutation of 1..size; round-1 pairs sum to size+1", () => {
    const o = seedOrder(64);
    expect(o.length).toBe(64);
    expect(new Set(o).size).toBe(64);
    for (let i = 0; i < 64; i += 2) expect(o[i] + o[i + 1]).toBe(65);
  });
});

describe("buildFirstRound", () => {
  it("64 entrants → 32 matchups, no byes, round-of-64 points", () => {
    const { matchups, byeIds } = buildFirstRound(entrants(64));
    expect(matchups.length).toBe(32);
    expect(byeIds.length).toBe(0);
    expect(matchups.every((m) => m.round === 64 && m.points === 1)).toBe(true);
  });
  it("60 entrants → 28 matchups + 4 byes to the top 4 seeds", () => {
    const { matchups, byeIds } = buildFirstRound(entrants(60));
    expect(matchups.length).toBe(28);
    expect(byeIds).toEqual(["e1", "e2", "e3", "e4"]);
  });
  it("includes every entrant exactly once across matchups + byes", () => {
    const { matchups, byeIds } = buildFirstRound(entrants(60));
    const ids = new Set([...byeIds, ...matchups.flatMap((m) => [m.aId, m.bId])]);
    expect(ids.size).toBe(60);
  });
});

describe("avoidSameTeam (via buildFirstRound)", () => {
  it("breaks a same-team round-1 collision when possible", () => {
    // Seeds 1 & 8 share a team — in seedOrder(8) they pair in slot 0.
    const es = entrants(8, (i) => (i === 0 || i === 7 ? "KC" : `T${i}`));
    const { matchups } = buildFirstRound(es);
    const team = new Map(es.map((e) => [e.id, e.team]));
    expect(matchups.some((m) => team.get(m.aId) === team.get(m.bId))).toBe(false);
  });
});

describe("tallyMatchup", () => {
  const base = { slot: 0, aId: "a", bId: "b", seedA: 3, seedB: 10 };
  it("majority wins; split % + count are right", () => {
    const r = tallyMatchup({ ...base, aVotes: 70, bVotes: 30 });
    expect(r.winnerId).toBe("a");
    expect(r.splitAPercent).toBe(70);
    expect(r.voteCount).toBe(100);
  });
  it("a tie (incl. 0–0) advances the higher seed", () => {
    expect(tallyMatchup({ ...base, aVotes: 5, bVotes: 5 }).winnerId).toBe("a");
    expect(tallyMatchup({ ...base, aVotes: 0, bVotes: 0 }).winnerId).toBe("a");
    expect(
      tallyMatchup({ slot: 0, aId: "a", bId: "b", seedA: 10, seedB: 3, aVotes: 0, bVotes: 0 }).winnerId,
    ).toBe("b");
  });
});

describe("advancement", () => {
  it("nextRound steps down, then ends after the final", () => {
    expect(nextRound(64)).toBe(32);
    expect(nextRound(4)).toBe(2);
    expect(nextRound(2)).toBeNull();
  });
  it("interleaveByes spreads byes among winners (no dupes/drops)", () => {
    const r = interleaveByes(["w1", "w2", "w3", "w4"], ["b1", "b2"]);
    expect(r.length).toBe(6);
    expect(new Set(r).size).toBe(6);
    expect(r.indexOf("b1")).toBeLessThan(r.indexOf("b2"));
  });
  it("nextRoundMatchups pairs sequentially with the round's points", () => {
    const ms = nextRoundMatchups(["a", "b", "c", "d"], 16);
    expect(ms.length).toBe(2);
    expect(ms[0]).toMatchObject({ aId: "a", bId: "b", round: 16, points: 2 });
  });
});

describe("roundPoints", () => {
  it("is tiered 1·1·2·2·3·3", () => {
    expect([64, 32, 16, 8, 4, 2].map(roundPoints)).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it("scores every qualifying round at 1", () => {
    expect(QUAL_CODES.map(roundPoints)).toEqual([1, 1, 1, 1]);
  });
});

describe("qualifying round codes", () => {
  it("title + early-window for qualifying codes (the cross-repo contract)", () => {
    expect(QUAL_CODES.map(roundTitle)).toEqual([
      "Qualifying 1", "Qualifying 2", "Qualifying 3", "Qualifying 4",
    ]);
    // Early window: qualifying + the first two main rounds (R64, R32); R16 onward is late.
    expect([-4, -1, 64, 32].every(isEarlyRound)).toBe(true);
    expect([16, 8, 4, 2].some(isEarlyRound)).toBe(false);
  });
});

describe("plannedSize", () => {
  it("passes ≤64 through, snaps 65..95 down to 64, and snaps 96+ to 64+32·q (≤192)", () => {
    expect([50, 64].map(plannedSize)).toEqual([50, 64]);
    expect([65, 80, 95].map(plannedSize)).toEqual([64, 64, 64]);
    expect([96, 128, 160, 192].map(plannedSize)).toEqual([96, 128, 160, 192]);
    expect([224, 256].map(plannedSize)).toEqual([192, 192]); // clamp to 4 qualifying rounds
  });
});

describe("planStructure", () => {
  it("≤64 has no qualifying rounds", () => {
    const s = planStructure(60);
    expect(s.qualifyingCount).toBe(0);
    expect(s.rounds).toEqual([64, 32, 16, 8, 4, 2]);
  });
  it("128 → 2 qualifying rounds with the documented rolling entry", () => {
    const s = planStructure(128);
    expect(s.qualifyingCount).toBe(2);
    expect(s.rounds).toEqual([-4, -3, 64, 32, 16, 8, 4, 2]);
    expect(s.entrySeeds[-4]).toEqual(range(65, 128)); // q1: lowest 64 seeds
    expect(s.entrySeeds[-3]).toEqual(range(33, 64));  // q2: next 32 enter
    expect(s.entrySeeds[64]).toEqual(range(1, 32));   // byes enter the main bracket
  });
  it("every supported pool covers seeds 1..size exactly once across entry tiers", () => {
    for (const size of [96, 128, 160, 192]) {
      const s = planStructure(size);
      const all = Object.values(s.entrySeeds).flat().sort((a, b) => a - b);
      expect(all).toEqual(range(1, size)); // no gaps, no overlaps, nobody dropped
    }
  });
  it("nextCodeIn walks qualifying → main → null", () => {
    const s = planStructure(128);
    expect(nextCodeIn(s, -4)).toBe(-3);
    expect(nextCodeIn(s, -3)).toBe(64);
    expect(nextCodeIn(s, 64)).toBe(32);
    expect(nextCodeIn(s, 2)).toBeNull();
  });
  it("max points are rule-derived from the structure (128 → 145)", () => {
    // matchups per round: qualifying/64 → 32, 32 → 16, 16 → 8, 8 → 4, 4 → 2, 2 → 1.
    const matchupsForCode = (c: number) => (c < 0 || c === 64 ? 32 : c / 2);
    const max = (size: number) =>
      planStructure(size).rounds.reduce((sum, c) => sum + matchupsForCode(c) * roundPoints(c), 0);
    expect(max(64)).toBe(81);   // classic 64-pool (matches the app's BracketScoring test)
    expect(max(128)).toBe(145); // 32+32 (qual) +32+16 +16+8 +6+3
  });
});

describe("buildSeededRound (qualifying round 1)", () => {
  it("64 fresh entrants → 32 matchups stamped with the q1 code + 1 point, no byes", () => {
    const { matchups, byeIds } = buildSeededRound(entrants(64), -4);
    expect(matchups.length).toBe(32);
    expect(byeIds.length).toBe(0);
    expect(matchups.every((m) => m.round === -4 && m.points === 1)).toBe(true);
    const ids = new Set(matchups.flatMap((m) => [m.aId, m.bId]));
    expect(ids.size).toBe(64); // every entrant placed exactly once
  });
});

describe("buildMergedRound (survivors + fresh entrants)", () => {
  it("32 winners + 32 fresh → 32 main-bracket matchups, all 64 placed once", () => {
    const winners = Array.from({ length: 32 }, (_, i) => `w${i + 1}`);
    const fresh = entrants(32).map((e, i) => ({ ...e, id: `b${i + 1}`, seed: i + 1 }));
    const ms = buildMergedRound(winners, fresh, 64);
    expect(ms.length).toBe(32);
    expect(ms.every((m) => m.round === 64 && m.points === 1)).toBe(true);
    const ids = new Set(ms.flatMap((m) => [m.aId, m.bId]));
    expect(ids.size).toBe(64);
  });
});

describe("roundCloseISO — manual mode writes no deadline", () => {
  const cfg = (mode: "manual" | "auto") => ({
    mode, season: "2026", defaultPoolSize: 128, earlyRoundDays: 2, lateRoundDays: 3,
    breakDays: 7, manualAction: null, themeRotation: "alternate" as const,
    usedThemesThisSeason: [] as string[], statFetchBudget: 20,
  });

  it("returns null in manual mode (round stays open until the operator advances)", () => {
    expect(roundCloseISO(64, 0, cfg("manual"))).toBe(null);
    expect(roundCloseISO(8, 0, cfg("manual"))).toBe(null);
  });

  it("returns the early/late dated ISO in auto mode", () => {
    // R64 is an early round → earlyRoundDays (2); QF (8) is late → lateRoundDays (3).
    expect(roundCloseISO(64, 0, cfg("auto"))).toBe(new Date(2 * 86_400_000).toISOString());
    expect(roundCloseISO(8, 0, cfg("auto"))).toBe(new Date(3 * 86_400_000).toISOString());
  });
});
