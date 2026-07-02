// Quiz community results — the aggregate "how everyone did" distribution shared by NWSL Trivia
// and Know Her Game (docs/know-her-game.md §11b). The app WRITES per-question answers straight
// to Supabase `quiz_answers` (RLS owner-only); it READS the aggregate from HERE, so no view ever
// triggers a live per-request DB aggregation.
//
// COST ARCHITECTURE (the Swifties-tour lesson): the distribution is computed by two SECURITY
// DEFINER Postgres functions (quiz_distribution + quiz_summary — they bypass RLS to COUNT but
// never return raw rows) called as service_role, and served from the edge Cache API. NOT KV
// writes (the free tier's scarce limit is 1,000 KV writes/day, already near-capped by the
// watcher on live Saturdays), and NOT a per-view live aggregation.
//
// REVEAL TIMING is HYBRID BY CADENCE (owner): Know Her (weekly) shows live, growing HONEST COUNTS
// during the week; NWSL Trivia (daily) reveals only AFTER its day closes (next-day) so it can't be
// spoiled. Percentages layer in once responders ≥ 25; below that, honest counts only (never a bare
// "100%" for player #2). Raw per-user answers stay private — only aggregates are exposed.

interface QuizEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

const GAMES = new Set(["trivia", "knowher"]);
const PERCENT_MIN_N = 25; // show % only at/above this many responders (docs §11b)
const REVEAL_HIDDEN_TTL = 5 * 60; // trivia, still-open day: re-check every 5 min so it flips soon after close
const LIVE_TTL = 15 * 60; // in-flight edition: growing counts, cheap edge refresh
const CLOSED_TTL = 24 * 3600; // a closed edition never changes

/** True once a TRIVIA day-key ("YYYY-MM-DD") is in the past (UTC) — its window is over, so the
 *  community breakdown may be revealed. Know Her is always revealed (live weekly counts). Any
 *  unparseable key fails OPEN to revealed (better to show honest data than to hide it). */
function isRevealed(game: string, editionKey: string, todayUTC: string): boolean {
  if (game !== "trivia") return true;
  const day = editionKey.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return true;
  return day < todayUTC;
}

type DistRow = { question_id: string; selected_index: number; is_correct: boolean; cnt: number };
type SummaryRow = { responders: number; avg_correct: number | null };

async function rpc<T>(env: QuizEnv, fn: string, params: Record<string, unknown>): Promise<T> {
  const base = (env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const r = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!r.ok) throw new Error(`Supabase rpc ${fn} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

/** GET /quiz-results?game=trivia|knowher&edition=<key> → the community distribution for one
 *  edition, edge-cached. Shape:
 *    { game, editionKey, revealed, responders, showPercent, avgCorrect,
 *      questions: [{ questionId, total, correctCount, optionCounts: { "0": n, ... } }] }
 *  When not yet revealed (a still-open Trivia day) → { revealed:false } and nothing else. */
export async function handleQuizResults(url: URL, env: QuizEnv, ctx: ExecutionContext): Promise<Response> {
  const game = (url.searchParams.get("game") ?? "").toLowerCase();
  const edition = url.searchParams.get("edition") ?? "";
  if (!GAMES.has(game)) return new Response(`Unknown game "${game}". Use trivia|knowher.`, { status: 400 });
  if (!edition) return new Response("Missing ?edition=", { status: 400 });
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response("Community results unavailable (backend not configured).", { status: 502 });
  }

  const cache = caches.default;
  const cacheUrl = new URL(url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("game", game);
  cacheUrl.searchParams.set("edition", edition);
  cacheUrl.searchParams.set("cv", "1");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return withStatus(hit, "HIT");

  const todayUTC = new Date().toISOString().slice(0, 10);
  const revealed = isRevealed(game, edition, todayUTC);

  // Not yet revealed → serve a tiny payload (personal score still shows client-side); cache
  // briefly so it flips within minutes of the day closing.
  if (!revealed) {
    const body = jsonResponse({ game, editionKey: edition, revealed: false }, REVEAL_HIDDEN_TTL);
    ctx.waitUntil(cache.put(cacheKey, body.clone()));
    return withStatus(body, "MISS");
  }

  let dist: DistRow[];
  let summary: SummaryRow[];
  try {
    [dist, summary] = await Promise.all([
      rpc<DistRow[]>(env, "quiz_distribution", { p_game: game, p_edition_key: edition }),
      rpc<SummaryRow[]>(env, "quiz_summary", { p_game: game, p_edition_key: edition }),
    ]);
  } catch {
    // A stale copy beats a hard failure; else 502 (the app shows an honest "couldn't load").
    const stale = await cache.match(cacheKey, { ignoreMethod: false });
    return stale ? withStatus(stale, "STALE") : new Response("Community results unavailable.", { status: 502 });
  }

  const responders = Number(summary[0]?.responders ?? 0);
  const avgCorrect = summary[0]?.avg_correct == null ? null : Number(summary[0].avg_correct);

  // Fold the distribution rows into one entry per question.
  const byQ = new Map<string, { total: number; correctCount: number; optionCounts: Record<string, number> }>();
  for (const row of dist) {
    let q = byQ.get(row.question_id);
    if (!q) {
      q = { total: 0, correctCount: 0, optionCounts: {} };
      byQ.set(row.question_id, q);
    }
    const cnt = Number(row.cnt);
    q.total += cnt;
    if (row.is_correct) q.correctCount += cnt;
    const idx = String(row.selected_index);
    q.optionCounts[idx] = (q.optionCounts[idx] ?? 0) + cnt;
  }
  const questions = [...byQ.entries()].map(([questionId, q]) => ({ questionId, ...q }));

  const payload = {
    game,
    editionKey: edition,
    revealed: true,
    responders,
    showPercent: responders >= PERCENT_MIN_N,
    avgCorrect,
    questions,
  };

  // Closed editions never change → long TTL; in-flight → short so counts grow.
  const closed = game === "trivia"; // a revealed trivia day is by definition closed
  const body = jsonResponse(payload, closed ? CLOSED_TTL : LIVE_TTL);
  // Only cache once at least one fan has answered — don't pin an empty distribution.
  if (responders > 0) ctx.waitUntil(cache.put(cacheKey, body.clone()));
  return withStatus(body, "MISS");
}

function jsonResponse(payload: unknown, ttl: number): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` },
  });
}

function withStatus(response: Response, status: "HIT" | "MISS" | "STALE"): Response {
  const r = new Response(response.body, response);
  r.headers.set("X-Cache", status);
  return r;
}
