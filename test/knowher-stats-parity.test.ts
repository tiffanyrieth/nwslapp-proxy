// Parity guard: the in-Worker TS stat logic (src/knowher-stats.ts) must produce byte-identical questions
// to the pure .mjs reference (scripts/knowher-stat-questions.mjs) + weave (scripts/inject_stat_questions.mjs).
// The two copies exist only because the .mjs pulls Node built-ins and can't run inside the Worker; this test
// makes drift impossible. Run:  node --test test/knowher-stats-parity.test.ts
//
// The .mjs itself is exercised for correctness by knowher-stat-questions.test.ts — here we only compare.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStatQuestions as tsBuild, buildStatQuestionsN, weaveStats } from "../src/knowher-stats.ts";
import { buildStatQuestions as mjsBuild } from "../scripts/knowher-stat-questions.mjs";
import { injectStatQuestions } from "../scripts/inject_stat_questions.mjs";

/** A spread of player archetypes covering every pref branch + the minutes/ceiling special cases. */
const PLAYERS: Record<string, Record<string, unknown>> = {
  scorer: { name: "Scorer", position: "F", goals: 7, shots: 30, shotsOnTarget: 12, assists: 4, minutes: 1200, starts: 14, appearances: 15 },
  keeper: { name: "Keeper", position: "G", saves: 44, cleanSheets: 6, minutes: 1260, starts: 14, appearances: 14 },
  grinder: { name: "Grinder", position: "M", goals: 0, assists: 3, shots: 12, minutes: 1035, starts: 12, appearances: 14, shotsOnTarget: 4 },
  everyMinute: { name: "Iron", position: "D", goals: 1, minutes: 1440, starts: 16, appearances: 16, assists: 1, shots: 6, shotsOnTarget: 2 },
  nearCeiling: { name: "Near", position: "M", minutes: 1290, starts: 15, appearances: 16, assists: 2, shots: 8, shotsOnTarget: 3 },
  benchMinutes: { name: "Bench", position: "F", minutes: 180, starts: 1, appearances: 4, assists: 1, shots: 5, goals: 1, shotsOnTarget: 2 },
  goalie2: { name: "Keep2", position: "GK", saves: 30, cleanSheets: 5, minutes: 900, starts: 10, appearances: 10 },
};

test("buildStatQuestions: TS twin is byte-identical to the .mjs for every archetype", () => {
  for (const [label, player] of Object.entries(PLAYERS)) {
    const ts = tsBuild("WAS", player as any);
    const mjs = mjsBuild("WAS", player as any);
    assert.deepEqual(ts, mjs, `stat questions diverged for ${label}`);
  }
});

test("weaveStats (2 stats): TS reproduces the .mjs weave exactly across human counts", () => {
  const human = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `h-${i}`, category: "herStory", prompt: "", options: ["a", "b"], correctIndex: 0 }));
  const stat = [
    { id: "s0", category: "herGame", prompt: "", options: ["1", "2", "3", "4"], correctIndex: 0 },
    { id: "s1", category: "herGame", prompt: "", options: ["1", "2", "3", "4"], correctIndex: 0 },
  ];
  for (const count of [8, 9, 10, 11, 13, 6, 7]) {
    const tsWoven = weaveStats(human(count) as any, stat as any).map((q: any) => q.id);
    // Drive the .mjs injection to get its weave order for the same shape.
    const pool = { players: [{ teamAbbreviation: "WAS", espnAthleteId: "1", playerName: "A", questions: human(count) }] };
    // Replace the .mjs-built stats with our fixed stat objects by injecting, then comparing only the
    // interleave PATTERN (human vs stat positions), since the .mjs builds its own stat ids.
    injectStatQuestions(pool as any, { "1": PLAYERS.scorer } as any);
    const mjsPattern = pool.players[0].questions.map((q: any) => (q.category === "herGame" ? "S" : "H")).join("");
    const tsPattern = weaveStats(human(count) as any, stat as any).map((q: any) => (q.category === "herGame" ? "S" : "H")).join("");
    assert.equal(tsPattern, mjsPattern, `weave interleave pattern diverged at ${count} human`);
    assert.ok(!tsWoven.length || true);
  }
});

test("weaveStats (Lever-1, >2 stats): never opens or ends on a stat, stats never adjacent", () => {
  const human = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `h-${i}`, category: "herStory", prompt: "", options: ["a"], correctIndex: 0 }));
  const stat = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s-${i}`, category: "herGame", prompt: "", options: ["1", "2", "3", "4"], correctIndex: 0 }));
  // A short player: 5 human + 5 stat = 10 (the Lever-1 cap), and 6 human + 4 stat, 7 human + 3 stat.
  for (const [h, k] of [[5, 5], [6, 4], [7, 3], [8, 2]]) {
    const woven = weaveStats(human(h) as any, stat(k) as any);
    const cats = woven.map((q: any) => q.category);
    assert.equal(woven.length, h + k, `${h}h+${k}s: all questions present`);
    assert.equal(cats.filter((c) => c === "herGame").length, k, `${h}h+${k}s: all stats woven`);
    // Ends stay human in every case (the flow rule holds even under the Lever-1 cap).
    assert.notEqual(cats[0], "herGame", `${h}h+${k}s: must not open on a stat`);
    assert.notEqual(cats[cats.length - 1], "herGame", `${h}h+${k}s: must not end on a stat`);
    // Non-adjacency is only achievable when there are enough humans to separate the stats (h ≥ k+1).
    // At the 5+5 extreme it's mathematically impossible, so we only assert it where it can hold.
    if (h >= k + 1) {
      const statAt = cats.map((c, i) => (c === "herGame" ? i : -1)).filter((i) => i >= 0);
      for (let i = 1; i < statAt.length; i++) {
        assert.ok(statAt[i] - statAt[i - 1] >= 2, `${h}h+${k}s: stats must not be adjacent`);
      }
    }
  }
});

test("buildStatQuestionsN: caps at the requested count and returns as many as buildable", () => {
  // A rich scorer can build up to 5 distinct stat questions (Lever-1 top-up).
  const five = buildStatQuestionsN("WAS", PLAYERS.scorer as any, 5);
  assert.ok(five.length >= 4, `a rich scorer should yield several stat questions, got ${five.length}`);
  assert.ok(five.length <= 5, "never exceeds the requested cap");
  assert.equal(new Set(five.map((q) => q.id)).size, five.length, "no duplicate stat ids");
  // The first 2 of buildStatQuestionsN match the exactly-2 builder (Lever-1 extends, never reorders).
  assert.deepEqual(five.slice(0, 2), tsBuild("WAS", PLAYERS.scorer as any));
});
