// Predict the XI — community pick distribution (app redesign 2026-07-28, handoff §2a.6 + §4a.4).
//
// WHAT THE APP READS FROM HERE: how many of a club's predictors picked each player for a match —
// the share bars, the consensus XI, the "biggest hit / biggest miss" cards, and the post-close
// contrarian panel. The app WRITES its picks straight to Supabase (an authenticated SECURITY
// DEFINER RPC that counts, never stores, a lineup); it READS the aggregate from HERE.
//
// ⚠️ THIS ROUTE IS THE DEADLINE GATE, AND IT IS LOAD-BEARING. If the percentages were readable
// while people are still picking, users would copy the consensus and the distribution would
// flatten — destroying the data every other part of the feature depends on. Postgres cannot
// enforce that: it has no idea when kickoff is. This worker does, from its OWN edge-cached
// /summary pass-through, so the gate lives here.
//
// ⚠️ IT FAILS CLOSED, ALWAYS. Unknown kickoff, upstream error, unconfigured backend → sealed.
// Failing open would leak the crowd's XI before the deadline, which is the single thing the gate
// exists to prevent. Every such branch emits a diag (NO SILENT FAILURES) — sealed-because-broken
// and sealed-because-early are indistinguishable to the app, so they must be distinguishable to us.
//
// The `sealed` response carries ONLY the submission count ("312 fans have locked in"), via a
// separate RPC that cannot return per-player data at all — defence in depth for a rule this
// important. See migration_predict_community.sql.
//
// Modeled on quiz-results.ts (SECURITY DEFINER RPC as service_role + edge Cache API, never KV
// writes and never a per-view live aggregation — the Swifties-tour lesson).

interface PredictEnv {
	SUPABASE_URL?: string;
	SUPABASE_SERVICE_ROLE_KEY?: string;
}

interface SummaryLite {
	header?: { competitions?: Array<{ date?: string }> };
}

type EmitDiag = (env: never, ctx: ExecutionContext, kind: string, detail: string) => void;

/** Submissions close at kickoff − 2h — the same rule as `PredictionFixture.deadline` in the app. */
const CLOSE_LEAD_MS = 2 * 3600 * 1000;
/** Batched so a multi-club round is ONE request, not one per club. Capped so a crafted URL can't
 *  fan out into an unbounded number of upstream fetches. */
const MAX_FIXTURES = 6;
const SEALED_TTL = 5 * 60; // re-check often enough that it flips within minutes of the close
const REVEALED_TTL = 24 * 3600; // frozen: submissions are closed, so the numbers cannot change

interface Fixture {
	event: string;
	team: string;
	week: number;
}

interface PickRow {
	playerId: string;
	slot: number;
	count: number;
}

/** `f=<eventId>:<TEAM>:<week>`, repeated. Season is shared across the batch. */
function parseFixtures(url: URL): Fixture[] | null {
	const raw = url.searchParams.getAll("f");
	if (raw.length === 0 || raw.length > MAX_FIXTURES) return null;
	const out: Fixture[] = [];
	for (const entry of raw) {
		const [event, team, week] = entry.split(":");
		if (!/^\d+$/.test(event ?? "")) return null;
		if (!/^[A-Z]{2,4}$/.test(team ?? "")) return null;
		if (!/^\d{1,3}$/.test(week ?? "")) return null;
		out.push({ event, team, week: Number(week) });
	}
	return out;
}

async function rpc<T>(env: PredictEnv, fn: string, params: Record<string, unknown>): Promise<T> {
	const base = (env.SUPABASE_URL ?? "").replace(/\/$/, "");
	const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
	const r = await fetch(`${base}/rest/v1/rpc/${fn}`, {
		method: "POST",
		headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(params),
	});
	if (!r.ok) throw new Error(`Supabase rpc ${fn} → ${r.status} ${await r.text()}`);
	return (await r.json()) as T;
}

/**
 * GET /predict/community?season=2026&f=401853953:WAS:21[&f=...]
 *
 * → { season, fixtures: [{ event, team, week, revealed, closesAt, submissions, picks }] }
 *   `picks` is present ONLY on a revealed fixture; a sealed one carries the count and nothing else.
 *
 * `getSummary` resolves kickoff via this worker's own edge-cached /summary (the byte-identical URL
 * the app itself requests, so it's almost always a warm HIT and adds no ESPN load); `emit` is
 * index.ts's emitDiag. Both injected to keep this module self-contained and testable.
 */
export async function handlePredictCommunity(
	url: URL,
	env: PredictEnv,
	ctx: ExecutionContext,
	getSummary: (eventId: string) => Promise<SummaryLite | null>,
	emit: EmitDiag,
	nowMs: number = Date.now(),
): Promise<Response> {
	const season = url.searchParams.get("season") ?? "";
	if (!/^\d{4}$/.test(season)) return new Response("missing or invalid ?season", { status: 400 });
	const fixtures = parseFixtures(url);
	if (!fixtures) return new Response(`missing or invalid ?f (max ${MAX_FIXTURES})`, { status: 400 });

	// Backend not configured → SEALED, not an error. The app degrades to "no community data yet",
	// which is honest; an error here would surface as a broken screen for a purely optional layer.
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		emit(env as never, ctx, "predictCommunityMisconfig", "missing supabase secrets");
		return json({ season, fixtures: fixtures.map(sealedUnknown) }, SEALED_TTL);
	}

	// Cache key: season + the SORTED fixture list, so the same round requested in any order is one
	// entry rather than a permutation each.
	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.search = "";
	cacheUrl.searchParams.set("season", season);
	for (const f of [...fixtures].sort((a, b) => a.event.localeCompare(b.event) || a.team.localeCompare(b.team))) {
		cacheUrl.searchParams.append("f", `${f.event}:${f.team}:${f.week}`);
	}
	cacheUrl.searchParams.set("cv", "1");
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
	const hit = await cache.match(cacheKey);
	if (hit) return withStatus(hit, "HIT");

	const results = await Promise.all(
		fixtures.map((f) => resolveFixture(f, season, env, ctx, getSummary, emit, nowMs)),
	);

	// One TTL for the batch: the shortest any member wants, so a sealed fixture can't be pinned
	// behind a revealed one's 24h.
	const ttl = Math.max(30, Math.min(...results.map((r) => r.ttl)));
	const body = json({ season, fixtures: results.map((r) => r.payload) }, ttl);
	// Don't pin an empty distribution — an early cache of "0 submissions" would outlive the truth.
	if (results.some((r) => r.payload.submissions > 0)) ctx.waitUntil(cache.put(cacheKey, body.clone()));
	return withStatus(body, "MISS");
}

interface FixturePayload {
	event: string;
	team: string;
	week: number;
	revealed: boolean;
	closesAt: string | null;
	submissions: number;
	picks?: PickRow[];
}

function sealedUnknown(f: Fixture): FixturePayload {
	return { event: f.event, team: f.team, week: f.week, revealed: false, closesAt: null, submissions: 0 };
}

async function resolveFixture(
	f: Fixture,
	season: string,
	env: PredictEnv,
	ctx: ExecutionContext,
	getSummary: (eventId: string) => Promise<SummaryLite | null>,
	emit: EmitDiag,
	nowMs: number,
): Promise<{ payload: FixturePayload; ttl: number }> {
	const params = { p_season: season, p_week: f.week, p_event_id: f.event, p_team: f.team };

	// 1. Kickoff. Only the immutable header date is read — no lineup data, so no `w=near` needed.
	let kickoffMs = NaN;
	try {
		const summary = await getSummary(f.event);
		const date = summary?.header?.competitions?.[0]?.date;
		kickoffMs = date ? Date.parse(date) : NaN;
	} catch {
		kickoffMs = NaN;
	}

	// 2. No kickoff → SEALED. This is the fail-closed branch, and it is flagged loudly: a silent
	//    permanent seal would look exactly like "the deadline hasn't passed yet".
	if (Number.isNaN(kickoffMs)) {
		emit(env as never, ctx, "predictCommunityNoKickoff", `${f.event}:${f.team}`);
		let submissions = 0;
		try {
			submissions = Number(await rpc<number>(env, "predict_submission_count", params)) || 0;
		} catch {
			/* count is optional context; the seal stands regardless */
		}
		return { payload: { ...sealedUnknown(f), submissions }, ttl: SEALED_TTL };
	}

	const closesAtMs = kickoffMs - CLOSE_LEAD_MS;
	const closesAt = new Date(closesAtMs).toISOString();

	// 3. Stamp the authoritative close time so the write RPC can refuse late submissions. Write-once
	//    server-side (coalesce), fire-and-forget, and reached only on a cache MISS — so the cache
	//    bounds this to a handful of calls per fixture per day regardless of how many fans are
	//    reading. This is what makes the counter design's late-write guard trustworthy: the client
	//    never supplies its own deadline.
	ctx.waitUntil(
		rpc(env, "predict_set_close", { ...params, p_closes_at: closesAt }).catch(() =>
			emit(env as never, ctx, "predictCommunitySetCloseFail", `${f.event}:${f.team}`),
		),
	);

	// 4. Before the close → the count ONLY, from an RPC that cannot return picks.
	if (nowMs < closesAtMs) {
		let submissions = 0;
		try {
			submissions = Number(await rpc<number>(env, "predict_submission_count", params)) || 0;
		} catch {
			emit(env as never, ctx, "predictCommunityCountFail", `${f.event}:${f.team}`);
		}
		return {
			payload: { event: f.event, team: f.team, week: f.week, revealed: false, closesAt, submissions },
			// Flip promptly at the close rather than sitting on a stale seal for 5 more minutes.
			ttl: Math.max(30, Math.min(SEALED_TTL, Math.floor((closesAtMs - nowMs) / 1000))),
		};
	}

	// 5. After the close → the full distribution. Frozen, so it caches for a day.
	try {
		const dist = await rpc<{ submissions: number; picks: PickRow[] }>(env, "predict_pick_distribution", params);
		return {
			payload: {
				event: f.event,
				team: f.team,
				week: f.week,
				revealed: true,
				closesAt,
				submissions: Number(dist?.submissions ?? 0),
				picks: Array.isArray(dist?.picks) ? dist.picks : [],
			},
			ttl: REVEALED_TTL,
		};
	} catch {
		// Past the close but the read failed: seal rather than invent. The app hides its
		// community sections, which is honest — it never renders a zero as if it were a fact.
		emit(env as never, ctx, "predictCommunityDistFail", `${f.event}:${f.team}`);
		return {
			payload: { event: f.event, team: f.team, week: f.week, revealed: false, closesAt, submissions: 0 },
			ttl: SEALED_TTL,
		};
	}
}

function json(payload: unknown, ttl: number): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` },
	});
}

function withStatus(response: Response, status: "HIT" | "MISS"): Response {
	const r = new Response(response.body, response);
	r.headers.set("X-Cache", status);
	return r;
}
