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

// Claude Haiku relevance filter (Step 2). Runs on REPORTER posts only — they're
// journalists who also post about other sports, their personal life, etc., so we
// keep just the NWSL/women's-soccer ones. League outlets + club accounts are
// NWSL-dedicated and never touch the API. Each reporter post is tagged ONCE
// (verdict cached in KV by post id, ~7d); only never-seen posts hit Haiku on a
// miss. Fails OPEN — no key or a Haiku outage degrades to the un-gated feed.
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = "claude-haiku-4-5";
const HAIKU_BATCH = 20; // posts per Haiku call (one numbered list → array of verdicts)
const TAG_TTL = 7 * 24 * 3600; // a post's verdict is stable; cache it a week
const MAX_PER_HANDLE = 3; // free anti-flood cap: keep at most N posts per account

const FEED_POLICY = `You are a relevance filter for an NWSL (US National Women's Soccer League) fan-app feed. These posts come from soccer JOURNALISTS who also post about unrelated topics. For each post decide isNWSL:
- true: about NWSL or women's soccer — its clubs, players, matches, transfers, results, or reporting/analysis/commentary on them.
- false: off-topic — other sports, the author's personal life, or unrelated news.
Keep normal soccer opinion and match reactions (those are true). When unsure, prefer true.`;

// Forced structured output (output_config.format) — Haiku 4.5 returns the first
// text block as JSON matching this schema. No min/max constraints (unsupported);
// additionalProperties:false is required on every object.
const VERDICT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		verdicts: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					isNWSL: { type: "boolean" },
				},
				required: ["id", "isNWSL"],
			},
		},
	},
	required: ["verdicts"],
};

// ---------------------------------------------------------------------------
// Per-outlet RSS → Feed "News" chip (B1). A keyless, free pipe: pull each curated
// women's-soccer outlet's OWN RSS (real publisher URLs + description + image),
// Haiku-gate to drop non-NWSL items, tag the keepers to NWSL team(s), and OG-scrape
// the real URL to fill any missing image/blurb. (We moved off Google News: it hides
// the real article URL behind an encrypted redirect, so its links can't be
// OG-scraped for a thumbnail/summary.) Distinct from the club-site OG news on Home
// (buildArticleCards) — that's placement "home"; these are placement "feed".
// ---------------------------------------------------------------------------

// Owner-curated per-outlet RSS feeds (replaces the old Google-News-aggregator
// approach: Google hides the real article URL behind an encrypted redirect, so we
// couldn't OG-scrape a blurb/image off it. These feeds carry REAL publisher URLs
// + a description, some with an image — so cards get a summary + thumbnail and a
// tap-out straight to the source). The feed list IS the allowlist now. Adjust
// freely. (Quality bar: dedicated women's-soccer desks. Some feeds — JWS, the
// Guardian — also carry non-NWSL women's sport / WSL / men's content, so every
// item still runs the Haiku isNWSL gate below to drop off-topic pieces.)
interface NewsFeed {
	url: string;
	source: string; // display name on the card
}
const NEWS_FEEDS: NewsFeed[] = [
	{ url: "https://equalizersoccer.com/feed/", source: "The Equalizer" },
	{ url: "https://justwomenssports.com/feed/", source: "Just Women's Sports" },
	{ url: "https://www.allforxi.com/rss/index.xml", source: "All For XI" }, // Atom (SB Nation)
	{ url: "https://www.theguardian.com/football/womensfootball/rss", source: "The Guardian" },
];

// The 16 app club abbreviations — Haiku tags each article to a subset of these
// (or none → league-wide). Must match the app's club join keys exactly.
const NEWS_TEAM_ABBRS = [
	"LA", "BAY", "BOS", "CHI", "DEN", "GFC", "HOU", "KC",
	"NC", "ORL", "POR", "LOU", "SD", "SEA", "UTA", "WAS",
];
const NEWS_TEAM_ABBR_SET = new Set(NEWS_TEAM_ABBRS);

const NEWS_POLICY = `You are filtering and tagging news articles for an NWSL (US National Women's Soccer League) fan app. The articles come from women's-soccer outlets whose feeds also carry non-NWSL items (other women's sports like the PWHL/WNBA, the English WSL or other foreign leagues, men's soccer, general news).

For each article (headline + outlet) decide two things:
1. "isNWSL": true ONLY if the article is primarily about the NWSL — an NWSL club, an NWSL match/standing/award, a player at an NWSL club, a transfer INTO or OUT OF an NWSL club, or the US women's national team (USWNT). false for everything else, INCLUDING women's soccer that isn't NWSL: a foreign league (England's WSL, Spain's Liga F, the UEFA Women's Champions League, etc.), players moving between two non-NWSL clubs, other sports (PWHL, WNBA), and men's soccer. When the headline centers a foreign league or a non-NWSL transfer, isNWSL is false even though it's women's soccer.
2. "teams": if isNWSL, the NWSL club abbreviation(s) it is primarily about; [] for league-wide/general NWSL or USWNT news. If isNWSL is false, return [].

The 16 NWSL teams and their abbreviations:
LA = Angel City FC, BAY = Bay FC, BOS = Boston, CHI = Chicago Stars, DEN = Denver, GFC = Gotham FC, HOU = Houston Dash, KC = Kansas City Current, NC = North Carolina Courage, ORL = Orlando Pride, POR = Portland Thorns, LOU = Racing Louisville, SD = San Diego Wave, SEA = Seattle Reign, UTA = Utah Royals, WAS = Washington Spirit.

Rules: a single-team article → exactly that one abbreviation; a multi-team article (match naming two clubs, a transfer between clubs) → all clubs named; league-wide NWSL news → []. Only use the 16 abbreviations above. Echo each article's id exactly.`;

// Forced structured output — carries the NWSL relevance gate + the tagged teams.
const NEWS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		verdicts: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					isNWSL: { type: "boolean" },
					teams: { type: "array", items: { type: "string" } },
				},
				required: ["id", "isNWSL", "teams"],
			},
		},
	},
	required: ["verdicts"],
};

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
			return handleFeed(url, env, ctx);
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
		cards = dedupeByContent([...videos, ...articles, ...teamPosts].sort(byTimestampDesc));
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

// ---------------------------------------------------------------------------
// Google News RSS → newsArticle cards (Feed "News" chip, B1).
// ---------------------------------------------------------------------------

/** A Google News RSS <item>, parsed to the fields we use. The Google `<link>` is a
 *  news.google.com redirect (resolves to the publisher in a browser); the real
 *  publisher domain is on `<source url="…">`. */
export interface NewsItem {
	title: string;
	link: string; // REAL publisher article URL (tap-out target)
	pubDate?: string;
	description?: string; // plain-text blurb (HTML stripped)
	image?: string; // best in-feed image, if the feed carries one
}

/** Parse a feed (RSS 2.0 *or* Atom) → items carrying the REAL article link, a
 *  plain-text description, and an in-feed image when present. Outlets differ:
 *  WordPress/Guardian emit RSS 2.0 (<item>, <link>URL</link>, <pubDate>); SB Nation
 *  (AllForXI) emits Atom (<entry>, <link href="…"/>, <published>, <content>).
 *  Regex-based (no XML lib), same posture as fetchOG's meta scraping. */
export function parseOutletRSS(xml: string): NewsItem[] {
	const items: NewsItem[] = [];
	const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/g) ?? [];
	for (const block of blocks) {
		const tag = (name: string): string | undefined => {
			const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
			if (!m) return undefined;
			const inner = m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
			return inner || undefined;
		};
		const title = tag("title");
		// RSS: <link>URL</link>. Atom: <link rel="alternate" href="URL"/> (or first href).
		let link = tag("link");
		if (!link) {
			const m =
				/<link[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/i.exec(block) ??
				/<link[^>]*\bhref="([^"]+)"/i.exec(block);
			link = m ? m[1] : undefined;
		}
		if (!title || !link) continue;
		const descRaw =
			tag("description") ?? tag("content:encoded") ?? tag("content") ?? tag("summary");
		items.push({
			title: decodeEntities(title).trim(),
			link: decodeEntities(link).trim(),
			pubDate: tag("pubDate") ?? tag("dc:date") ?? tag("published") ?? tag("updated"),
			description: descRaw ? stripHtml(descRaw).slice(0, 240) : undefined,
			image: firstImageFromRSS(block),
		});
	}
	return items;
}

/** Best in-feed image for an RSS <item>: media:content/thumbnail → image enclosure
 *  → first <img> inside the (CDATA) description/content. Undefined if none. */
function firstImageFromRSS(block: string): string | undefined {
	let m = /<media:(?:content|thumbnail)[^>]*\burl="([^"]+)"/i.exec(block);
	if (m) return decodeEntities(m[1]);
	m = /<enclosure[^>]*\burl="([^"]+)"[^>]*\btype="image\//i.exec(block)
		?? /<enclosure[^>]*\btype="image\/[^"]*"[^>]*\burl="([^"]+)"/i.exec(block);
	if (m) return decodeEntities(m[1]);
	m = /<img[^>]*\bsrc="([^"]+)"/i.exec(block);
	if (m) return decodeEntities(m[1]);
	return undefined;
}

/** Strip tags + CDATA from an HTML snippet → collapsed plain text. Decode entities
 *  FIRST so entity-encoded tags (e.g. the Guardian's `&lt;p&gt;`) become real tags
 *  and get stripped in the same pass; otherwise they'd survive as visible `<p>`. */
function stripHtml(s: string): string {
	const decoded = decodeEntities(s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, ""));
	return decoded
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Tiny stable string hash → short base36 id (stable id / KV key off the article URL). */
function hashId(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** A built news card (the fields the news pipeline reads/mutates; the rest pass
 *  through to JSON via the index signature). */
type NewsCard = {
	id: string;
	teamAbbreviation?: string;
	isLeague: boolean;
	headline?: string;
	sourceName?: string;
	url?: string;
	blurb?: string;
	thumbnailURL?: string;
	[k: string]: unknown;
};

/** Build Feed "News" cards from the curated per-outlet RSS feeds: real publisher
 *  URL + description + image. Haiku then drops non-NWSL items and tags the rest;
 *  survivors missing an image/blurb are OG-scraped (the club-news plumbing, now on
 *  real article URLs). Per-feed failures are isolated (a dead feed → []), so one
 *  outlet down never trips the feed's stale fallback. */
async function buildNewsCards(env: Env, ctx: ExecutionContext): Promise<unknown[]> {
	const perFeed = await Promise.all(
		NEWS_FEEDS.map(async (feed) => {
			try {
				const r = await fetch(feed.url, {
					headers: {
						"User-Agent": BROWSER_UA,
						Accept: "application/rss+xml, application/xml, text/xml",
					},
				});
				if (!r.ok) return [] as NewsCard[];
				const cards: NewsCard[] = [];
				for (const it of parseOutletRSS(await r.text())) {
					// `timestamp` is required app-side; skip an undatable item rather
					// than fake a time (would mis-sort it to "now").
					const timestamp = isoNoFraction(it.pubDate);
					if (!timestamp) continue;
					cards.push({
						id: `news-${hashId(it.link)}`,
						layout: "newsArticle",
						platform: "article",
						placement: "feed",
						teamAbbreviation: undefined, // set by tagNewsTeams (single-team)
						isLeague: true, // default; tagNewsTeams narrows when single-team
						headline: it.title,
						blurb: it.description,
						sourceName: feed.source,
						thumbnailURL: it.image,
						igFallback: false,
						timestamp,
						url: it.link,
						ctaLabel: "Read article",
					});
				}
				return cards;
			} catch {
				return [] as NewsCard[];
			}
		}),
	);

	// Haiku FIRST (drop non-NWSL + route), so we only spend OG scrapes on keepers.
	const kept = await tagNewsTeams(perFeed.flat(), env, ctx);
	return enrichNewsOG(kept, env, ctx);
}

/** Fill a missing thumbnail/blurb by Open-Graph-scraping the REAL article URL —
 *  the same fetchOG plumbing the club-news cards use. Cached in KV by card id
 *  (`ogn-<id>`, ~7d) so each article is scraped once; cards that already have both
 *  skip it. Best-effort: a scrape failure leaves the card as-is (headline still shows). */
async function enrichNewsOG(cards: NewsCard[], env: Env, ctx: ExecutionContext): Promise<NewsCard[]> {
	await Promise.all(
		cards.map(async (c) => {
			if ((c.thumbnailURL && c.blurb) || !c.url) return;
			const key = `ogn-${c.id}`;
			let og = (await env.FEED_TAGS.get(key, "json")) as
				| { image?: string; description?: string }
				| null;
			if (!og) {
				try {
					const scraped = await fetchOG(c.url);
					og = { image: scraped.image, description: scraped.description };
					ctx.waitUntil(env.FEED_TAGS.put(key, JSON.stringify(og), { expirationTtl: TAG_TTL }));
				} catch {
					og = {};
				}
			}
			if (!c.thumbnailURL && og.image) c.thumbnailURL = og.image;
			if (!c.blurb && og.description) c.blurb = stripHtml(og.description).slice(0, 240);
		}),
	);
	return cards;
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

/**
 * Collapse cards with identical visible TEXT — content-level dedup, not just by id.
 * A post-id check misses the real case: a bot (e.g. the nwslstat xG account)
 * publishing the same recap twice (morning + afternoon) — two distinct posts, two
 * ids, byte-identical text. Keeps the FIRST occurrence; callers pass cards
 * newest-first, so that's the freshest copy. The key is the card's primary text
 * (bodyText / title / headline), lower-cased + whitespace-collapsed. A card with no
 * text key (shouldn't happen) passes through.
 */
export function dedupeByContent(cards: unknown[]): unknown[] {
	const seen = new Set<string>();
	return (cards as Array<{ bodyText?: string; title?: string; headline?: string }>).filter(
		(c) => {
			const key = (c.bodyText ?? c.title ?? c.headline ?? "")
				.toLowerCase()
				.replace(/\s+/g, " ")
				.trim();
			if (!key) return true;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		},
	);
}

// ---------------------------------------------------------------------------
// /feed — the Feed tab's live source (A2: Bluesky). `GET /feed?teams=WAS,POR,…`
// returns reporter + league + followed-team Bluesky posts as ContentCard JSON.
// Reporter/league cards are league-wide (always returned); team cards are scoped
// to the requested clubs and carry placement "both" so they ALSO surface on Home.
// (Reddit + news RSS extend this same route in later steps.) Edge-cached 15min,
// keyed by the normalized, sorted team list — like /team-videos.
// ---------------------------------------------------------------------------
async function handleFeed(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const teams = normalizeTeams(url.searchParams.get("teams"));

	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.searchParams.set("teams", teams.join(","));
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let cards: unknown[];
	try {
		// Three sources: reporters + league outlets (always) + the requested clubs'
		// own posts. Per-handle failures are isolated inside blueskyCardsFor, so a
		// single dead account can't trip the stale/502 fallback — that's reserved for
		// a total Bluesky outage.
		const reporterHandles = FEED_HANDLES.filter((h) => h.kind === "reporter");
		const leagueHandles = FEED_HANDLES.filter((h) => h.kind === "league");
		const [rawReporters, leagueCards, teamCards, newsCards] = await Promise.all([
			buildBlueskyCards(reporterHandles),
			buildBlueskyCards(leagueHandles),
			buildTeamBlueskyCards(teams),
			// News (B1): per-outlet RSS → Haiku NWSL-gate + team-tag → OG-enrich →
			// newsArticle cards (placement "feed"). Self-isolating; failures yield [].
			buildNewsCards(env, ctx),
		]);
		// Only reporters get the Haiku relevance pass (they post off-topic too);
		// league outlets + club accounts are NWSL-dedicated and pass untouched.
		// News cards are already Haiku-tagged inside buildNewsCards.
		const reporters = await filterReporterRelevance(rawReporters, env, ctx);
		cards = [...reporters, ...leagueCards, ...teamCards, ...newsCards].sort(byTimestampDesc);
		// Collapse identical-text duplicates (bot double-posts) BEFORE the cap, so a
		// dup never costs a cap slot and we keep the freshest copy.
		cards = dedupeByContent(cards);
		// Free anti-flood cap (no API): no single account may dominate the feed.
		cards = capPerHandle(cards, MAX_PER_HANDLE);
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

/** Build cards for a set of Bluesky handles (per-handle failures isolated). */
async function buildBlueskyCards(handles: FeedHandle[]): Promise<unknown[]> {
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

// ---------------------------------------------------------------------------
// Haiku relevance / no-hot-takes filter (Step 2).
// ---------------------------------------------------------------------------

interface Verdict {
	id: string;
	isNWSL: boolean;
}
type FeedCard = { id?: string; handle?: string; bodyText?: string };

/** Keep at most `max` posts per author handle (cards arrive newest-first, so this
 *  keeps the freshest few) — a free cap so one prolific account can't flood the
 *  feed. Cards without a handle pass through. */
function capPerHandle(cards: unknown[], max: number): unknown[] {
	const counts = new Map<string, number>();
	return (cards as FeedCard[]).filter((c) => {
		if (!c.handle) return true;
		const n = (counts.get(c.handle) ?? 0) + 1;
		counts.set(c.handle, n);
		return n <= max;
	});
}

/**
 * Drop reporter posts that aren't about NWSL/women's soccer. Each card's verdict
 * is cached in KV by its stable post id (tagged once, ever); only never-seen cards
 * are batched to Haiku on a cache miss. Fail-OPEN: a card with no verdict (KV miss
 * + Haiku error or no key) is KEPT, so an outage degrades to the un-gated reporter
 * feed. KV writes are deferred via ctx.waitUntil so tagging never blocks the
 * response longer than the one Haiku round-trip.
 */
async function filterReporterRelevance(
	cards: unknown[],
	env: Env,
	ctx: ExecutionContext,
): Promise<unknown[]> {
	const typed = cards as FeedCard[];
	const verdicts = new Map<string, Verdict>();

	// 1. Load cached verdicts (one KV read per card; misses return null).
	const cached = await Promise.all(
		typed.map((c) => (c.id ? env.FEED_TAGS.get(c.id, "json") : Promise.resolve(null))),
	);
	const uncached: FeedCard[] = [];
	typed.forEach((c, i) => {
		const v = cached[i] as Verdict | null;
		if (v) verdicts.set(c.id!, v);
		else if (c.id) uncached.push(c);
	});

	// 2. Tag the misses via Haiku, batched. No key → skip (everything fails open).
	if (uncached.length > 0 && env.ANTHROPIC_API_KEY) {
		for (let i = 0; i < uncached.length; i += HAIKU_BATCH) {
			const batch = uncached.slice(i, i + HAIKU_BATCH);
			let out: Verdict[] | null;
			try {
				out = await haikuTagBatch(batch, env.ANTHROPIC_API_KEY);
			} catch {
				out = null; // fail open: leave this batch unjudged → kept below
			}
			if (out) {
				for (const v of out) {
					if (!v?.id) continue;
					verdicts.set(v.id, v);
					ctx.waitUntil(
						env.FEED_TAGS.put(v.id, JSON.stringify(v), { expirationTtl: TAG_TTL }),
					);
				}
			}
		}
	}

	// 3. Keep a card unless it was JUDGED off-topic (unjudged = keep, fail-open).
	return typed.filter((c) => {
		const v = c.id ? verdicts.get(c.id) : undefined;
		return v ? v.isNWSL : true;
	});
}

/** Tag one batch of cards via a single Haiku call (forced JSON via output_config). */
async function haikuTagBatch(cards: FeedCard[], apiKey: string): Promise<Verdict[]> {
	const list = cards
		.map((c) => {
			const handle = (c.handle ?? "").replace(/^@/, "");
			const text = (c.bodyText ?? "").replace(/\s+/g, " ").slice(0, 400);
			return `[${c.id}] @${handle}: ${text}`;
		})
		.join("\n\n");

	const r = await fetch(ANTHROPIC_API, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: HAIKU_MODEL,
			max_tokens: 2048,
			messages: [
				{
					role: "user",
					content: `${FEED_POLICY}\n\nClassify each post. Echo its id exactly.\n\n${list}`,
				},
			],
			output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
		}),
	});
	if (!r.ok) throw new Error(`haiku ${r.status}`);

	const json = (await r.json()) as { content?: Array<{ type?: string; text?: string }> };
	const text = json.content?.find((b) => b.type === "text")?.text;
	if (!text) throw new Error("haiku: no text block");
	return (JSON.parse(text) as { verdicts?: Verdict[] }).verdicts ?? [];
}

// ---------------------------------------------------------------------------
// Haiku relevance gate + team-tagging for News cards (B1). Same KV-cache + batch
// mechanics as filterReporterRelevance; the verdict both gates on NWSL relevance
// (the per-outlet feeds carry non-NWSL items — PWHL, WSL, men's soccer) and tags
// the keepers to team(s).
// ---------------------------------------------------------------------------

interface NewsVerdict {
	id: string;
	isNWSL: boolean;
	teams: string[];
}

/**
 * Gate each news card on NWSL relevance and tag the keepers to team(s) (verdict
 * KV-cached by card id, ~7d). A card JUDGED `isNWSL: false` is DROPPED (the feeds
 * carry non-NWSL items). For a keeper, exactly ONE team sets `teamAbbreviation` +
 * clears `isLeague` (routes to that club's followers); zero or multiple teams stay
 * `isLeague: true` (shown to all NWSL followers — the single-`teamAbbreviation`
 * model can't carry a set). Fail-OPEN: no key / Haiku error leaves a card unjudged
 * and KEPT as league-wide, so an outage degrades to the un-gated feed rather than
 * an empty chip. Unknown abbreviations are ignored.
 */
async function tagNewsTeams(
	cards: NewsCard[],
	env: Env,
	ctx: ExecutionContext,
): Promise<NewsCard[]> {
	if (cards.length === 0) return cards;
	const verdicts = new Map<string, NewsVerdict>();

	// 1. Load cached verdicts (one KV read per card; misses return null). The key is
	//    versioned (`nv1-`) so tightening the policy/schema can be rolled by bumping
	//    the version rather than waiting out every cached verdict's TTL.
	const vkey = (id: string) => `nv1-${id}`;
	const cached = await Promise.all(cards.map((c) => env.FEED_TAGS.get(vkey(c.id), "json")));
	const uncached: NewsCard[] = [];
	cards.forEach((c, i) => {
		const v = cached[i] as NewsVerdict | null;
		if (v) verdicts.set(c.id, v);
		else uncached.push(c);
	});

	// 2. Tag the misses via Haiku, batched. No key → skip (everything fails open).
	if (uncached.length > 0 && env.ANTHROPIC_API_KEY) {
		for (let i = 0; i < uncached.length; i += HAIKU_BATCH) {
			const batch = uncached.slice(i, i + HAIKU_BATCH);
			let out: NewsVerdict[] | null;
			try {
				out = await haikuTagNewsBatch(batch, env.ANTHROPIC_API_KEY);
			} catch {
				out = null; // fail open: batch unjudged → kept league-wide below
			}
			if (out) {
				for (const v of out) {
					if (!v?.id) continue;
					const teams = (v.teams ?? []).filter((t) => NEWS_TEAM_ABBR_SET.has(t));
					const clean: NewsVerdict = { id: v.id, isNWSL: v.isNWSL !== false, teams };
					verdicts.set(v.id, clean);
					ctx.waitUntil(
						env.FEED_TAGS.put(vkey(v.id), JSON.stringify(clean), { expirationTtl: TAG_TTL }),
					);
				}
			}
		}
	}

	// 3. Drop judged-off-topic cards; route the keepers. Unjudged (fail-open) → kept.
	const keepers: NewsCard[] = [];
	for (const c of cards) {
		const v = verdicts.get(c.id);
		if (v && v.isNWSL === false) continue; // judged non-NWSL → drop
		if (v && v.teams.length === 1) {
			c.teamAbbreviation = v.teams[0];
			c.isLeague = false;
		}
		keepers.push(c);
	}
	return keepers;
}

/** Tag one batch of news cards to team(s) via a single Haiku call (forced JSON). */
async function haikuTagNewsBatch(cards: NewsCard[], apiKey: string): Promise<NewsVerdict[]> {
	const list = cards
		.map((c) => {
			const src = c.sourceName ?? "";
			const headline = (c.headline ?? "").replace(/\s+/g, " ").slice(0, 200);
			const blurb = (c.blurb ?? "").replace(/\s+/g, " ").slice(0, 200);
			return `[${c.id}] (${src}) ${headline}${blurb ? ` — ${blurb}` : ""}`;
		})
		.join("\n\n");

	const r = await fetch(ANTHROPIC_API, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: HAIKU_MODEL,
			max_tokens: 2048,
			messages: [
				{
					role: "user",
					content: `${NEWS_POLICY}\n\nTag each article. Echo its id exactly.\n\n${list}`,
				},
			],
			output_config: { format: { type: "json_schema", schema: NEWS_SCHEMA } },
		}),
	});
	if (!r.ok) throw new Error(`haiku news ${r.status}`);

	const json = (await r.json()) as { content?: Array<{ type?: string; text?: string }> };
	const text = json.content?.find((b) => b.type === "text")?.text;
	if (!text) throw new Error("haiku news: no text block");
	return (JSON.parse(text) as { verdicts?: NewsVerdict[] }).verdicts ?? [];
}
