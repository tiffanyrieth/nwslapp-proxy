import { describe, it, expect } from "vitest";
import {
  nextPow2,
  seedOrder,
  buildFirstRound,
  tallyMatchup,
  nextRoundMatchups,
  nextRound,
  roundPoints,
  interleaveByes,
} from "../src/bracket";

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
});
