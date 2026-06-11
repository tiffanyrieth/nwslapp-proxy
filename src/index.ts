/**
 * nwslapp-proxy — NWSLApp's ESPN caching proxy (V2 milestone 0.2.0).
 *
 * Two routes, both transparent caching pass-throughs of ESPN's unofficial NWSL
 * endpoints: `GET /scoreboard` (the full-season fixture list) and `GET /summary`
 * (one match's rich detail, added in 0.3.1). Each forwards to ESPN, caches the
 * response at the edge, and fans out — so one upstream ESPN call serves every
 * app instance ("poll once, fan out").
 *
 * Response bodies are returned UNCHANGED (transparent pass-through), so the iOS
 * app's existing `Scoreboard` / `MatchSummary` decoders need zero changes.
 * Normalization is a later milestone. Caching uses the Workers Cache API (no KV
 * namespace), with a per-route, match-state-aware TTL (see chooseScoreboardTTL /
 * chooseSummaryTTL).
 *
 * Scope is still deliberately tiny: teams, roster, and standings continue to hit
 * ESPN directly from the app.
 */

const ESPN_SCOREBOARD =
	"https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard";
const ESPN_SUMMARY =
	"https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/summary";

// Cache TTLs (seconds).
const LIVE_TTL = 30; // a match is in progress — keep scores/lineups fresh
const SCOREBOARD_DEFAULT_TTL = 300; // fixture list barely changes between matches
const SUMMARY_DEFAULT_TTL = 3600; // 1hr — safe fallback when summary state can't be read
const IMMUTABLE_TTL = 31536000; // 1yr — a finished match's data is final, cache ~forever
const TEAM_VIDEOS_TTL = 3600; // 1hr — a club's recent uploads change at most a few times/day

const YT_API = "https://www.googleapis.com/youtube/v3";
const UPLOADS_PER_TEAM = 5; // recent uploads to pull per club (the app filters/caps)

// One verified video id per club, used only to RESOLVE the club's YouTube channel
// at runtime: videos.list(part=snippet) → snippet.channelId → uploads playlist
// ("UU" + channelId without its "UC" prefix). Reusing ids the app's seed already
// verified means no separate channel-id research, and the whole response is cached
// ~1h so this resolution is cheap. (If a seed video is deleted, that club silently
// yields no live cards until re-seeded — graceful, not fatal. A future tidy could
// bake in the resolved channel ids to drop this call.)
const TEAM_SEED_VIDEO: Record<string, string> = {
	LA: "bs3r9AbiAxk", BAY: "FCt8ZY3xocY", BOS: "fnwgebaTb9k", CHI: "dLiMB5XM8U4",
	DEN: "p0cvf5-1h3Y", GFC: "xx8slc-q3s0", HOU: "khgdvraSRkY", KC: "cJMSF_oajX0",
	NC: "j5NcGy3_WQc", ORL: "gxFfPHB0hxU", POR: "_37ruj00IQw", LOU: "h_upJQCPFDU",
	SD: "qI3vFXoOEQk", SEA: "1JwgDxClwPA", UTA: "CzlPKyGe1eI", WAS: "IdSPrFaTxco",
};

// Per-club article URLs from each club's OWN site, surfaced on Home as NEWS cards
// (diversifies Home beyond YouTube). Each URL is fetched and its Open Graph
// metadata (og:title / og:description / og:image / article:published_time) is
// scraped into a `newsArticle` ContentCard — the iMessage/Slack link-preview
// model. `source` is the club display name on the card (→ crest).
//
// TEMP curated list, OG-fetched LIVE so titles/images stay real. Auto-discovery
// is a later step and easy here: club sites mostly run WordPress, so `/feed/`
// (RSS) and `/wp-json/wp/v2/posts` are open + keyless (verified on
// washingtonspirit.com). Only WAS for now.
const TEAM_ARTICLES: Record<string, Array<{ url: string; source: string }>> = {
	WAS: [
		{
			url: "https://washingtonspirit.com/blog/2026/06/09/washington-spirit-star-trinity-rodman-and-owner-michele-kang-named-to-inaugural-time100-sports-list/",
			source: "Washington Spirit",
		},
	],
};

// A desktop-browser UA so article fetches get the full SSR'd HTML (with OG tags)
// rather than a stripped bot page.
const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// Bluesky AT Protocol PUBLIC API (keyless, no auth) — backs the Feed's
// reporter/league/team posts (and the team voices merged onto Home).
const BSKY_PUBLIC = "https://public.api.bsky.app/xrpc";
const BSKY_UA = "nwslapp-proxy/0.3 (+https://nwslapp-proxy.tiffany-rieth.workers.dev)";
const FEED_TTL = 900; // 15min — the Feed is conversational, fresher than Home's 1h
const POSTS_PER_HANDLE = 12; // recent posts pulled per account (app applies staleness)

// Curated, API-VERIFIED Bluesky handles for the Feed (and the team voices merged
// onto Home). Every handle was confirmed to currently return posts from the keyless
// public AT-Proto API; dead/dormant candidates were dropped (GFC + BAY have no
// active club account, DEN's is off-season-dormant — so 13 of 16 clubs). `kind`
// drives layout + placement:
//   reporter|league → blueskyReporter, placement "feed", isLeague true
//   team            → blueskyTeam{Media,Text}, placement "both" (Home + Feed),
//                     tagged with `abbr` (the app's club join key)
interface FeedHandle {
	handle: string;
	kind: "reporter" | "league" | "team";
	abbr?: string;
}
const FEED_HANDLES: FeedHandle[] = [
	// Reporters / journalists (league-wide)
	{ handle: "meglinehan.com", kind: "reporter" },
	{ handle: "jeffkassouf.bsky.social", kind: "reporter" },
	{ handle: "sandraherrera.bsky.social", kind: "reporter" },
	{ handle: "pcattry.bsky.social", kind: "reporter" },
	{ handle: "katiewhyatt.bsky.social", kind: "reporter" },
	// League / official outlets
	{ handle: "nwslsoccer.com", kind: "league" },
	{ handle: "equalizersoccer.bsky.social", kind: "league" },
	{ handle: "nwslthisweek.bsky.social", kind: "league" },
	{ handle: "nwslstat.bsky.social", kind: "league" },
	{ handle: "allforxi.bsky.social", kind: "league" },
	// Official club accounts (13 of 16 verified active)
	{ handle: "angelcity.com", kind: "team", abbr: "LA" },
	{ handle: "bostonlegacyfc.com", kind: "team", abbr: "BOS" },
	{ handle: "chicagostars.com", kind: "team", abbr: "CHI" },
	{ handle: "houstondash.com", kind: "team", abbr: "HOU" },
	{ handle: "thekccurrent.bsky.social", kind: "team", abbr: "KC" },
	{ handle: "racingloufc.com", kind: "team", abbr: "LOU" },
	{ handle: "nccourage.com", kind: "team", abbr: "NC" },
	{ handle: "orlpride.com", kind: "team", abbr: "ORL" },
	{ handle: "thornsfc.com", kind: "team", abbr: "POR" },
	{ handle: "sandiegowavefc.com", kind: "team", abbr: "SD" },
	{ handle: "reignfc.com", kind: "team", abbr: "SEA" },
	{ handle: "utahroyalsfc.com", kind: "team", abbr: "UTA" },
	{ handle: "washingtonspirit.com", kind: "team", abbr: "WAS" },
];

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// All routes are GET-only; reject early so the 405 is shared.
		if (request.method !== "GET") {
			return new Response("Method not allowed. Use GET.", {
				status: 405,
				headers: { Allow: "GET" },
			});
		}

		// The two ESPN routes are transparent caching pass-throughs (shared
		// proxyAndCache). /team-videos is different: it *builds* a response by
		// calling the YouTube Data API and normalizing to ContentCard JSON.
		if (url.pathname === "/scoreboard") {
			return proxyAndCache(url, ESPN_SCOREBOARD, chooseScoreboardTTL, ctx);
		}
		if (url.pathname === "/summary") {
			// Missing `?event=` isn't validated here — forwarded verbatim, letting
			// ESPN return its own error, exactly as scoreboard doesn't police
			// `dates`/`limit`.
			return proxyAndCache(url, ESPN_SUMMARY, chooseSummaryTTL, ctx);
		}
		if (url.pathname === "/team-videos") {
			return handleTeamVideos(url, env, ctx);
		}
		if (url.pathname === "/feed") {
			return handleFeed(url, ctx);
		}

		return new Response(
			"Not found. This proxy serves GET /scoreboard, /summary, /team-videos, and /feed.",
			{ status: 404 },
		);
	},
} satisfies ExportedHandler<Env>;

/**
 * The shared caching pass-through. Checks the edge cache, and on a MISS forwards
 * the incoming query string verbatim to `upstreamBase`, caches the bytes with a
 * TTL from `chooseTTL`, and returns them unchanged. On an upstream failure it
 * serves a stale copy if one exists, else a 502.
 */
async function proxyAndCache(
	url: URL,
	upstreamBase: string,
	chooseTTL: (body: ArrayBuffer) => number,
	ctx: ExecutionContext,
): Promise<Response> {
	// Cache key = the incoming URL (query string included), so different
	// `dates`/`limit` or `event` values are cached independently.
	const cache = caches.default;
	const cacheKey = new Request(url.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) {
		return withCacheStatus(hit, "HIT");
	}

	// MISS — forward to ESPN, preserving the incoming query string verbatim.
	const upstream = new URL(upstreamBase);
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
}

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
 * Scoreboard TTL: peek for an in-progress match. ESPN marks each event's state
 * as "pre" | "in" | "post"; any "in" means scores are changing, so cache
 * briefly. If the body isn't the JSON we expect, fall back to the default TTL —
 * the raw bytes are still returned unchanged regardless.
 */
function chooseScoreboardTTL(body: ArrayBuffer): number {
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
		return isLive ? LIVE_TTL : SCOREBOARD_DEFAULT_TTL;
	} catch {
		return SCOREBOARD_DEFAULT_TTL;
	}
}

/**
 * Summary TTL: one match, so the state lives at a single path —
 * `header.competitions[0].status.type.state` (NOT the scoreboard's
 * `events[].status…`). Finished matches never change → cache ~forever; live →
 * 30s; future → once-daily (season-average preview data only shifts after other
 * matches finish). Parse failure → safe 1hr default.
 */
export function chooseSummaryTTL(body: ArrayBuffer): number {
	try {
		const json = JSON.parse(new TextDecoder().decode(body)) as {
			header?: {
				competitions?: Array<{ status?: { type?: { state?: string } } }>;
			};
		};
		const state = json.header?.competitions?.[0]?.status?.type?.state;
		switch (state) {
			case "post":
				return IMMUTABLE_TTL;
			case "in":
				return LIVE_TTL;
			case "pre":
				return secondsUntilDailyRefresh();
			default:
				return SUMMARY_DEFAULT_TTL;
		}
	} catch {
		return SUMMARY_DEFAULT_TTL;
	}
}

/**
 * Seconds until the next daily cache refresh — 07:00 UTC. Future-match preview
 * data (both teams' season averages) only shifts once the day's other matches are
 * final; a west-coast 7pm PT kickoff ends ~1am ET (~05:00 UTC), so 07:00 UTC sits
 * just after the last possible game wraps and converges every future-match cache
 * on one daily refresh.
 *
 * 07:00 UTC is 03:00 US Eastern during the NWSL season (EDT, UTC−4, in effect
 * Mar–Nov) — so this keeps the original "3am ET, after the games settle" intent,
 * but as plain UTC arithmetic with no timezone string-reparse or DST math. The lone
 * edge is a late-season EST date, where 07:00 UTC is 02:00 ET — still early morning,
 * still after games settle, harmless for a once-daily cache. 60s floor avoids a
 * near-zero TTL right at the boundary.
 */
const REFRESH_HOUR_UTC = 7;

function secondsUntilDailyRefresh(): number {
	const now = Date.now();
	const target = new Date(now);
	target.setUTCHours(REFRESH_HOUR_UTC, 0, 0, 0);
	if (target.getTime() <= now) target.setUTCDate(target.getUTCDate() + 1);
	return Math.max(Math.floor((target.getTime() - now) / 1000), 60);
}

// ---------------------------------------------------------------------------
// /team-videos — Home Module 1 "From your teams" (the first ALIVE pipeline).
//
// `GET /team-videos?teams=WAS,POR,…` returns each followed club's recent YouTube
// uploads as `ContentCard` JSON (the app decodes it directly — see the iOS
// `ContentCard` model + `ContentService`). Unlike the ESPN routes this NORMALIZES:
// it resolves each club's uploads playlist, pulls recent videos via the YouTube
// Data API, and maps them to the card shape. The whole response is edge-cached ~1h
// (keyed by the normalized, sorted team list), so one build serves every caller and
// quota use stays trivial.
// ---------------------------------------------------------------------------

/** Minimal shapes for the YouTube Data API responses we read. */
interface YTSnippet {
	title?: string;
	publishedAt?: string;
	channelId?: string;
	resourceId?: { videoId?: string };
}
interface YTItem {
	id?: string;
	snippet?: YTSnippet;
	contentDetails?: { duration?: string };
}

async function handleTeamVideos(
	url: URL,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const teams = normalizeTeams(url.searchParams.get("teams"));

	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.searchParams.set("teams", teams.join(","));
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	if (!env.YOUTUBE_API_KEY) {
		// Misconfiguration (secret not set) — 503 so the app falls back to its seed.
		return new Response("team-videos unavailable: YOUTUBE_API_KEY not set.", {
			status: 503,
		});
	}

	let cards: unknown[];
	try {
		// YouTube uploads + club-site news (OG) + the club's own Bluesky posts
		// (placement "both" → also shown in the Feed), merged newest-first. Articles
		// and Bluesky are best-effort (neither builder throws); only a YouTube outage
		// trips the stale/502 fallback below.
		const [videos, articles, teamPosts] = await Promise.all([
			buildTeamCards(teams, env.YOUTUBE_API_KEY),
			buildArticleCards(teams),
			buildTeamBlueskyCards(teams),
		]);
		cards = [...videos, ...articles, ...teamPosts].sort(byTimestampDesc);
	} catch {
		// A YouTube outage serves a stale copy if we have one, else 502 (the app
		// falls back to its seed on any non-2xx).
		return (await serveStale(cache, cacheKey)) ?? upstreamError();
	}

	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", `public, max-age=${TEAM_VIDEOS_TTL}`);

	const toCache = new Response(JSON.stringify(cards), { status: 200, headers });
	ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
	return withCacheStatus(toCache, "MISS");
}

/** Build the `ContentCard` array for the requested clubs (newest first). */
async function buildTeamCards(teams: string[], apiKey: string): Promise<unknown[]> {
	// Only clubs we have a seed video for can be resolved.
	const known = teams.filter((t) => TEAM_SEED_VIDEO[t]);
	if (known.length === 0) return [];

	// 1. Resolve each club's channel → uploads playlist (one batched call).
	const seedSnippets = await ytVideos(known.map((t) => TEAM_SEED_VIDEO[t]), "snippet", apiKey);
	const channelByVideo = new Map<string, string>();
	for (const v of seedSnippets) {
		if (v.id && v.snippet?.channelId) channelByVideo.set(v.id, v.snippet.channelId);
	}
	const uploadsByTeam = new Map<string, string>();
	for (const abbr of known) {
		const channelId = channelByVideo.get(TEAM_SEED_VIDEO[abbr]);
		// A channel's uploads playlist id is its channel id with "UC" → "UU".
		if (channelId && channelId.startsWith("UC")) {
			uploadsByTeam.set(abbr, "UU" + channelId.slice(2));
		}
	}

	// 2. Recent uploads per club, in parallel (one playlistItems call each). A
	//    single club failing drops only its own cards.
	const perTeam = await Promise.all(
		[...uploadsByTeam.entries()].map(async ([abbr, playlist]) => {
			try {
				const items = await ytPlaylistItems(playlist, UPLOADS_PER_TEAM, apiKey);
				return items
					.filter((it) => it.snippet?.resourceId?.videoId)
					.map((it) => ({ abbr, snippet: it.snippet as YTSnippet }));
			} catch {
				return [];
			}
		}),
	);
	const uploads = perTeam.flat();
	if (uploads.length === 0) return [];

	// 3. Durations (one batched call; optional — a failure just omits them).
	const durationById = new Map<string, string>();
	try {
		const details = await ytVideos(
			uploads.map((u) => u.snippet.resourceId!.videoId!),
			"contentDetails",
			apiKey,
		);
		for (const v of details) {
			const formatted = formatDuration(v.contentDetails?.duration);
			if (v.id && formatted) durationById.set(v.id, formatted);
		}
	} catch {
		/* durations are optional */
	}

	// 4. Map to ContentCard JSON. `undefined` fields are dropped by JSON.stringify,
	//    which the Swift decoder reads as nil. Newest first.
	return uploads
		.map((u) => {
			const vid = u.snippet.resourceId!.videoId!;
			return {
				id: `yt-${vid}`,
				layout: "youtube",
				platform: "youtube",
				placement: "home",
				teamAbbreviation: u.abbr,
				isLeague: false,
				title: u.snippet.title,
				thumbnailURL: `https://img.youtube.com/vi/${vid}/hqdefault.jpg`,
				duration: durationById.get(vid),
				igFallback: false,
				timestamp: u.snippet.publishedAt,
				url: `https://www.youtube.com/watch?v=${vid}`,
				ctaLabel: "Watch on YouTube",
			};
		})
		.sort((a, b) => (a.timestamp ?? "") < (b.timestamp ?? "") ? 1 : -1);
}

/** Just the field the merged-sort needs off a built card. */
type Card = { timestamp?: string };

/**
 * League-news cards for the requested clubs: fetch each curated nwslsoccer.com
 * article and scrape its Open Graph tags into a `newsArticle` ContentCard.
 * Best-effort — a fetch or a missing title drops only that one card (never
 * throws), so a news hiccup can't take down the YouTube cards it's merged with.
 */
async function buildArticleCards(teams: string[]): Promise<unknown[]> {
	const jobs: Array<{ abbr: string; url: string; source: string }> = [];
	for (const abbr of teams) {
		for (const a of TEAM_ARTICLES[abbr] ?? []) jobs.push({ abbr, url: a.url, source: a.source });
	}
	if (jobs.length === 0) return [];

	const built = await Promise.all(
		jobs.map(async ({ abbr, url, source }) => {
			try {
				const og = await fetchOG(url);
				// `timestamp` is required app-side; skip a card we can't date rather
				// than fake a time (would mis-sort it to "now").
				const published = isoNoFraction(og.published);
				if (!og.title || !published) return null;
				return {
					id: `nws-${url.split("/").filter(Boolean).pop()}`, // slug = stable id
					layout: "newsArticle",
					platform: "article",
					placement: "home",
					teamAbbreviation: abbr,
					isLeague: false,
					headline: og.title,
					blurb: og.description, // undefined → nil (e.g. generic site default)
					sourceName: source,
					thumbnailURL: og.image,
					igFallback: false,
					timestamp: published,
					url,
					ctaLabel: "Read more",
				};
			} catch {
				return null;
			}
		}),
	);
	return built.filter(Boolean);
}

/** Normalize any ISO-ish date to "YYYY-MM-DDTHH:MM:SSZ" — no fractional seconds,
 *  no numeric offset — the one shape the app's strict `.iso8601` JSON decoder
 *  accepts (sources vary: YouTube emits "…Z", nwslsoccer ".337Z", WordPress
 *  "+00:00"). Returns undefined for an unparseable input. */
function isoNoFraction(s?: string): string | undefined {
	if (!s) return undefined;
	const t = Date.parse(s);
	if (Number.isNaN(t)) return undefined;
	return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Scrape an article page's Open Graph metadata (title/description/image) + the
 *  `article:published_time`. */
async function fetchOG(
	url: string,
): Promise<{ title?: string; description?: string; image?: string; published?: string }> {
	const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } });
	if (!r.ok) throw new Error(`og fetch ${r.status}`);
	const html = await r.text();

	const meta = (prop: string): string | undefined => {
		const m = new RegExp(`<meta property="${prop}" content="([^"]*)"`, "i").exec(html);
		return m ? decodeEntities(m[1]) : undefined;
	};

	return {
		title: meta("og:title")?.trim(),
		description: meta("og:description"),
		image: meta("og:image"),
		published: meta("article:published_time"),
	};
}

/** Decode the handful of HTML entities OG `content` attrs carry (e.g. `&#x27;`). */
function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

/** videos.list for the given ids + part, chunked at the API's 50-id limit. */
async function ytVideos(ids: string[], part: string, apiKey: string): Promise<YTItem[]> {
	const out: YTItem[] = [];
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		const u = new URL(`${YT_API}/videos`);
		u.searchParams.set("part", part);
		u.searchParams.set("id", chunk.join(","));
		u.searchParams.set("maxResults", "50");
		u.searchParams.set("key", apiKey);
		const r = await fetch(u.toString());
		if (!r.ok) throw new Error(`videos.list ${r.status}`);
		const json = (await r.json()) as { items?: YTItem[] };
		out.push(...(json.items ?? []));
	}
	return out;
}

/** playlistItems.list for one uploads playlist, newest first. */
async function ytPlaylistItems(
	playlistId: string,
	maxResults: number,
	apiKey: string,
): Promise<YTItem[]> {
	const u = new URL(`${YT_API}/playlistItems`);
	u.searchParams.set("part", "snippet");
	u.searchParams.set("playlistId", playlistId);
	u.searchParams.set("maxResults", String(maxResults));
	u.searchParams.set("key", apiKey);
	const r = await fetch(u.toString());
	if (!r.ok) throw new Error(`playlistItems.list ${r.status}`);
	const json = (await r.json()) as { items?: YTItem[] };
	return json.items ?? [];
}

/** ISO-8601 duration ("PT4M12S") → a display label ("4:12" / "1:02:03"). */
function formatDuration(iso?: string): string | undefined {
	if (!iso) return undefined;
	const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
	if (!m) return undefined;
	const h = Number(m[1] ?? 0);
	const min = Number(m[2] ?? 0);
	const s = Number(m[3] ?? 0);
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

// ---------------------------------------------------------------------------
// Shared content helpers (used by both /team-videos and /feed).
// ---------------------------------------------------------------------------

/** Normalize a `teams` query value → upper-cased, de-duped, SORTED abbreviations,
 *  so different follow orderings share one cache entry. */
function normalizeTeams(raw: string | null): string[] {
	return [
		...new Set(
			(raw ?? "")
				.split(",")
				.map((t) => t.trim().toUpperCase())
				.filter(Boolean),
		),
	].sort();
}

/** Sort built ContentCards newest-first by their ISO `timestamp` string. */
function byTimestampDesc(a: unknown, b: unknown): number {
	return ((a as Card).timestamp ?? "") < ((b as Card).timestamp ?? "") ? 1 : -1;
}

// ---------------------------------------------------------------------------
// /feed — the Feed tab's live source (A2: Bluesky). `GET /feed?teams=WAS,POR,…`
// returns reporter + league + followed-team Bluesky posts as ContentCard JSON.
// Reporter/league cards are league-wide (always returned); team cards are scoped
// to the requested clubs and carry placement "both" so they ALSO surface on Home.
// (Reddit + news RSS extend this same route in later steps.) Edge-cached 15min,
// keyed by the normalized, sorted team list — like /team-videos.
// ---------------------------------------------------------------------------
async function handleFeed(url: URL, ctx: ExecutionContext): Promise<Response> {
	const teams = normalizeTeams(url.searchParams.get("teams"));

	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.searchParams.set("teams", teams.join(","));
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let cards: unknown[];
	try {
		// Reporter/league (always) + the requested clubs' own posts, newest-first.
		// Both builders isolate per-handle failures, so a single dead account can't
		// trip the stale/502 fallback — that's reserved for a total Bluesky outage.
		const [reporters, teamPosts] = await Promise.all([
			buildReporterLeagueCards(),
			buildTeamBlueskyCards(teams),
		]);
		cards = [...reporters, ...teamPosts].sort(byTimestampDesc);
	} catch {
		return (await serveStale(cache, cacheKey)) ?? upstreamError();
	}

	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", `public, max-age=${FEED_TTL}`);

	const toCache = new Response(JSON.stringify(cards), { status: 200, headers });
	ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
	return withCacheStatus(toCache, "MISS");
}

/** Reporter + league Bluesky posts (always league-wide; blueskyReporter layout). */
async function buildReporterLeagueCards(): Promise<unknown[]> {
	const handles = FEED_HANDLES.filter((h) => h.kind === "reporter" || h.kind === "league");
	const per = await Promise.all(handles.map((h) => blueskyCardsFor(h)));
	return per.flat();
}

/** A followed club's own Bluesky posts (placement "both" → Home + Feed). Empty
 *  when no teams are requested or none of them have a curated handle. */
async function buildTeamBlueskyCards(teams: string[]): Promise<unknown[]> {
	if (teams.length === 0) return [];
	const wanted = new Set(teams);
	const handles = FEED_HANDLES.filter((h) => h.kind === "team" && h.abbr && wanted.has(h.abbr));
	const per = await Promise.all(handles.map((h) => blueskyCardsFor(h)));
	return per.flat();
}

/** Fetch one account's recent OWN posts (reposts dropped) and map them to
 *  ContentCards. A single handle failing yields [] — isolated like /team-videos'
 *  per-team try/catch — so one dead account never sinks the whole response. */
async function blueskyCardsFor(h: FeedHandle): Promise<unknown[]> {
	try {
		const feed = await bskyAuthorFeed(h.handle, POSTS_PER_HANDLE);
		return feed
			// A repost carries a `reason`; drop it so we don't attribute someone
			// else's post to this account. Also require post text.
			.filter((it) => !it.reason && it.post?.record?.text)
			.map((it) => mapBskyPost(it.post as BskyPost, h))
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** Minimal shapes for the AT-Proto getAuthorFeed response we read. */
interface BskyItem {
	reason?: unknown;
	post?: BskyPost;
}
interface BskyPost {
	uri?: string;
	author?: { handle?: string; displayName?: string };
	record?: { text?: string; createdAt?: string };
	embed?: { $type?: string; [k: string]: unknown };
	likeCount?: number;
	repostCount?: number;
}

/** getAuthorFeed for one actor, recent own-and-repost posts (we filter reposts). */
async function bskyAuthorFeed(actor: string, limit: number): Promise<BskyItem[]> {
	const u = new URL(`${BSKY_PUBLIC}/app.bsky.feed.getAuthorFeed`);
	u.searchParams.set("actor", actor);
	u.searchParams.set("limit", String(limit));
	u.searchParams.set("filter", "posts_no_replies");
	const r = await fetch(u.toString(), {
		headers: { "User-Agent": BSKY_UA, Accept: "application/json" },
	});
	if (!r.ok) throw new Error(`bsky getAuthorFeed ${r.status}`);
	const json = (await r.json()) as { feed?: BskyItem[] };
	return json.feed ?? [];
}

/** One Bluesky post → ContentCard JSON. Returns null for a post we can't key or
 *  date (skip rather than emit a card that would mis-sort to "now"). `undefined`
 *  fields are dropped by JSON.stringify, which the Swift decoder reads as nil. */
function mapBskyPost(post: BskyPost, h: FeedHandle): unknown | null {
	const uri = post.uri;
	const handle = post.author?.handle;
	// Bluesky emits fractional-second ISO ("…653Z"); the app's strict .iso8601
	// decoder rejects that, so normalize to "…Z" (the exact bug that silently
	// drops a whole batch to seed — see live-feed-plan "Finding").
	const created = isoNoFraction(post.record?.createdAt);
	if (!uri || !handle || !created) return null;

	const rkey = uri.split("/").pop();
	const image = extractBskyImage(post.embed);
	const isTeam = h.kind === "team";
	const layout = isTeam ? (image ? "blueskyTeamMedia" : "blueskyTeamText") : "blueskyReporter";

	return {
		id: `bsky-${rkey}`,
		layout,
		platform: "bluesky",
		placement: isTeam ? "both" : "feed",
		teamAbbreviation: isTeam ? h.abbr : undefined,
		isLeague: !isTeam, // reporters + league outlets are league-wide
		authorName: post.author?.displayName || handle,
		handle: `@${handle}`,
		bodyText: post.record?.text,
		thumbnailURL: image,
		igFallback: false,
		likes: post.likeCount,
		reposts: post.repostCount,
		timestamp: created,
		url: `https://bsky.app/profile/${handle}/post/${rkey}`,
		ctaLabel: "View on Bluesky",
	};
}

/** Best preview image off a post embed (images → video thumb → external link
 *  card → recordWithMedia's media). Undefined when there's nothing visual. */
function extractBskyImage(embed?: { $type?: string; [k: string]: unknown }): string | undefined {
	if (!embed) return undefined;
	switch (embed.$type) {
		case "app.bsky.embed.images#view": {
			const imgs = embed.images as Array<{ thumb?: string }> | undefined;
			return imgs?.[0]?.thumb;
		}
		case "app.bsky.embed.video#view":
			return embed.thumbnail as string | undefined;
		case "app.bsky.embed.external#view": {
			const ext = embed.external as { thumb?: string } | undefined;
			return ext?.thumb;
		}
		case "app.bsky.embed.recordWithMedia#view":
			return extractBskyImage(embed.media as { $type?: string } | undefined);
		default:
			return undefined;
	}
}
