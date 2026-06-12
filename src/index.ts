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

import { runBracketTick, type BracketEnv } from "./bracket-engine";

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

// B3b — Instagram social pipe (via Apify). Low-cost, pay-per-result, NO-rental actor
// (owner chose the cheap path to stay inside Apify's free $5/mo credit):
//   IG = sones/instagram-posts-scraper-lowcost  ($0.30/1k, HTTP-only)
// TikTok (clockworks/tiktok-scraper, $1.70/1k, no rental) is DEFERRED for now but its
// id + mapper are kept ready. Apify API path uses "~" for the actor "/".
// We DON'T scrape on the user request path (a 50-account sync run is too slow and would
// risk a Worker timeout). Instead a CRON refreshes the card snapshot into KV
// (SOCIAL_CACHE_KEY); /feed and /team-videos just READ that snapshot — pinning Apify to
// ~1 run/cron regardless of app traffic. IG ~600 items/run × every-other-day ≈ $2.7/mo,
// well under $5. Unset APIFY_TOKEN → the builder no-ops → seed fallback.
const APIFY_API = "https://api.apify.com/v2/acts";
const APIFY_IG_ACTOR = "sones~instagram-posts-scraper-lowcost";
const APIFY_TIKTOK_ACTOR = "clockworks~tiktok-scraper"; // deferred; kept ready for re-enable
// Per-account post cap we ASK for. The cheap IG actor does NOT honor postsPerProfile
// (or newerThan) — it returns ~12/profile of mixed-age posts regardless — so IG volume
// (~600/run) is controlled by cron CADENCE (every other day, see wrangler.jsonc), not
// per-post limits. The app's staleness filter (Home 72h / Feed 7d) drops the old posts
// client-side, so a mixed-age KV snapshot is fine to display; we just can't avoid
// paying to scrape them. (TikTok's clockworks actor DOES honor it via resultsPerPage,
// relevant when TikTok is re-enabled.)
const SOCIAL_POSTS_PER_PROFILE = 4;
const SOCIAL_CACHE_KEY = "social-cards-v1"; // KV key for the cron-built card snapshot
const SOCIAL_CACHE_TTL = 3 * 24 * 3600; // 3d KV safety net — the daily cron refreshes well within it

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

// ---------------------------------------------------------------------------
// B3b — IG social handles (the Apify scrape targets).
//
// Handles were web-VERIFIED, not inferred from names (they're routinely
// non-obvious — Rodman is `trinity_rodman`, Lavelle `lavellerose`, LaBonta
// `lomomma`; 7 clubs differ between IG and TikTok). Full provenance +
// confidence notes: app repo `Reference/Feed update/B3b candidate social
// handles.md`. The first live cron scrape is the final verification pass — a
// handle that returns zero/garbage gets pulled before it ever reaches a card.
//
// IG ONLY for now — TikTok is deferred (owner decision). Clubs' IG → placement
// "home" (the club's own voice); players' IG → placement "feed". `abbr` is the app's
// club join key; a player's abbr is her current NWSL club, which routes her posts to
// that club's followers with no Haiku (the player IS the team link). CLUB_SOCIAL still
// carries each club's TikTok handle as ready reference for when TikTok is re-enabled.
// ---------------------------------------------------------------------------
interface SocialHandle {
	handle: string; // username, no @; matched case-insensitively to scrape output
	platform: "instagram" | "tiktok";
	kind: "team" | "player";
	abbr: string; // routing key — club abbr (a player → her current NWSL club)
	name: string; // card author display ("Washington Spirit" / "Trinity Rodman")
}

// Club official accounts. `tiktok` omitted only if a club truly has none.
const CLUB_SOCIAL: Record<string, { name: string; ig: string; tiktok?: string }> = {
	LA:  { name: "Angel City FC",        ig: "weareangelcity",     tiktok: "weareangelcity" },
	BAY: { name: "Bay FC",               ig: "wearebayfc",         tiktok: "wearebayfc" },
	BOS: { name: "Boston Legacy FC",     ig: "bostonlegacyfc",     tiktok: "bostonlegacyfc" }, // 2026 expansion — re-check near launch
	CHI: { name: "Chicago Stars",        ig: "thechicagostars",    tiktok: "thechicagostars" }, // NOT legacy chicagoredstars
	DEN: { name: "Denver Summit FC",     ig: "denversummit_fc",    tiktok: "denversummitfc" },  // ⚠️ IG has underscore, TikTok doesn't
	GFC: { name: "Gotham FC",            ig: "gothamfc",           tiktok: "gothamfc" },
	HOU: { name: "Houston Dash",         ig: "houstondash",        tiktok: "houston.dash" },     // ⚠️ TikTok has a dot
	KC:  { name: "Kansas City Current",  ig: "kccurrent",          tiktok: "thekccurrent" },     // ⚠️ TikTok adds "the"
	LOU: { name: "Racing Louisville",    ig: "racinglouisvillefc", tiktok: "racingloufc" },      // ⚠️ IG spelled out, TikTok abbreviated
	NC:  { name: "NC Courage",           ig: "thenccourage",       tiktok: "thenccourage" },
	ORL: { name: "Orlando Pride",        ig: "orlpride",           tiktok: "orlandopride" },     // ⚠️ IG abbreviated, TikTok full
	POR: { name: "Portland Thorns",      ig: "thornsfc",           tiktok: "thornsfc" },
	SD:  { name: "San Diego Wave",       ig: "sandiegowavefc",     tiktok: "sandiegowavefc" },
	SEA: { name: "Seattle Reign",        ig: "reignfc",            tiktok: "reignfc" },
	UTA: { name: "Utah Royals",          ig: "utahroyalsfc",       tiktok: "utahroyalsofficial" }, // ⚠️ different TikTok
	WAS: { name: "Washington Spirit",    ig: "washingtonspirit",   tiktok: "washspirit" },        // ⚠️ TikTok abbreviated
};

// USWNT-pool + marquee-international players → IG only, routed to current NWSL club.
// Europe-based (Fox/Girma/A.Thompson) included per owner, tagged to last NWSL club.
const PLAYER_SOCIAL: Array<{ name: string; abbr: string; ig: string }> = [
	{ name: "Trinity Rodman",   abbr: "WAS", ig: "trinity_rodman" },
	{ name: "Mallory Swanson",  abbr: "CHI", ig: "malpugh" },
	{ name: "Sophia Wilson",    abbr: "POR", ig: "sophiawilson" },
	{ name: "Jaedyn Shaw",      abbr: "GFC", ig: "jaedynshaw11" },
	{ name: "Reilyn Turner",    abbr: "POR", ig: "reilynturner" },
	{ name: "Olivia Moultrie",  abbr: "POR", ig: "olivia_moultrie" },
	{ name: "Rose Lavelle",     abbr: "GFC", ig: "lavellerose" },
	{ name: "Croix Bethune",    abbr: "KC",  ig: "croixbethune" },   // traded WAS→KC Feb 2026
	{ name: "Hal Hershfelt",    abbr: "WAS", ig: "halhershh" },
	{ name: "Jaelin Howell",    abbr: "GFC", ig: "jaehowell" },      // traded to Gotham
	{ name: "Lo'eau LaBonta",   abbr: "KC",  ig: "lomomma" },
	{ name: "Ashley Sanchez",   abbr: "NC",  ig: "ashley.sanchez" }, // NC Courage, not WAS
	{ name: "Maddie Dahlien",   abbr: "SEA", ig: "maddie.dahlien" },
	{ name: "Jordyn Bugg",      abbr: "SEA", ig: "jordyn.bugg" },
	{ name: "Riley Jackson",    abbr: "NC",  ig: "riley.jackson8" }, // NC Courage, not WAS
	{ name: "Sally Menti",      abbr: "SEA", ig: "sallymenti" },
	{ name: "Claudia Dickey",   abbr: "SEA", ig: "claudiadickey_" },
	{ name: "Mandy McGlynn",    abbr: "UTA", ig: "mandy_mcglynn" },
	{ name: "Jane Campbell",    abbr: "HOU", ig: "janecampbell_" },
	{ name: "Jordan Silkowitz", abbr: "BAY", ig: "jordansilkowitz" },
	{ name: "Tierna Davidson",  abbr: "GFC", ig: "tierna_davidson" },
	{ name: "Emily Sonnett",    abbr: "GFC", ig: "emilysonnett" },
	{ name: "Lilly Reale",      abbr: "GFC", ig: "lillyreale" },
	{ name: "Tara Rudd",        abbr: "WAS", ig: "taraaamckeown" },  // plays as Rudd; IG keeps maiden name
	{ name: "Gisele Thompson",  abbr: "LA",  ig: "giselethomp" },
	{ name: "Avery Patterson",  abbr: "HOU", ig: "averypatterson9" },
	{ name: "Kennedy Wesley",   abbr: "SD",  ig: "kennedywesleyy" },
	{ name: "Barbra Banda",     abbr: "ORL", ig: "barbrabandaofficial" }, // intl star (owner-approved)
	{ name: "Temwa Chawinga",   abbr: "KC",  ig: "temwa556" },            // intl star
	{ name: "Marta",            abbr: "ORL", ig: "martavsilva10" },       // intl star; real acct (many imposters)
	{ name: "Catarina Macario", abbr: "SD",  ig: "catarina_macario" },    // signed SD Wave Mar 2026
	{ name: "Emily Fox",        abbr: "NC",  ig: "___emilyfox" },         // Europe (Arsenal); tag last NWSL = NC
	{ name: "Naomi Girma",      abbr: "SD",  ig: "naomi_girma" },         // Europe (Chelsea); tag last NWSL = SD
	{ name: "Alyssa Thompson",  abbr: "LA",  ig: "alyssthomp" },          // Europe (Chelsea); last NWSL = LA
];

// IG-only for now (TikTok deferred — owner decision). CLUB_SOCIAL.tiktok handles are
// kept above as ready reference for when TikTok is re-enabled (see buildSocialCards).
const SOCIAL_HANDLES: SocialHandle[] = [
	...Object.entries(CLUB_SOCIAL).map(
		([abbr, c]): SocialHandle => ({ handle: c.ig, platform: "instagram", kind: "team", abbr, name: c.name }),
	),
	...PLAYER_SOCIAL.map(
		(p): SocialHandle => ({ handle: p.ig, platform: "instagram", kind: "player", abbr: p.abbr, name: p.name }),
	),
];

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Admin-only: run one Bracket engine tick on demand (the hourly cron does this
		// automatically; this is for verification). Guarded by the BRACKET_ADMIN_KEY secret.
		if (url.pathname === "/bracket/run") {
			const key = (env as unknown as { BRACKET_ADMIN_KEY?: string }).BRACKET_ADMIN_KEY;
			if (request.method !== "POST" || !key || request.headers.get("x-admin-key") !== key) {
				return new Response("forbidden", { status: 403 });
			}
			const msg = await runBracketTick(env as unknown as BracketEnv);
			return new Response(`${msg}\n`);
		}

		// All other routes are GET-only; reject early so the 405 is shared.
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
		if (url.pathname === "/spotlight") {
			return handleSpotlight(url, env, ctx);
		}

		return new Response(
			"Not found. This proxy serves GET /scoreboard, /summary, /team-videos, /feed, and /spotlight.",
			{ status: 404 },
		);
	},

	// B3b — once-daily cron: scrape IG via Apify and refresh the social-card
	// snapshot in KV. Decoupled from user requests so a slow ~50-account scrape never
	// blocks the app and Apify spend is pinned to ~1 run/day (see wrangler.jsonc crons).
	// Await (not waitUntil) — a cron should keep its invocation alive until the work is
	// done; best-effort, a failed refresh leaves the last good snapshot in place.
	async scheduled(controller, env, _ctx): Promise<void> {
		// The hourly cron drives the Bracket Battle engine (generate / tally + advance /
		// rotate). The every-other-day cron refreshes the Instagram social cache.
		if (controller.cron === "0 * * * *") {
			try {
				await runBracketTick(env as unknown as BracketEnv);
			} catch {
				/* swallow — the next hourly tick retries; the engine is idempotent */
			}
			return;
		}
		try {
			await refreshSocialCache(env);
		} catch {
			/* swallow — next run retries; the stale snapshot stays serving */
		}
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
		// YouTube uploads + club-site news (OG) + the club's own IG (B3b, read
		// from the cron-built KV snapshot, placement "home"), merged newest-first.
		// Articles + social are best-effort (neither throws); only a YouTube outage
		// trips the stale/502 fallback below. Club Bluesky moved OFF Home into the Feed
		// in B3b — IG is the club's Home voice now.
		const [videos, articles, social] = await Promise.all([
			buildTeamCards(teams, env.YOUTUBE_API_KEY),
			buildArticleCards(teams),
			readSocialCards(env),
		]);
		cards = dedupeByContent(
			[...videos, ...articles, ...socialFor(social, teams, new Set(["home"]))].sort(byTimestampDesc),
		);
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
// /feed — the Feed tab's live source. `GET /feed?teams=WAS,POR,…` returns the
// "wider conversation" as ContentCard JSON: reporter + league + followed-club
// Bluesky (A2) + news articles (B1) + player IG clips (B3b). Reporter/league/
// news are league-wide; club Bluesky + player social are scoped to the requested
// clubs. All carry placement "feed" (B3b moved club Bluesky off Home). Edge-cached
// 15min, keyed by the normalized, sorted team list — like /team-videos.
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
		const [rawReporters, leagueCards, teamCards, newsCards, social] = await Promise.all([
			buildBlueskyCards(reporterHandles),
			buildBlueskyCards(leagueHandles),
			buildTeamBlueskyCards(teams),
			// News (B1): per-outlet RSS → Haiku NWSL-gate + team-tag → OG-enrich →
			// newsArticle cards (placement "feed"). Self-isolating; failures yield [].
			buildNewsCards(env, ctx),
			// Social (B3b): the cron-built IG snapshot; here we take the player
			// clips (placement "feed") routed to the followed teams. Club Bluesky is
			// already in teamCards (now placement "feed" too).
			readSocialCards(env),
		]);
		// Only reporters get the Haiku relevance pass (they post off-topic too);
		// league outlets + club accounts are NWSL-dedicated and pass untouched.
		// News cards are already Haiku-tagged inside buildNewsCards.
		const reporters = await filterReporterRelevance(rawReporters, env, ctx);
		const playerSocial = socialFor(social, teams, new Set(["feed"]));
		cards = [...reporters, ...leagueCards, ...teamCards, ...newsCards, ...playerSocial].sort(
			byTimestampDesc,
		);
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

/** A followed club's own Bluesky posts (placement "feed" — Feed "Social" only, as
 *  of B3b). Empty when no teams are requested or none have a curated handle. */
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
		// B3b: ALL Bluesky now lives in the Feed only (was "both" for team posts). The
		// club's Home voice is its IG now; club Bluesky is its real-time/social
		// voice → Feed "Social". teamAbbreviation still scopes a team post to followers.
		placement: "feed",
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

// ---------------------------------------------------------------------------
// B3b — Social cards (IG via Apify).
//
// The CRON builds the full snapshot (every club + player, both platforms) and
// stores it in KV (SOCIAL_CACHE_KEY); /feed and /team-videos only READ + filter
// it. We never scrape on a user request — a ~50-account sync run is far too slow
// for the request path and would risk a Worker timeout; the cron has a generous
// budget and pins Apify to ~1 run/day. The two actors + the handle map are the
// SOCIAL_* constants / SOCIAL_HANDLES above. Mappers are exported for unit tests.
// ---------------------------------------------------------------------------

/** Normalize an ISO string OR a unix timestamp (seconds or ms) to the app's
 *  strict "…Z" ISO8601 (no fractional seconds). Undefined when unparseable —
 *  IG actors vary (ISO string vs unix), and a card with no timestamp is
 *  dropped rather than mis-sorted to "now". */
function isoFromAny(v: unknown): string | undefined {
	if (typeof v === "number" && Number.isFinite(v)) {
		const ms = v > 1e12 ? v : v * 1000; // a value below ~1e12 is seconds, not ms
		return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
	}
	if (typeof v === "string") return isoNoFraction(v);
	return undefined;
}

/** A finite number, else undefined (so a missing count drops to nil app-side). */
function numOrUndef(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Run an Apify actor synchronously and return its dataset items (cron-only —
 *  a sync run is slow). Throws on non-2xx so the caller can isolate one platform's
 *  failure from the other. */
async function apifyRunSync(actor: string, input: unknown, token: string): Promise<unknown[]> {
	const r = await fetch(`${APIFY_API}/${actor}/run-sync-get-dataset-items?token=${token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!r.ok) {
		const body = await r.text().catch(() => "");
		throw new Error(`apify ${actor} ${r.status} ${body.slice(0, 300)}`);
	}
	const json = await r.json();
	return Array.isArray(json) ? json : [];
}

/** One Apify Instagram post → a `socialVideo` ContentCard, or null if unusable.
 *  Field names are the sones/instagram-posts-scraper-lowcost output (snake_case,
 *  verified live): `code` (shortcode), `taken_at` (unix s), `caption.text`,
 *  `image_url`, `post_url`, `like_count`. Fallbacks kept for the apify-standard
 *  names in case the actor is ever swapped. `placement` routes the card
 *  (club → Home, player → Feed). */
export function mapApifyInstagram(raw: unknown, h: SocialHandle): unknown | null {
	const item = raw as Record<string, unknown>;
	const code = (item.code ?? item.shortCode ?? item.shortcode) as string | undefined;
	const url =
		(item.post_url as string | undefined) ??
		(item.url as string | undefined) ??
		(code ? `https://www.instagram.com/p/${code}/` : undefined);
	const ts = isoFromAny(item.taken_at ?? item.timestamp ?? item.takenAtTimestamp);
	if (!url || !ts) return null;

	const image =
		(item.image_url as string | undefined) ??
		(item.displayUrl as string | undefined) ??
		(item.thumbnailUrl as string | undefined);
	const rawCaption = item.caption;
	const caption =
		typeof rawCaption === "string"
			? rawCaption
			: ((rawCaption as { text?: string } | undefined)?.text ?? (item.text as string | undefined));

	return {
		id: `ig-${code ?? hashId(url)}`,
		layout: "socialVideo",
		platform: "instagram",
		placement: h.kind === "team" ? "home" : "feed",
		teamAbbreviation: h.abbr,
		isLeague: false,
		authorName: h.name,
		handle: `@${h.handle}`, // only used by capPerHandle; footer shows authorName
		bodyText: caption || undefined,
		thumbnailURL: typeof image === "string" ? image : undefined,
		igFallback: false,
		likes: numOrUndef(item.like_count ?? item.likesCount ?? item.likeCount),
		timestamp: ts,
		url,
		ctaLabel: "Open in Instagram",
	};
}

/** One Apify TikTok video → a `socialVideo` ContentCard, or null if unusable.
 *  Output shape is the clockworks/tiktok-scraper documented fields. */
export function mapApifyTikTok(raw: unknown, h: SocialHandle): unknown | null {
	const item = raw as Record<string, unknown>;
	const url = (item.webVideoUrl as string | undefined) ?? (item.url as string | undefined);
	const ts = isoFromAny(item.createTimeISO ?? item.createTime);
	if (!url || !ts) return null;

	const vid = url.split("/").filter(Boolean).pop();
	const videoMeta = item.videoMeta as { coverUrl?: string } | undefined;
	const cover = videoMeta?.coverUrl ?? (item.cover as string | undefined);
	const text = item.text;

	return {
		id: `tt-${vid ?? hashId(url)}`,
		layout: "socialVideo",
		platform: "tiktok",
		placement: h.kind === "team" ? "home" : "feed",
		teamAbbreviation: h.abbr,
		isLeague: false,
		authorName: h.name,
		handle: `@${h.handle}`,
		bodyText: typeof text === "string" ? text || undefined : undefined,
		thumbnailURL: typeof cover === "string" ? cover : undefined,
		igFallback: false,
		likes: numOrUndef(item.diggCount),
		timestamp: ts,
		url,
		ctaLabel: "Open in TikTok",
	};
}

/** Build the social cards, split by platform so the caller can preserve one
 *  platform's last-good snapshot if the other came back empty. Cron-only.
 *
 *  TikTok is DEFERRED (owner: IG-only for now), so only Instagram is scraped — which
 *  also means a single actor runs, sidestepping the Apify FREE plan's 8192MB TOTAL
 *  concurrent-actor cap (running two at once trips `actor-memory-limit-exceeded`/402).
 *  To re-enable TikTok: add a SEQUENTIAL second pass (after IG, to stay under that cap)
 *  scraping APIFY_TIKTOK_ACTOR over the CLUB_SOCIAL.tiktok handles → mapApifyTikTok.
 *  IG empty (or no APIFY_TOKEN) → caller keeps the last good snapshot (→ seed fallback). */
async function buildSocialCards(env: Env): Promise<{ instagram: unknown[]; tiktok: unknown[] }> {
	const token = env.APIFY_TOKEN;
	if (!token) return { instagram: [], tiktok: [] };

	const igHandles = SOCIAL_HANDLES.filter((h) => h.platform === "instagram");
	const igByUser = new Map(igHandles.map((h) => [h.handle.toLowerCase(), h]));

	let instagram: unknown[] = [];
	try {
		const items = await apifyRunSync(
			APIFY_IG_ACTOR,
			{ usernames: igHandles.map((h) => h.handle), postsPerProfile: SOCIAL_POSTS_PER_PROFILE },
			token,
		);
		instagram = items
			.map((it) => {
				// sones output keys the scraped account on `scraped_username`.
				const rec = it as { scraped_username?: string; ownerUsername?: string; user?: { username?: string } };
				const user = String(rec.scraped_username ?? rec.user?.username ?? rec.ownerUsername ?? "").toLowerCase();
				const h = igByUser.get(user);
				return h ? mapApifyInstagram(it, h) : null;
			})
			.filter(Boolean) as unknown[];
	} catch {
		/* IG failed this run — caller keeps the last good IG snapshot */
	}

	return { instagram, tiktok: [] };
}

/** Cron entry: rebuild the social snapshot → KV. IG-only (TikTok deferred): writes the
 *  fresh IG cards, but if THIS run got nothing (intermittent Apify outage) it keeps the
 *  last-good IG snapshot rather than blanking the social slot. Writing IG-only also
 *  PURGES any stale TikTok cards a past run may have left in KV. When TikTok is
 *  re-enabled, restore a per-platform merge (fresh-or-last-good for each platform). */
async function refreshSocialCache(env: Env): Promise<void> {
	const { instagram } = await buildSocialCards(env);
	const cards = instagram.length
		? instagram
		: (await readSocialCards(env)).filter(
				(c) => (c as { platform?: string }).platform === "instagram",
			);
	if (cards.length === 0) return; // nothing now, nothing before — keep KV as-is
	await env.FEED_TAGS.put(SOCIAL_CACHE_KEY, JSON.stringify(cards), {
		expirationTtl: SOCIAL_CACHE_TTL,
	});
}

/** Read the cron-built social snapshot (all placements), or [] if none yet. */
async function readSocialCards(env: Env): Promise<unknown[]> {
	const snapshot = (await env.FEED_TAGS.get(SOCIAL_CACHE_KEY, "json")) as unknown[] | null;
	return snapshot ?? [];
}

/** Filter the social snapshot to the requested teams + the allowed placements
 *  (Home wants "home", Feed wants "feed"). */
function socialFor(cards: unknown[], teams: string[], placements: Set<string>): unknown[] {
	if (teams.length === 0) return [];
	const wanted = new Set(teams);
	return (cards as Array<{ teamAbbreviation?: string; placement?: string }>).filter(
		(c) =>
			!!c.placement &&
			placements.has(c.placement) &&
			!!c.teamAbbreviation &&
			wanted.has(c.teamAbbreviation),
	);
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

// ---------------------------------------------------------------------------
// /spotlight — Home Module 2 "Get to know your players" (B2). For each followed
// club, pick a real player from that team's MOST RECENT matchday squad (players
// who actually appeared — starters + subs used), attach real ESPN season stats,
// and generate a short "why watch" blurb via Claude Haiku. Returns PlayerSpotlight
// JSON the app decodes directly (its seed is the offline-first fallback). One pick
// per team per week (deterministic), edge-cached; the blurb is KV-cached weekly.
//
// ⚠️ CONTENT GUARDRAIL (non-negotiable): the blurb is ALWAYS about the player's
// soccer career — NEVER her family, relationships, parents, or "the legacy of
// someone else" (a systemic way women athletes get framed that men never are;
// Trinity Rodman has publicly asked media to stop invoking her father). Enforcement
// is structural: the Haiku prompt receives ONLY soccer fields (name, position,
// team, age, season stats, recent appearance) — never any biographical/family data
// — AND the prompt explicitly forbids it. Review generated blurbs before shipping.
// ---------------------------------------------------------------------------

const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/usa.nwsl";
const SPOTLIGHT_TTL = 6 * 3600; // 6h edge cache; the weekly pick is stable, stats refresh a few times/day
const SPOTLIGHT_NARRATIVE_TTL = 7 * 24 * 3600; // the blurb is regenerated at most weekly

// App join-key abbreviation → full club name (for the blurb prompt + seasonForm).
const TEAM_NAMES: Record<string, string> = {
	LA: "Angel City FC", BAY: "Bay FC", BOS: "Boston Legacy FC", CHI: "Chicago Stars FC",
	DEN: "Denver Summit FC", GFC: "Gotham FC", HOU: "Houston Dash", KC: "Kansas City Current",
	NC: "North Carolina Courage", ORL: "Orlando Pride", POR: "Portland Thorns FC",
	LOU: "Racing Louisville FC", SD: "San Diego Wave FC", SEA: "Seattle Reign FC",
	UTA: "Utah Royals FC", WAS: "Washington Spirit",
};

const SPOTLIGHT_POLICY = `You are writing a short player profile (2-3 sentences) for a women's soccer fan app's weekly "get to know your players" spotlight. The tone is warm and fan-to-fan, like an Olympics broadcast introducing an athlete before her event.

Write about ONLY:
- Her playing style and what she brings to this team (infer reasonably from her position and stats)
- How her current season is going, grounded in the stats provided
- What a fan watching the team's next match should look for from her

Hard rules (non-negotiable):
- Focus ONLY on the player's soccer career, skills, position, and current form.
- NEVER mention family members, parents, siblings, partners, or relationships.
- NEVER frame her as related to, or the legacy of, any other person.
- NEVER reference anything outside of soccer.
- Do NOT invent specific facts (former clubs, trophies, nationality, biographical details, named matches, or calendar years/dates) beyond what is given — speak only to playing style and the season stats provided.
- Length: exactly 2-3 sentences. Output ONLY the profile text, no preamble or quotation marks.`;

interface SummaryRosterPlayer {
	starter?: boolean;
	subbedIn?: boolean;
	jersey?: string;
	position?: { abbreviation?: string; name?: string };
	athlete?: { id?: string; displayName?: string };
}
interface SummaryRoster {
	team?: { abbreviation?: string };
	roster?: SummaryRosterPlayer[];
}
interface SpotlightStats {
	goals: number;
	assists: number;
	apps: number;
}

async function handleSpotlight(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const teams = normalizeTeams(url.searchParams.get("teams"));

	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.searchParams.set("teams", teams.join(","));
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	// No follows → no spotlights (the app shows the module only for followed teams).
	let cards: unknown[] = [];
	if (teams.length > 0) {
		try {
			cards = await buildSpotlightCards(teams, env, ctx);
		} catch {
			// A total scoreboard outage serves a stale copy if we have one, else 502
			// (the app falls back to its seed on any non-2xx). Per-team failures are
			// isolated inside buildSpotlightCards and never reach here.
			return (await serveStale(cache, cacheKey)) ?? upstreamError();
		}
	}

	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", `public, max-age=${SPOTLIGHT_TTL}`);
	const toCache = new Response(JSON.stringify(cards), { status: 200, headers });
	ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
	return withCacheStatus(toCache, "MISS");
}

/** Build one spotlight per requested team (newest matchday squad → weekly pick →
 *  real stats + bio → Haiku blurb). Per-team failures drop only that team. */
async function buildSpotlightCards(teams: string[], env: Env, ctx: ExecutionContext): Promise<unknown[]> {
	// 1. One scoreboard fetch → each team's most recent FINISHED event.
	const year = new Date().getUTCFullYear();
	const recentEvent = await recentEventByTeam(year, new Set(teams));

	// 2. Per team (parallel, isolated). Summary fetches are de-duped per event id (two
	//    followed teams that played each other share one summary).
	const summaryCache = new Map<string, Promise<SummaryRoster[]>>();
	const weekNum = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));

	const built = await Promise.all(
		teams.map(async (abbr) => {
			try {
				const eventId = recentEvent.get(abbr);
				if (!eventId) return null;

				let rostersP = summaryCache.get(eventId);
				if (!rostersP) {
					rostersP = fetchSummaryRosters(eventId);
					summaryCache.set(eventId, rostersP);
				}
				const rosters = await rostersP;
				const pool = appearedPlayers(rosters.find((r) => r.team?.abbreviation === abbr));
				if (pool.length === 0) return null;

				const player = pickWeekly(pool, abbr, weekNum);
				const athleteId = player.athlete!.id!;
				const teamName = TEAM_NAMES[abbr] ?? abbr;

				const [stats, bio] = await Promise.all([
					fetchAthleteSeasonStats(athleteId, year),
					fetchAthleteBio(athleteId),
				]);

				// The match-day roster labels bench players "Substitute"; prefer the
				// athlete record's real position in that case (else keep the richer
				// match position, e.g. "Attacking Midfielder Right").
				const matchPos = player.position?.name;
				const position = matchPos && matchPos !== "Substitute" ? matchPos : bio.position ?? "Player";
				const playerName = (player.athlete!.displayName ?? "Unknown").trim();

				const blurb = await whyWatchBlurb(
					{ name: playerName, position, teamName, age: bio.age, stats },
					abbr,
					athleteId,
					weekNum,
					env,
					ctx,
				);

				return {
					id: `spot-${abbr}-${athleteId}`,
					teamAbbreviation: abbr,
					playerName,
					jerseyNumber: parseInt(player.jersey ?? "0", 10) || 0,
					position,
					bioBlurb: blurb,
					nationality: bio.nationality,
					age: bio.age,
					careerHighlights: [],
					funFacts: [],
					seasonForm: stats ? seasonFormLabel(stats) : undefined,
					espnAthleteId: athleteId,
					seasonStatLine: stats ?? undefined,
				};
			} catch {
				return null;
			}
		}),
	);
	return built.filter(Boolean);
}

/** Most recent FINISHED (state "post") event id for each wanted team, from one
 *  scoreboard fetch. Scans both competitors of every event; keeps the latest by date. */
async function recentEventByTeam(year: number, wanted: Set<string>): Promise<Map<string, string>> {
	const r = await fetch(`${ESPN_SCOREBOARD}?dates=${year}0101-${year}1231&limit=500`, {
		headers: { Accept: "application/json" },
	});
	if (!r.ok) throw new Error(`scoreboard ${r.status}`);
	const json = (await r.json()) as {
		events?: Array<{
			id?: string;
			date?: string;
			status?: { type?: { state?: string } };
			competitions?: Array<{ competitors?: Array<{ team?: { abbreviation?: string } }> }>;
		}>;
	};
	const best = new Map<string, { id: string; date: string }>();
	for (const ev of json.events ?? []) {
		if (ev.status?.type?.state !== "post" || !ev.id || !ev.date) continue;
		for (const c of ev.competitions?.[0]?.competitors ?? []) {
			const abbr = c.team?.abbreviation;
			if (!abbr || !wanted.has(abbr)) continue;
			const cur = best.get(abbr);
			if (!cur || cur.date < ev.date) best.set(abbr, { id: ev.id, date: ev.date });
		}
	}
	const out = new Map<string, string>();
	for (const [abbr, v] of best) out.set(abbr, v.id);
	return out;
}

/** One match's two team rosters from the summary endpoint. */
async function fetchSummaryRosters(eventId: string): Promise<SummaryRoster[]> {
	const r = await fetch(`${ESPN_SUMMARY}?event=${eventId}`, { headers: { Accept: "application/json" } });
	if (!r.ok) throw new Error(`summary ${r.status}`);
	const json = (await r.json()) as { rosters?: SummaryRoster[] };
	return json.rosters ?? [];
}

/** Players who actually APPEARED (starters + subs who came on), sorted by athlete id
 *  so the deterministic weekly pick is stable regardless of JSON ordering. */
export function appearedPlayers(roster?: SummaryRoster): SummaryRosterPlayer[] {
	return (roster?.roster ?? [])
		.filter(
			(p) => (p.starter === true || p.subbedIn === true) && p.athlete?.id && p.athlete?.displayName,
		)
		.sort((a, b) => (a.athlete!.id! < b.athlete!.id! ? -1 : 1));
}

/** Deterministic weekly pick: stable for a given (team, week), so the spotlight
 *  changes once a week and the narrative KV key stays put for that week. */
export function pickWeekly(pool: SummaryRosterPlayer[], abbr: string, weekNum: number): SummaryRosterPlayer {
	const key = `${abbr}-${weekNum}`;
	let seed = 7;
	for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
	return pool[seed % pool.length];
}

/** One athlete's season stat line — goals (offensive.totalGoals), assists
 *  (offensive.goalAssists), apps (general.appearances). Best-effort → null. */
async function fetchAthleteSeasonStats(id: string, year: number): Promise<SpotlightStats | null> {
	try {
		const r = await fetch(`${ESPN_CORE}/seasons/${year}/types/1/athletes/${id}/statistics`, {
			headers: { Accept: "application/json" },
		});
		if (!r.ok) return null;
		const json = (await r.json()) as {
			splits?: { categories?: Array<{ name?: string; stats?: Array<{ name?: string; value?: number }> }> };
		};
		const cats = json.splits?.categories ?? [];
		const stat = (cat: string, name: string): number => {
			const s = cats.find((x) => x.name === cat)?.stats?.find((x) => x.name === name);
			return Math.round(s?.value ?? 0);
		};
		return {
			goals: stat("offensive", "totalGoals"),
			assists: stat("offensive", "goalAssists"),
			apps: stat("general", "appearances"),
		};
	} catch {
		return null;
	}
}

/** Athlete age, nationality + real position from the Core API athlete record. The
 *  position backs up the match-day roster, whose `position.name` is "Substitute"
 *  for anyone who came off the bench. Best-effort → {}. */
async function fetchAthleteBio(id: string): Promise<{ age?: number; nationality?: string; position?: string }> {
	try {
		const r = await fetch(`${ESPN_CORE}/athletes/${id}`, { headers: { Accept: "application/json" } });
		if (!r.ok) return {};
		const json = (await r.json()) as { age?: number; citizenship?: string; position?: { name?: string } };
		return {
			age: typeof json.age === "number" ? json.age : undefined,
			nationality: json.citizenship || undefined,
			position: json.position?.name || undefined,
		};
	} catch {
		return {};
	}
}

/** "3 goals · 1 assist" — the small form line under the stat strip. */
export function seasonFormLabel(s: SpotlightStats): string {
	const g = `${s.goals} goal${s.goals === 1 ? "" : "s"}`;
	const a = `${s.assists} assist${s.assists === 1 ? "" : "s"}`;
	return `${g} · ${a}`;
}

/**
 * The Haiku "why watch" blurb. Its input is ONLY soccer fields (the guardrail is
 * structural — no family/biographical data is ever passed) and the prompt forbids
 * relationship/legacy framing. KV-cached per (team, athlete, week) so it's
 * generated at most once a week. Fail-OPEN: no key or any Haiku error → a neutral,
 * soccer-only fallback sentence (bioBlurb is required app-side, never empty).
 */
async function whyWatchBlurb(
	p: { name: string; position: string; teamName: string; age?: number; stats: SpotlightStats | null },
	abbr: string,
	athleteId: string,
	weekNum: number,
	env: Env,
	ctx: ExecutionContext,
): Promise<string> {
	// Versioned key (`spv2-`) so a prompt/policy change rerolls cached blurbs rather
	// than waiting out each one's weekly TTL (mirrors the news tagger's `nv1-`).
	const key = `spv2-${abbr}-${athleteId}-${weekNum}`;
	const cached = await env.FEED_TAGS.get(key, "text");
	if (cached) return cached;

	const fallback = fallbackBlurb(p);
	if (!env.ANTHROPIC_API_KEY) return fallback;

	const statsLine = p.stats
		? `${p.stats.apps} appearances, ${p.stats.goals} goals, ${p.stats.assists} assists this season`
		: "limited stats available this season";
	const facts = [
		`Player: ${p.name}`,
		`Position: ${p.position}`,
		`Team: ${p.teamName}`,
		p.age ? `Age: ${p.age}` : null,
		`Season stats: ${statsLine}`,
		`Recent: appeared in the team's most recent match`,
	]
		.filter(Boolean)
		.join("\n");

	try {
		const r = await fetch(ANTHROPIC_API, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": env.ANTHROPIC_API_KEY,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: HAIKU_MODEL,
				max_tokens: 220,
				messages: [{ role: "user", content: `${SPOTLIGHT_POLICY}\n\n${facts}` }],
			}),
		});
		if (!r.ok) throw new Error(`haiku spotlight ${r.status}`);
		const json = (await r.json()) as { content?: Array<{ type?: string; text?: string }> };
		const text = json.content?.find((b) => b.type === "text")?.text?.trim();
		if (!text) throw new Error("haiku spotlight: no text block");
		ctx.waitUntil(env.FEED_TAGS.put(key, text, { expirationTtl: SPOTLIGHT_NARRATIVE_TTL }));
		return text;
	} catch {
		return fallback;
	}
}

/** Neutral, soccer-only blurb when Haiku is unavailable (never mentions anything
 *  outside the player's season). */
function fallbackBlurb(p: { name: string; position: string; teamName: string; stats: SpotlightStats | null }): string {
	const role = p.position.toLowerCase();
	if (p.stats && (p.stats.goals > 0 || p.stats.assists > 0)) {
		return `${p.name} has been a contributor for ${p.teamName} this season, with ${p.stats.goals} goals and ${p.stats.assists} assists across ${p.stats.apps} appearances. Keep an eye on the ${role} the next time ${p.teamName} take the pitch.`;
	}
	return `${p.name} is one to watch for ${p.teamName} — a ${role} who featured in the team's most recent matchday squad. Catch her in action the next time they play.`;
}
