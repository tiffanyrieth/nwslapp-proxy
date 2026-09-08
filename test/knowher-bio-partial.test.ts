// The 2026-09-07 3-routine split — the BIO PARTIAL hand-off. Pure + KV-mock tests for stageBioCandidate /
// readBioCandidate (the intermediate artifact the bio routine stages and the fun routine reads). The full
// network path (the /knowher/candidate/bio endpoint auth/shape) is a thin wrapper over these, exercised via
// the end-to-end curl dry run per this module's testing convention. Run:
//   node --test test/knowher-bio-partial.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stageBioCandidate,
  readBioCandidate,
  KNOWN_CLUB_ABBRS,
  KNOWHER_CANDIDATE_BIO_KEY,
  KNOWHER_CANDIDATE_BIO_TTL,
  type KnowHerEnv,
} from "../src/knowher.ts";

/** Minimal in-memory KV — only the get/put JSON path these functions use. */
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

// A spread of trusted wells so the default fixtures satisfy the source-diversity gate (a substantial player
// must draw from >1 domain). The last char of the id picks a well, so a player's questions span 3–4 domains.
const WELLS = [
  "https://en.wikipedia.org/wiki/x", "https://nwslsoccer.com/p",
  "https://ussoccer.com/p", "https://sandiegowavefc.com/p",
];

/** One bio/career question carrying a trusted source, spread across WELLS by id (unless overridden). */
const q = (id: string, over: Record<string, unknown> = {}) => ({
  id, category: "herStory", prompt: `Q ${id}?`, options: ["a", "b", "c", "d"], correctIndex: 0,
  revealFact: "fact", source: WELLS[id.charCodeAt(id.length - 1) % WELLS.length], ...over,
});

/** A complete BIO PARTIAL: all 16 clubs, `bio` career questions each, no stat/fun questions. */
function bioPartial(bio = 8) {
  return {
    weekKey: "2026-W40", season: 2026,
    players: KNOWN_CLUB_ABBRS.map((abbr, i) => ({
      teamAbbreviation: abbr, espnAthleteId: String(2000 + i), playerName: `P${abbr}`,
      jerseyNumber: (i % 30) + 1, position: "Forward", tagline: "hook",
      questions: Array.from({ length: bio }, (_, j) => q(`${abbr.toLowerCase()}-bio-${j}`)),
    })),
  };
}

test("stageBioCandidate: accepts a bio partial, stores it under the bio key with the 24h TTL", async () => {
  const { env, store, ttl } = mockEnv();
  const res = await stageBioCandidate(env, bioPartial(8));
  assert.ok("ok" in res && res.ok, `expected ok, got ${JSON.stringify(res)}`);
  assert.equal(res.playerCount, 16);
  assert.equal(res.bioQuestions, 16 * 8);
  assert.ok(store.has(KNOWHER_CANDIDATE_BIO_KEY), "must write the bio key");
  assert.equal(ttl.get(KNOWHER_CANDIDATE_BIO_KEY), KNOWHER_CANDIDATE_BIO_TTL);
});

test("stageBioCandidate: a LOW-floor partial (3 per player) still stages — the 8-floor is the combined pool's", async () => {
  const { env } = mockEnv();
  const res = await stageBioCandidate(env, bioPartial(3));
  assert.ok("ok" in res && res.ok, `a 3-question partial must stage, got ${JSON.stringify(res)}`);
});

test("stageBioCandidate: a player BELOW 3 questions is rejected (the partial floor)", async () => {
  const { env } = mockEnv();
  const pool = bioPartial(3);
  pool.players[5].questions = pool.players[5].questions.slice(0, 2); // 2 < 3
  const res = await stageBioCandidate(env, pool);
  assert.ok("error" in res, "a sub-3 player must be rejected");
});

test("stageBioCandidate: still rejects a missing source (the verifier must have a URL per fact)", async () => {
  const { env } = mockEnv();
  const pool = bioPartial(3);
  delete (pool.players[0].questions[0] as Record<string, unknown>).source;
  const res = await stageBioCandidate(env, pool);
  assert.ok("error" in res && /source/i.test(res.error), `expected a source error, got ${JSON.stringify(res)}`);
});

test("stageBioCandidate: still rejects a short-of-16-clubs pool", async () => {
  const { env } = mockEnv();
  const pool = bioPartial(3);
  pool.players = pool.players.slice(0, 15);
  const res = await stageBioCandidate(env, pool);
  assert.ok("error" in res, "a 15-club pool must be rejected");
});

test("readBioCandidate: round-trips what stageBioCandidate stored", async () => {
  const { env } = mockEnv();
  await stageBioCandidate(env, bioPartial(7));
  const read = await readBioCandidate(env);
  assert.ok(read, "must read back the staged partial");
  assert.equal(read!.weekKey, "2026-W40");
  assert.equal(read!.players.length, 16);
  assert.equal(read!.players[0].questions.length, 7);
});

test("readBioCandidate: null when nothing staged", async () => {
  const { env } = mockEnv();
  assert.equal(await readBioCandidate(env), null);
});

test("stageBioCandidate: REJECTS a player sourced 100% from one domain (the ~95%-Wikipedia failure)", async () => {
  const { env } = mockEnv();
  const pool = bioPartial(7);
  // Force one player's whole set onto a single well.
  pool.players[3].questions = pool.players[3].questions.map((qq) => ({
    ...qq, source: "https://en.wikipedia.org/wiki/only",
  }));
  const res = await stageBioCandidate(env, pool);
  assert.ok("error" in res && /single source domain/i.test(res.error), `expected a diversity rejection, got ${JSON.stringify(res)}`);
});

test("stageBioCandidate: a THIN player (<5 questions) all one domain is fine — too small to judge", async () => {
  const { env } = mockEnv();
  const pool = bioPartial(3);
  pool.players[2].questions = pool.players[2].questions.map((qq) => ({
    ...qq, source: "https://en.wikipedia.org/wiki/only",
  }));
  const res = await stageBioCandidate(env, pool);
  assert.ok("ok" in res && res.ok, `a 3-question single-domain player must pass, got ${JSON.stringify(res)}`);
});
