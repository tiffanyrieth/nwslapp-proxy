// NWSL Trivia content pipeline — the pool validator + the deterministic ROUND GROUPER.
//
// Trivia's content model (docs/fan-zone.md, roadmap #2): a Claude routine GENERATES a yearly library of
// tagged questions and VERIFIES them; this module then deterministically GROUPS that flat library into the
// season's biweekly rounds — each round hitting a difficulty mix + a fun-fact quota + a category spread, and
// with NO in-year repeats (every question used in exactly one round). LLMs are poor at this kind of
// constraint bin-packing, so it lives in code: the generator's job is only to write a *feasible* tagged pool.
//
// Unlike Know Her Game, Trivia has NO week-to-week freshness pressure (a fact written in January is valid all
// year), so there is NO Monday watcher / per-round publish / stat injection / featured ledger — the whole year
// publishes once, and the app reads a static pre-grouped doc keyed by editionKey ("2026-R08").

export interface TriviaQuestion {
  id: string;
  question: string;
  options: string[]; // exactly 4
  correctIndex: number; // 0..3
  category: string; // one of TRIVIA_CATEGORIES
  difficulty: string; // one of TRIVIA_DIFFICULTIES
  scope: string; // one of TRIVIA_SCOPES — "evergreen" (never changes) vs "seasonBound" (the annual refresh)
  flavor?: string; // "standard" | "funFact" — funFact drives the on-card chip + the per-round quota
  source: string; // the verify-gate URL — required, human spot-check backstop (mirrors KHG)
  revealFact?: string; // the "did you know" payoff shown after answering
}

/** The published, pre-grouped document (KV `trivia-pool-v2`). The app fetches one round's questions by key. */
export interface TriviaPoolDoc {
  season: number;
  roundCount: number;
  perRound: number;
  rounds: Record<string, TriviaQuestion[]>; // editionKey ("2026-R08") -> exactly perRound questions
  generatedAt?: string; // ISO stamp, informational
}

export const TRIVIA_CATEGORIES = new Set([
  "leagueHistory", "playerFacts", "venues", "rules", "records", "teamHistory",
]);
export const TRIVIA_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
export const TRIVIA_SCOPES = new Set(["evergreen", "seasonBound"]);
export const TRIVIA_FLAVORS = new Set(["standard", "funFact"]);

// KV keys (single FEED_TAGS namespace, mirrors KHG). v2 = the pre-grouped doc; v1 = the legacy flat pool,
// kept for old app builds during rollout.
export const TRIVIA_POOL_V2_KEY = "trivia-pool-v2";
export const TRIVIA_POOL_V1_KEY = "trivia-pool-v1";
export const TRIVIA_CANDIDATE_KEY = "trivia:candidate-v1";
export const TRIVIA_CANDIDATE_TTL = 30 * 24 * 3600; // 30d — a whole annual generation may stage over days

export interface GroupConfig {
  roundCount: number;
  perRound: number;
  difficultyTarget: { easy: number; medium: number; hard: number }; // must sum to perRound
  funFactsPerRound: number; // orthogonal to difficulty (a fun fact still carries a difficulty)
  categoryMaxPerRound: number;
  categoryMinDistinct: number;
}

// Owner-set knobs (2026-08-13): lean-harder difficulty, 2 fun facts, ≥4 categories, 30 rounds/season.
export const DEFAULT_GROUP_CONFIG: GroupConfig = {
  roundCount: 30,
  perRound: 10,
  difficultyTarget: { easy: 2, medium: 4, hard: 4 },
  funFactsPerRound: 2,
  categoryMaxPerRound: 3,
  categoryMinDistinct: 4,
};

const DIFFS = ["easy", "medium", "hard"] as const;

// ── Edition keys ────────────────────────────────────────────────────────────
// The key format `YYYY-R NN` IS the cross-repo contract (the app's FanZoneCadence.editionKey). The proxy
// only parses/builds keys — it never needs the app's biweekly date math.

export function makeEditionKey(season: number, round: number): string {
  return `${season}-R${String(round).padStart(2, "0")}`;
}

export function parseEditionKey(key: string): { season: number; round: number } | null {
  const m = /^(\d{4})-R(\d{2,})$/.exec(key);
  if (!m) return null;
  const season = parseInt(m[1], 10);
  const round = parseInt(m[2], 10);
  if (!Number.isInteger(season) || !Number.isInteger(round) || round < 1) return null;
  return { season, round };
}

/** Map a requested round onto the stored season's round range (the fail-safe wrap for a missed refresh —
 *  cross-year repeat, acceptable, never an empty game). 1-based; `((n-1) mod count)+1`. */
export function wrapRound(round: number, storedRoundCount: number): number {
  if (storedRoundCount <= 0) return 1;
  return (((round - 1) % storedRoundCount) + storedRoundCount) % storedRoundCount + 1;
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Validate a flat generated/verified pool. `requireSource` ON for the automated candidate/ingest paths
 *  (mirrors KHG's verify-gate rule); a bad enum value is a REJECTION here, which is why the app can decode
 *  the served fields leniently as String? without ever crashing on server drift. */
export function validateTriviaFlatPool(
  raw: unknown,
  opts: { requireSource?: boolean } = {},
): { questions: TriviaQuestion[] } | { error: string } {
  const requireSource = opts.requireSource ?? true;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "pool must be a non-empty array" };
  const ids = new Set<string>();
  const out: TriviaQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] as Partial<TriviaQuestion>;
    const at = `question[${i}] (${q?.id ?? "?"})`;
    if (!q || typeof q !== "object" || Array.isArray(q)) return { error: `${at}: not an object` };
    if (typeof q.id !== "string" || !q.id.trim()) return { error: `${at}: missing id` };
    if (ids.has(q.id)) return { error: `${at}: duplicate id ${q.id}` };
    ids.add(q.id);
    if (typeof q.question !== "string" || !q.question.trim()) return { error: `${at}: missing question text` };
    if (!Array.isArray(q.options) || q.options.length !== 4) return { error: `${at}: options must be exactly 4` };
    if (q.options.some((o) => typeof o !== "string" || !o.trim())) return { error: `${at}: blank option` };
    if (!Number.isInteger(q.correctIndex) || (q.correctIndex as number) < 0 || (q.correctIndex as number) > 3) {
      return { error: `${at}: correctIndex must be 0..3` };
    }
    if (typeof q.category !== "string" || !TRIVIA_CATEGORIES.has(q.category)) return { error: `${at}: invalid category "${q.category}"` };
    if (typeof q.difficulty !== "string" || !TRIVIA_DIFFICULTIES.has(q.difficulty)) return { error: `${at}: invalid difficulty "${q.difficulty}"` };
    if (typeof q.scope !== "string" || !TRIVIA_SCOPES.has(q.scope)) return { error: `${at}: invalid scope "${q.scope}"` };
    const flavor = q.flavor ?? "standard";
    if (!TRIVIA_FLAVORS.has(flavor)) return { error: `${at}: invalid flavor "${q.flavor}"` };
    if (requireSource && (typeof q.source !== "string" || !q.source.trim())) return { error: `${at}: missing source` };
    out.push({ ...(q as TriviaQuestion), flavor, source: q.source ?? "" });
  }
  return { questions: out };
}

// ── Deterministic PRNG (SplitMix64) ─────────────────────────────────────────
// Season-seeded so a re-run on the same library yields the identical grouping (auditable), mirroring the
// app's old SeededGenerator so behaviour is familiar.

function splitmix64(seed: bigint): () => number {
  const MASK = (1n << 64n) - 1n;
  let s = seed & MASK;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & MASK;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    z = (z ^ (z >> 31n)) & MASK;
    // top 53 bits → [0,1)
    return Number(z >> 11n) / 2 ** 53;
  };
}

function seedForSeason(season: number): bigint {
  // Mix the season into a fixed constant so different seasons rotate differently.
  return (BigInt(season) * 0x100000001b3n) ^ 0x54524956_31n; // "TRIV1"
}

function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

const isFun = (q: TriviaQuestion) => q.flavor === "funFact";

// ── The grouper ─────────────────────────────────────────────────────────────

function feasibilityErrors(pool: TriviaQuestion[], cfg: GroupConfig): string[] {
  const errs: string[] = [];
  const need = cfg.roundCount * cfg.perRound;
  if (pool.length < need) errs.push(`need ≥${need} questions, have ${pool.length}`);

  const diffCount: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
  const catCount: Record<string, number> = {};
  let funCount = 0;
  for (const q of pool) {
    diffCount[q.difficulty]++;
    catCount[q.category] = (catCount[q.category] ?? 0) + 1;
    if (isFun(q)) funCount++;
  }
  for (const d of DIFFS) {
    const dneed = cfg.roundCount * cfg.difficultyTarget[d];
    if (diffCount[d] < dneed) errs.push(`need ≥${dneed} ${d}, have ${diffCount[d]}`);
  }
  const funNeed = cfg.roundCount * cfg.funFactsPerRound;
  if (funCount < funNeed) errs.push(`need ≥${funNeed} fun facts, have ${funCount}`);

  const distinctCats = Object.keys(catCount).length;
  if (distinctCats < cfg.categoryMinDistinct) {
    errs.push(`need ≥${cfg.categoryMinDistinct} distinct categories, have ${distinctCats}`);
  }
  // No single category so dominant that a round would be forced over the per-round cap.
  const catCeil = cfg.roundCount * cfg.categoryMaxPerRound;
  for (const [cat, c] of Object.entries(catCount)) {
    if (c > catCeil) errs.push(`category "${cat}" too dominant (${c} > ${catCeil} = roundCount·cap)`);
  }
  return errs;
}

/** Pick the best question from a difficulty bucket for the current round: only category-under-cap
 *  candidates; prefer a fun-fact when the round still needs one, then a category not yet in the round
 *  (drives the distinct-category spread), else earliest (the bucket is pre-shuffled → deterministic).
 *  Returns the bucket index, or -1 if nothing is category-eligible. */
function pickIndex(
  bucket: TriviaQuestion[],
  catCount: Record<string, number>,
  roundCats: Set<string>,
  cfg: GroupConfig,
  wantFun: boolean,
): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < bucket.length; i++) {
    const q = bucket[i];
    if ((catCount[q.category] ?? 0) >= cfg.categoryMaxPerRound) continue; // category full this round
    let score = 0;
    // Fun facts are scarce and per-round-quota'd: grab one strongly when the round still needs it, but
    // AVOID it otherwise so a round that's already met its quota can't waste a fun fact a later round needs.
    if (isFun(q)) score += wantFun ? 4 : -3;
    if (!roundCats.has(q.category)) score += 2; // drive the distinct-category spread
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Group a flat validated pool into `roundCount` disjoint rounds. Returns the round map or a LOUD,
 *  named-shortfall error (the caller responds 400 + emits a diag and does NOT overwrite the live doc). */
export function groupIntoRounds(
  pool: TriviaQuestion[],
  season: number,
  cfg: GroupConfig = DEFAULT_GROUP_CONFIG,
): { rounds: Record<string, TriviaQuestion[]> } | { error: string } {
  const targetSum = cfg.difficultyTarget.easy + cfg.difficultyTarget.medium + cfg.difficultyTarget.hard;
  if (targetSum !== cfg.perRound) {
    return { error: `config error: difficulty targets sum to ${targetSum}, not perRound ${cfg.perRound}` };
  }
  const feas = feasibilityErrors(pool, cfg);
  if (feas.length) return { error: `infeasible pool: ${feas.join("; ")}` };

  const rng = splitmix64(seedForSeason(season));
  const byDiff: Record<string, TriviaQuestion[]> = { easy: [], medium: [], hard: [] };
  for (const q of pool) byDiff[q.difficulty].push(q);
  for (const d of DIFFS) shuffle(byDiff[d], rng);

  const rounds: Record<string, TriviaQuestion[]> = {};
  for (let r = 1; r <= cfg.roundCount; r++) {
    const round: TriviaQuestion[] = [];
    const catCount: Record<string, number> = {};
    const roundCats = new Set<string>();
    let funPlaced = 0;

    for (const d of DIFFS) {
      for (let k = 0; k < cfg.difficultyTarget[d]; k++) {
        const wantFun = funPlaced < cfg.funFactsPerRound;
        const idx = pickIndex(byDiff[d], catCount, roundCats, cfg, wantFun);
        if (idx < 0) {
          return { error: `round ${r}: no ${d} question fits under the category cap (pool category balance too tight)` };
        }
        const q = byDiff[d].splice(idx, 1)[0];
        round.push(q);
        catCount[q.category] = (catCount[q.category] ?? 0) + 1;
        roundCats.add(q.category);
        if (isFun(q)) funPlaced++;
      }
    }

    if (funPlaced < cfg.funFactsPerRound) {
      return { error: `round ${r}: only ${funPlaced}/${cfg.funFactsPerRound} fun facts placeable (not enough fun facts in the drawn difficulties)` };
    }
    if (roundCats.size < cfg.categoryMinDistinct) {
      return { error: `round ${r}: only ${roundCats.size}/${cfg.categoryMinDistinct} distinct categories` };
    }
    rounds[makeEditionKey(season, r)] = round;
  }
  return { rounds };
}

// ── Serving (with the fail-safe wrap) ───────────────────────────────────────

/** Resolve a requested round from the stored doc. Exact hit → those 10. Otherwise (the requested season is
 *  ahead of the stored one, or the key is absent — a missed annual refresh) → WRAP onto the stored season's
 *  round range (cross-year repeat, acceptable; the caller emits a stale-serve diag on a wrap). Null only when
 *  nothing is published at all (→ the app's honest empty state). */
export function resolveRound(
  doc: TriviaPoolDoc | null,
  requestedKey: string,
): { questions: TriviaQuestion[]; wrapped: boolean } | null {
  if (!doc || !doc.rounds) return null;
  const direct = doc.rounds[requestedKey];
  if (direct && direct.length) return { questions: direct, wrapped: false };
  const parsed = parseEditionKey(requestedKey);
  if (!parsed || !doc.roundCount) return null;
  const wrappedKey = makeEditionKey(doc.season, wrapRound(parsed.round, doc.roundCount));
  const q = doc.rounds[wrappedKey];
  return q && q.length ? { questions: q, wrapped: true } : null;
}

function poolHistogram(pool: TriviaQuestion[]): Record<string, number> {
  const h: Record<string, number> = {};
  const bump = (k: string) => (h[k] = (h[k] ?? 0) + 1);
  for (const q of pool) {
    bump(`diff:${q.difficulty}`);
    bump(`cat:${q.category}`);
    bump(`scope:${q.scope}`);
    if (isFun(q)) bump("funFact");
  }
  return h;
}

// ── KV env functions (candidate staging → publish) ──────────────────────────

export interface TriviaEnv {
  FEED_TAGS: KVNamespace;
  /** Strong key: reads the staged candidate AND publishes (held by the VERIFIER routine + owner). */
  TRIVIA_INGEST_KEY?: string;
  /** Weak key: the GENERATOR routine can only STAGE a batch, never publish (blast-radius split, KHG pattern). */
  TRIVIA_CANDIDATE_KEY?: string;
}

/** The accumulating staged library (the generator adds one category-batch per run). */
export interface TriviaCandidate {
  questions: TriviaQuestion[];
}

/** Stage a batch of generated questions, MERGING into the accumulating candidate (dedupe by id, last-write
 *  wins on a re-stage). The annual generation runs category-by-category across multiple routine invocations,
 *  so each POST ADDS to the staging doc rather than replacing it. Validates shape + per-question source. NOT
 *  live, NOT grouped — the verifier reads it back and publishes. Expires (TTL) if never published: safe no-op. */
export async function stageTriviaCandidate(
  env: TriviaEnv,
  batchInput: unknown,
): Promise<{ ok: true; added: number; total: number } | { error: string }> {
  const raw = Array.isArray(batchInput) ? batchInput : (batchInput as { questions?: unknown } | null)?.questions;
  const v = validateTriviaFlatPool(raw, { requireSource: true });
  if ("error" in v) return { error: v.error };
  const existing = (await env.FEED_TAGS.get(TRIVIA_CANDIDATE_KEY, "json")) as TriviaCandidate | null;
  const byId = new Map<string, TriviaQuestion>();
  for (const q of existing?.questions ?? []) byId.set(q.id, q);
  let added = 0;
  for (const q of v.questions) {
    if (!byId.has(q.id)) added++;
    byId.set(q.id, q);
  }
  const merged: TriviaCandidate = { questions: [...byId.values()] };
  await env.FEED_TAGS.put(TRIVIA_CANDIDATE_KEY, JSON.stringify(merged), { expirationTtl: TRIVIA_CANDIDATE_TTL });
  return { ok: true, added, total: merged.questions.length };
}

export async function readTriviaCandidate(env: TriviaEnv): Promise<TriviaCandidate | null> {
  return (await env.FEED_TAGS.get(TRIVIA_CANDIDATE_KEY, "json")) as TriviaCandidate | null;
}

export interface PublishResult {
  ok: true;
  season: number;
  roundCount: number;
  perRound: number;
  used: number;
  library: number;
  dryRun: boolean;
  histogram: Record<string, number>;
}

/** The ONE publish path: validate the flat pool → group into the season's rounds → (unless dryRun) write the
 *  v2 doc. Immutability guard: refuse to overwrite the CURRENTLY-STORED season's doc (rounds fans may already
 *  have played) without `force`; a brand-new season doc is always fine. On any validation/grouping failure it
 *  returns the error and writes NOTHING (the prior season stays live — the fail-safe). */
export async function publishTriviaPool(
  env: TriviaEnv,
  input: unknown,
  opts: { season: number; force?: boolean; dryRun?: boolean; config?: GroupConfig },
): Promise<PublishResult | { error: string }> {
  const cfg = opts.config ?? DEFAULT_GROUP_CONFIG;
  if (!Number.isInteger(opts.season) || opts.season < 2000) return { error: `invalid season ${opts.season}` };
  const raw = Array.isArray(input) ? input : (input as { questions?: unknown } | null)?.questions;
  const v = validateTriviaFlatPool(raw, { requireSource: true });
  if ("error" in v) return { error: v.error };

  const grouped = groupIntoRounds(v.questions, opts.season, cfg);
  if ("error" in grouped) return { error: grouped.error };

  const existing = (await env.FEED_TAGS.get(TRIVIA_POOL_V2_KEY, "json")) as TriviaPoolDoc | null;
  if (!opts.dryRun && existing && existing.season === opts.season && !opts.force) {
    return { error: `season ${opts.season} already published — re-ingest would rewrite already-played rounds; pass force=1 to override` };
  }

  const doc: TriviaPoolDoc = {
    season: opts.season,
    roundCount: cfg.roundCount,
    perRound: cfg.perRound,
    rounds: grouped.rounds,
  };
  if (!opts.dryRun) await env.FEED_TAGS.put(TRIVIA_POOL_V2_KEY, JSON.stringify(doc));

  return {
    ok: true,
    season: opts.season,
    roundCount: cfg.roundCount,
    perRound: cfg.perRound,
    used: cfg.roundCount * cfg.perRound,
    library: v.questions.length,
    dryRun: !!opts.dryRun,
    histogram: poolHistogram(v.questions),
  };
}
