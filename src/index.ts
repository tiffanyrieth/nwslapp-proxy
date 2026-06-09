/**
 * nwslapp-proxy — NWSLApp's ESPN caching proxy (V2 milestone 0.2.0).
 *
 * One route: `GET /scoreboard`. It forwards the request to ESPN's unofficial
 * NWSL scoreboard endpoint, caches the response at the edge, and fans out — so
 * one upstream ESPN call serves every app instance ("poll once, fan out").
 *
 * The response body is returned UNCHANGED (transparent pass-through), so the
 * iOS app's existing `Scoreboard` decoder needs zero changes. Normalization is
 * a later milestone. Caching uses the Workers Cache API (no KV namespace), with
 * a dynamic TTL: short while a match is live, longer otherwise.
 *
 * Scope is deliberately tiny: only the scoreboard is proxied here. Teams,
 * roster, and standings still hit ESPN directly from the app for now.
 */

const ESPN_SCOREBOARD =
	"https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard";

// Cache TTLs (seconds). Tight while a game is in progress so live scores stay
// fresh; looser otherwise since the fixture list barely changes between matches.
const LIVE_TTL = 30;
const DEFAULT_TTL = 300;

export default {
	async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Scope guards — this proxy serves exactly one thing.
		if (url.pathname !== "/scoreboard") {
			return new Response("Not found. This proxy serves only GET /scoreboard.", {
				status: 404,
			});
		}
		if (request.method !== "GET") {
			return new Response("Method not allowed. Use GET.", {
				status: 405,
				headers: { Allow: "GET" },
			});
		}

		// Cache key = the incoming URL (query string included), so different
		// `dates`/`limit` combinations are cached independently.
		const cache = caches.default;
		const cacheKey = new Request(url.toString(), { method: "GET" });

		const hit = await cache.match(cacheKey);
		if (hit) {
			return withCacheStatus(hit, "HIT");
		}

		// MISS — forward to ESPN, preserving the incoming query string verbatim.
		const upstream = new URL(ESPN_SCOREBOARD);
		upstream.search = url.search;

		let espnResponse: Response;
		try {
			espnResponse = await fetch(upstream.toString(), {
				headers: { Accept: "application/json" },
			});
		} catch {
			return (await serveStale(cache, cacheKey)) ?? upstreamError();
		}

		if (!espnResponse.ok) {
			return (await serveStale(cache, cacheKey)) ?? upstreamError(espnResponse.status);
		}

		// Read the body once as bytes so we can both cache it and return it
		// unchanged. Peek at the JSON only to pick a TTL — the bytes are untouched.
		const body = await espnResponse.arrayBuffer();
		const ttl = chooseTTL(body);

		const headers = new Headers();
		headers.set(
			"Content-Type",
			espnResponse.headers.get("Content-Type") ?? "application/json",
		);
		headers.set("Cache-Control", `public, max-age=${ttl}`);

		// Store a copy in the edge cache (don't block the response on the write).
		const toCache = new Response(body, { status: 200, headers });
		ctx.waitUntil(cache.put(cacheKey, toCache.clone()));

		return withCacheStatus(toCache, "MISS");
	},
} satisfies ExportedHandler<Env>;

/** Return a clone of `response` with an `X-Proxy-Cache` status header set. */
function withCacheStatus(response: Response, status: "HIT" | "MISS" | "STALE"): Response {
	const out = new Response(response.body, response);
	out.headers.set("X-Proxy-Cache", status);
	return out;
}

/** Serve a stale cached copy if one exists, marked `STALE`; else null. */
async function serveStale(cache: Cache, cacheKey: Request): Promise<Response | null> {
	const stale = await cache.match(cacheKey);
	return stale ? withCacheStatus(stale, "STALE") : null;
}

function upstreamError(status?: number): Response {
	const detail = status ? ` (ESPN returned ${status})` : "";
	return new Response(`Upstream ESPN request failed${detail}.`, { status: 502 });
}

/**
 * Pick a cache TTL by peeking for an in-progress match. ESPN marks each event's
 * state as "pre" | "in" | "post"; any "in" means scores are changing, so cache
 * briefly. If the body isn't the JSON we expect, fall back to the default TTL —
 * the raw bytes are still returned unchanged regardless.
 */
function chooseTTL(body: ArrayBuffer): number {
	try {
		const json = JSON.parse(new TextDecoder().decode(body)) as {
			events?: Array<{
				status?: { type?: { state?: string } };
				competitions?: Array<{ status?: { type?: { state?: string } } }>;
			}>;
		};
		const isLive = (json.events ?? []).some(
			(event) =>
				event.status?.type?.state === "in" ||
				(event.competitions ?? []).some((c) => c.status?.type?.state === "in"),
		);
		return isLive ? LIVE_TTL : DEFAULT_TTL;
	} catch {
		return DEFAULT_TTL;
	}
}
