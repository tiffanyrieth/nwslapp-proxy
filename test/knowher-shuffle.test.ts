// Answer-order shuffle at publish (2026-09-07). Guards the fix for the W37 defect where the correct
// answer was option 1 (index 0) for every MC question. Pure test. Run:
//   node --test test/knowher-shuffle.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { shuffleKnowHerOptions } from "../src/knowher.ts";

// The input deliberately mirrors the W37 bug: EVERY MC question has the correct answer at index 0.
function mc(n: number) {
  return {
    id: `sd-player-mc${n}`,
    category: "herStory",
    prompt: `Q${n}?`,
    options: [`correct${n}`, `wrongA${n}`, `wrongB${n}`, `wrongC${n}`],
    correctIndex: 0,
  };
}
function tf(n: number, trueIsCorrect: boolean) {
  return {
    id: `sd-player-tf${n}`,
    category: "trueOrFalse",
    prompt: `TF${n}?`,
    options: ["True", "False"],
    correctIndex: trueIsCorrect ? 0 : 1,
  };
}
function makePool() {
  const questions = [
    ...Array.from({ length: 12 }, (_, i) => mc(i)),
    tf(0, true), tf(1, false), tf(2, true),
  ];
  return { season: 2026, weekKey: "2026-W37", players: [{ teamAbbreviation: "SD", espnAthleteId: "1", questions }] };
}
const qs = (p: ReturnType<typeof makePool>) => p.players[0].questions;

test("answer is preserved: options[correctIndex] still equals the original correct string", () => {
  const p = makePool();
  const before = qs(p).map((q) => q.options[q.correctIndex]);
  shuffleKnowHerOptions(p as any);
  const after = qs(p).map((q) => q.options[q.correctIndex]);
  assert.deepEqual(after, before, "the correct-answer STRING must survive the shuffle");
});

test("MC correct answers are no longer all at index 0, and the position varies", () => {
  const p = makePool();
  shuffleKnowHerOptions(p as any);
  const mcIdx = qs(p).filter((q) => q.category !== "trueOrFalse").map((q) => q.correctIndex);
  assert.ok(!mcIdx.every((i) => i === 0), "the shuffle must move the correct answer off index 0");
  assert.ok(new Set(mcIdx).size > 1, "correctIndex should vary across questions");
});

test("option order actually changes for the bulk of questions", () => {
  const p = makePool();
  const before = qs(p).map((q) => q.options.join("|"));
  shuffleKnowHerOptions(p as any);
  const after = qs(p).map((q) => q.options.join("|"));
  const changed = before.filter((o, i) => o !== after[i]).length;
  assert.ok(changed >= before.length / 2, `expected most questions reordered, got ${changed}/${before.length}`);
});

test("deterministic: identical input yields identical output (re-publish safe)", () => {
  const a = makePool(), b = makePool();
  shuffleKnowHerOptions(a as any);
  shuffleKnowHerOptions(b as any);
  assert.deepEqual(
    qs(a).map((q) => [q.options, q.correctIndex]),
    qs(b).map((q) => [q.options, q.correctIndex]),
  );
});

test("True/False: options stay the {True,False} pair and the correct answer is preserved", () => {
  const p = makePool();
  const want = qs(p).filter((q) => q.category === "trueOrFalse").map((q) => q.options[q.correctIndex]);
  shuffleKnowHerOptions(p as any);
  qs(p).filter((q) => q.category === "trueOrFalse").forEach((q, i) => {
    assert.deepEqual(new Set(q.options), new Set(["True", "False"]), "T/F must stay True + False");
    assert.equal(q.options[q.correctIndex], want[i], "T/F correct answer must be preserved");
  });
});
