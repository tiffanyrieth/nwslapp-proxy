import { describe, it, expect } from "vitest";
import {
  validateTriviaFlatPool,
  groupIntoRounds,
  resolveRound,
  sliceFlatPool,
  makeEditionKey,
  parseEditionKey,
  wrapRound,
  DEFAULT_GROUP_CONFIG,
  type TriviaPoolDoc,
  type TriviaQuestion,
} from "../src/trivia";

const CATS = ["leagueHistory", "playerFacts", "venues", "rules", "records", "teamHistory"];

function q(id: string, over: Partial<TriviaQuestion> = {}): TriviaQuestion {
  return {
    id,
    question: `Question ${id}?`,
    options: ["a", "b", "c", "d"],
    correctIndex: 0,
    category: "leagueHistory",
    difficulty: "easy",
    scope: "evergreen",
    flavor: "standard",
    source: "https://example.com/x",
    ...over,
  };
}

/** A feasible library: evenly category-cycled within each difficulty, every `funEvery`-th flagged funFact. */
function buildPool(counts: { easy: number; medium: number; hard: number }, funEvery = 5): TriviaQuestion[] {
  const out: TriviaQuestion[] = [];
  let n = 0;
  for (const d of ["easy", "medium", "hard"] as const) {
    for (let i = 0; i < counts[d]; i++) {
      out.push(
        q(`q${n}`, {
          difficulty: d,
          category: CATS[n % CATS.length],
          flavor: n % funEvery === 0 ? "funFact" : "standard",
        }),
      );
      n++;
    }
  }
  return out;
}

describe("edition keys", () => {
  it("builds zero-padded keys and round-trips", () => {
    expect(makeEditionKey(2026, 8)).toBe("2026-R08");
    expect(makeEditionKey(2026, 12)).toBe("2026-R12");
    expect(parseEditionKey("2026-R08")).toEqual({ season: 2026, round: 8 });
    expect(parseEditionKey("2026-R30")).toEqual({ season: 2026, round: 30 });
    expect(parseEditionKey("nope")).toBeNull();
    expect(parseEditionKey("2026-R00")).toBeNull();
  });

  it("wraps a round onto the stored range (fail-safe)", () => {
    expect(wrapRound(1, 30)).toBe(1);
    expect(wrapRound(30, 30)).toBe(30);
    expect(wrapRound(31, 30)).toBe(1); // next season, missed refresh → wrap to R01
    expect(wrapRound(65, 30)).toBe(5);
  });
});

describe("validateTriviaFlatPool", () => {
  it("accepts a good pool and defaults flavor", () => {
    const r = validateTriviaFlatPool([q("a"), { ...q("b"), flavor: undefined }]);
    expect("questions" in r).toBe(true);
    if ("questions" in r) {
      expect(r.questions.length).toBe(2);
      expect(r.questions[1].flavor).toBe("standard");
    }
  });

  it("rejects duplicate ids, bad options, bad enums, missing source", () => {
    expect(validateTriviaFlatPool([q("a"), q("a")])).toHaveProperty("error");
    expect(validateTriviaFlatPool([q("a", { options: ["x", "y", "z"] })])).toHaveProperty("error");
    expect(validateTriviaFlatPool([q("a", { correctIndex: 4 })])).toHaveProperty("error");
    expect(validateTriviaFlatPool([q("a", { category: "bogus" })])).toHaveProperty("error");
    expect(validateTriviaFlatPool([q("a", { difficulty: "trivial" })])).toHaveProperty("error");
    expect(validateTriviaFlatPool([q("a", { scope: "forever" })])).toHaveProperty("error");
    expect(validateTriviaFlatPool([q("a", { flavor: "spicy" })])).toHaveProperty("error");
    expect(validateTriviaFlatPool([{ ...q("a"), source: "" }])).toHaveProperty("error");
    expect(validateTriviaFlatPool([])).toHaveProperty("error");
  });

  it("allows a missing source when requireSource is off (manual paths)", () => {
    expect(validateTriviaFlatPool([{ ...q("a"), source: "" }], { requireSource: false })).toHaveProperty("questions");
  });
});

describe("groupIntoRounds", () => {
  it("groups a feasible pool into disjoint, constraint-satisfying rounds", () => {
    const pool = buildPool({ easy: 150, medium: 150, hard: 150 }); // 450 library, 300 used
    const r = groupIntoRounds(pool, 2026);
    expect("rounds" in r).toBe(true);
    if (!("rounds" in r)) return;
    const rounds = r.rounds;
    const keys = Object.keys(rounds);
    expect(keys.length).toBe(30);

    const allIds = new Set<string>();
    for (const key of keys) {
      const round = rounds[key];
      expect(round.length).toBe(10);
      // difficulty mix 2/4/4
      const diff: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
      const cat: Record<string, number> = {};
      let fun = 0;
      for (const item of round) {
        diff[item.difficulty]++;
        cat[item.category] = (cat[item.category] ?? 0) + 1;
        if (item.flavor === "funFact") fun++;
        allIds.add(item.id);
      }
      expect(diff.easy).toBe(2);
      expect(diff.medium).toBe(4);
      expect(diff.hard).toBe(4);
      expect(fun).toBeGreaterThanOrEqual(DEFAULT_GROUP_CONFIG.funFactsPerRound);
      expect(Object.keys(cat).length).toBeGreaterThanOrEqual(DEFAULT_GROUP_CONFIG.categoryMinDistinct);
      expect(Math.max(...Object.values(cat))).toBeLessThanOrEqual(DEFAULT_GROUP_CONFIG.categoryMaxPerRound);
    }
    // no in-year repeats: 30 rounds × 10 = 300 distinct question ids
    expect(allIds.size).toBe(300);
  });

  it("is deterministic (same pool + season → identical grouping)", () => {
    const pool = buildPool({ easy: 150, medium: 150, hard: 150 });
    const a = groupIntoRounds(pool, 2026);
    const b = groupIntoRounds([...pool], 2026);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("rejects an infeasible pool with a named shortfall (no partial write)", () => {
    const pool = buildPool({ easy: 150, medium: 150, hard: 96 }); // too few hard (need 120)
    const r = groupIntoRounds(pool, 2026);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toContain("hard");
      expect(r.error).toContain("infeasible");
    }
  });

  it("rejects too few fun facts", () => {
    const pool = buildPool({ easy: 150, medium: 150, hard: 150 }, 1000); // ~0 fun facts
    const r = groupIntoRounds(pool, 2026);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("fun");
  });
});

describe("resolveRound (fail-safe wrap)", () => {
  const doc: TriviaPoolDoc = {
    season: 2026,
    roundCount: 3,
    perRound: 1,
    rounds: {
      "2026-R01": [q("a")],
      "2026-R02": [q("b")],
      "2026-R03": [q("c")],
    },
  };

  it("returns the exact round with no wrap", () => {
    const r = resolveRound(doc, "2026-R02");
    expect(r?.wrapped).toBe(false);
    expect(r?.questions[0].id).toBe("b");
  });

  it("wraps a future-season key onto the stored season (missed refresh)", () => {
    // 2027-R02 not published → wrap to the stored season's round 2.
    const r = resolveRound(doc, "2027-R02");
    expect(r?.wrapped).toBe(true);
    expect(r?.questions[0].id).toBe("b");
  });

  it("wraps a round number past the stored count", () => {
    const r = resolveRound(doc, "2026-R05"); // 5 → ((5-1)%3)+1 = 2
    expect(r?.wrapped).toBe(true);
    expect(r?.questions[0].id).toBe("b");
  });

  it("returns null when nothing is published", () => {
    expect(resolveRound(null, "2026-R01")).toBeNull();
  });
});

describe("sliceFlatPool (bridge)", () => {
  const pool = Array.from({ length: 40 }, (_, i) => q(`q${String(i).padStart(3, "0")}`));

  it("returns disjoint rounds of perRound, deterministic, wrapping after the pool is exhausted", () => {
    const r1 = sliceFlatPool(pool, 1, 10);
    const r2 = sliceFlatPool(pool, 2, 10);
    const r5 = sliceFlatPool(pool, 5, 10); // 40/10 = 4 rounds, so round 5 wraps to round 1
    expect(r1.length).toBe(10);
    expect(new Set([...r1, ...r2].map((x) => x.id)).size).toBe(20); // rounds 1 & 2 disjoint
    expect(sliceFlatPool(pool, 1, 10).map((x) => x.id)).toEqual(r1.map((x) => x.id)); // deterministic
    expect(r5.map((x) => x.id)).toEqual(r1.map((x) => x.id)); // wraps
  });

  it("is empty on an empty pool", () => {
    expect(sliceFlatPool([], 1, 10)).toEqual([]);
  });
});
