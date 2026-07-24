// Pure tests for the edition-structure accuracy denominator (the "100%-with-4-points" fix).
// node --test (the vitest-pool-workers specs can't boot workerd on Node 26 here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchupCount, cumulativeMatchups } from "../src/bracket.ts";

test("matchupCount: qualifying is 32, main is entrants/2", () => {
  assert.equal(matchupCount(-4), 32); // qualifying
  assert.equal(matchupCount(-1), 32);
  assert.equal(matchupCount(64), 32);
  assert.equal(matchupCount(32), 16);
  assert.equal(matchupCount(16), 8);
  assert.equal(matchupCount(8), 4); // quarterfinals
  assert.equal(matchupCount(4), 2); // semifinals
  assert.equal(matchupCount(2), 1); // final
});

test("cumulativeMatchups: 64-pool sums matchups through each round", () => {
  // rounds [64,32,16,8,4,2] → matchups [32,16,8,4,2,1]
  assert.equal(cumulativeMatchups(64, 64), 32);
  assert.equal(cumulativeMatchups(64, 32), 48);
  assert.equal(cumulativeMatchups(64, 16), 56);
  assert.equal(cumulativeMatchups(64, 8), 60);
  assert.equal(cumulativeMatchups(64, 4), 62);
  assert.equal(cumulativeMatchups(64, 2), 63); // whole-bracket matchup count
});

test("cumulativeMatchups: 128-pool includes the two qualifying rounds", () => {
  // rounds [-4,-3,64,32,16,8,4,2] → matchups [32,32,32,16,8,4,2,1]
  assert.equal(cumulativeMatchups(128, -4), 32); // through qualifying 1
  assert.equal(cumulativeMatchups(128, -3), 64); // through qualifying 2
  assert.equal(cumulativeMatchups(128, 64), 96); // through round of 64 (32+32+32)
  assert.equal(cumulativeMatchups(128, 32), 112); // + 16
  assert.equal(cumulativeMatchups(128, 16), 120); // + 8
  assert.equal(cumulativeMatchups(128, 2), 127); // full 128-pool bracket
});

test("cumulativeMatchups: the fix — a one-round player's denominator is the whole edition so far", () => {
  // A player who only voted round-of-64 (32 matchups) and went 4/4: their accuracy is NOT 100%.
  // After the semifinal has tallied in a 64-pool, the denominator is 62, so 4 correct = ~6%.
  const denomThroughSemis = cumulativeMatchups(64, 4);
  assert.equal(denomThroughSemis, 62);
  assert.ok(4 / denomThroughSemis < 0.1);
});
