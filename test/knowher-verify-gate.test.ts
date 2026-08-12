// The weekend/Monday verify-gate split (2026-08-12). Pure + KV-mock tests; the full network path
// (publishVerifiedPool → fetchStatsForMany/fetchTeamAbbrs) is exercised live via the supervised first run
// and the health check, per this module's testing convention. Run:
//   node --test test/knowher-verify-gate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stageVerifiedCandidate,
  readVerifiedCandidate,
  wantStatFor,
  KNOWN_CLUB_ABBRS,
  KNOWHER_CANDIDATE_VERIFIED_KEY,
  type KnowHerEnv,
} from "../src/knowher.ts";

/** Minimal in-memory KV — only the get/put JSON path stageVerifiedCandidate uses. */
function mockEnv(): { env: KnowHerEnv; store: Map<string, string>; ttl: Map<string, number> } {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  const FEED_TAGS = {
    async get(key: string, _type?: string) {
      const v = store.get(key);
      return v == null ? null : JSON.parse(v);
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      if (opts?.expirationTtl) ttl.set(key, opts.expirationTtl);
    },
  } as unknown as KVNamespace;
  return { env: { FEED_TAGS } as KnowHerEnv, store, ttl };
}

/** One human question carrying a source (what the verified pool ships). */
const q = (id: string, over: Record<string, unknown> = {}) => ({
  id, category: "herStory", prompt: `Q ${id}?`, options: ["a", "b", "c", "d"], correctIndex: 0,
  revealFact: "fact", source: "https://example.com/x", ...over,
});

/** A complete HUMAN-ONLY verified pool: all 16 clubs, `human` questions each, no stat questions. */
function humanOnlyPool(human = 8) {
  return {
    weekKey: "2026-W40", season: 2026,
    players: KNOWN_CLUB_ABBRS.map((abbr, i) => ({
      teamAbbreviation: abbr, espnAthleteId: String(1000 + i), playerName: `P${abbr}`,
      jerseyNumber: (i % 30) + 1, position: "F", tagline: "hook",
      questions: Array.from({ length: human }, (_, j) => q(`${abbr.toLowerCase()}-h-${j}`)),
    })),
  };
}

test("stageVerifiedCandidate: accepts a human-only pool (no stat questions), stores it with the 72h TTL", async () => {
  const { env, store, ttl } = mockEnv();
  const res = await stageVerifiedCandidate(env, humanOnlyPool(8));
  assert.ok("ok" in res && res.ok, `expected ok, got ${JSON.stringify(res)}`);
  assert.equal((res as any).playerCount, 16);
  assert.equal((res as any).humanByTeam.WAS, 8, "per-team human counts reported for the verifier's report");
  assert.ok(store.has(KNOWHER_CANDIDATE_VERIFIED_KEY), "verified pool written to its own key");
  assert.equal(ttl.get(KNOWHER_CANDIDATE_VERIFIED_KEY), 72 * 3600, "72h TTL survives weekend→Monday");
  const back = await readVerifiedCandidate(env);
  assert.equal(back?.players.length, 16);
});

test("stageVerifiedCandidate: does NOT enforce ≥8 human — a short player (Monday's job) still stages", async () => {
  const { env } = mockEnv();
  const pool = humanOnlyPool(8);
  pool.players[3].questions = pool.players[3].questions.slice(0, 5); // one club left at 5 human
  const res = await stageVerifiedCandidate(env, pool);
  assert.ok("ok" in res && res.ok, "a short player is Lever-1's problem, never a stage rejection");
  assert.equal((res as any).humanByTeam[pool.players[3].teamAbbreviation], 5);
});

test("stageVerifiedCandidate: a player BELOW 5 human is rejected — the <5 hold surfaces at the verifier", async () => {
  const { env } = mockEnv();
  const pool = humanOnlyPool(8);
  pool.players[7].questions = pool.players[7].questions.slice(0, 3); // 3 human — can't reach the 10-floor even at the 5-stat cap
  const res = await stageVerifiedCandidate(env, pool);
  assert.ok("error" in res, "a <5-human player can never ship, so it holds on the weekend, not silently Monday");
});

test("stageVerifiedCandidate: still rejects a missing source (the verifier must keep every source)", async () => {
  const { env } = mockEnv();
  const pool = humanOnlyPool(8);
  delete (pool.players[0].questions[0] as any).source;
  const res = await stageVerifiedCandidate(env, pool);
  assert.ok("error" in res, "an unsourced human question must be rejected");
});

test("stageVerifiedCandidate: still rejects a short-of-16-clubs pool", async () => {
  const { env } = mockEnv();
  const pool = humanOnlyPool(8);
  pool.players.pop(); // 15 clubs
  const res = await stageVerifiedCandidate(env, pool);
  assert.ok("error" in res, "a 15-club edition leaves a fanbase with nothing — reject");
});

test("wantStatFor (Lever 1 ladder): ≥8 human → 2 stats; a short player tops toward the 10-floor, capped at 5", () => {
  assert.equal(wantStatFor(9), 2, "rich player: standard pair");
  assert.equal(wantStatFor(8), 2, "exactly 8 human: standard pair → 10");
  assert.equal(wantStatFor(7), 3, "7 human → 3 stats → 10");
  assert.equal(wantStatFor(6), 4, "6 human → 4 stats → 10");
  assert.equal(wantStatFor(5), 5, "5 human → 5 stats → 10 (the cap)");
  // Below 5 the cap can't reach the floor (4+5=9 < 10) — the caller HOLDS the whole run.
  assert.equal(wantStatFor(4), 5, "4 human: capped at 5, so 4+5=9 < 10 ⇒ caller holds");
  assert.ok(4 + wantStatFor(4) < 10, "a <5-human player cannot reach the floor even at the cap ⇒ hold");
  assert.ok(5 + wantStatFor(5) >= 10, "a 5-human player just reaches the floor ⇒ ships");
});
