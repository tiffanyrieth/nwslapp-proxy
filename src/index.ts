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

import { runBracketTick, forceCloseActiveRound, handleBracketAdmin, type BracketEnv } from "./bracket-engine";
import { buildHeadshotMap, handleHeadshots } from "./headshots";
import {
	handleKnowHerAdmin,
	computeEligiblePlayers,
	filterPoolByTeams,
	KNOWHER_POOL_KEY,
	type KnowHerPool,
	type KnowHerEnv,
} from "./knowher";
import { handleQuizResults } from "./quiz-results";
import {
	exchangeAuthorizationCode,
	storeAppleRefreshToken,
	readAppleRefreshToken,
	revokeRefreshToken,
	type AppleAuthEnv,
} from "./apple-auth";

// Forced-update version gate (served at GET /config). To force everyone onto a newer TestFlight
// build, raise MIN_APP_BUILD (the integer the app compares against its CFBundleVersion) and redeploy.
// MIN_APP_VERSION is the informational marketing string. minBuild=21 blocks builds 19 and 20 on deploy.
const MIN_APP_VERSION = "0.4.2";
const MIN_APP_BUILD = 21;

const ESPN_SCOREBOARD =
	"https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard";
const ESPN_SUMMARY =
	"https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/summary";

// `/scoreboard?league=<slug>` serves any of these ESPN soccer competitions (women's)
// through the same cached pass-through. NWSL is the default when `league` is absent
// (so the existing app build keeps working). The slug is ALLOWLISTED server-side —
// we never forward an arbitrary `league` into an ESPN URL (SSRF / cache hygiene).
const SCOREBOARD_LEAGUES = new Set<string>([
	"usa.nwsl",                       // NWSL (default)
	"fifa.wwc",                       // FIFA Women's World Cup
	"fifa.w.olympics",                // Olympics (women)
	"fifa.shebelieves",               // SheBelieves Cup
	"fifa.friendly.w",                // Women's international friendlies (global)
	"concacaf.w.gold",                // Concacaf W Gold Cup (national teams)
	"concacaf.womens.championship",   // Concacaf W Championship (national teams, pre-2024)
	"uefa.weuro",                     // UEFA Women's Euro (national teams — Europe's powers)
	"concacaf.w.champions_cup",       // Concacaf W Champions Cup (CLUB: NWSL clubs vs Liga MX)
	"usa.nwsl.cup",                   // NWSL Challenge Cup (CLUB: one annual NWSL-vs-NWSL match)
]);
const scoreboardUpstream = (slug: string) =>
	`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard`;

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

// ─────────────────────────────────────────────────────────────────────────────
// Club news — Home "Club News" (newsArticle cards, the green "NEWS" pill).
//
// Every followed club's OWN recent article-news on Home, as the iMessage/Slack
// link-preview model: headline + blurb + image + tap-out, deep-linked to the club's
// site. (Supersedes the old single-URL TEAM_ARTICLES, which only ever covered WAS —
// see git history: the OG→card mechanism always worked; the source list never grew.)
//
// MAINTENANCE — tiered discovery, in priority order:
//   1) rss   — the club's own RSS/Atom feed (WordPress `/feed/`, HubSpot
//              `/<blog>/rss.xml`, …). Cleanest: structured title/date/image, no
//              scraping. PREFER whenever a valid feed exists.
//   2) index — the club SSRs a news INDEX listing article links in the raw HTML. We
//              fetch it with BROWSER_UA, take the latest links under `articlePath`,
//              then OG-scrape each (fetchOG also reads JSON-LD `datePublished` — several
//              club platforms put the date there, not in a `<meta og:>` tag).
//   3) fallback — last resort for a club whose official site is bot-blocked, JS-only, or
//              carries no machine-readable date. Filters the curated NWSL outlet RSS
//              (NEWS_FEEDS) by club name. Honest: tagged sourceType "news" (press), not
//              "club". (Google News RSS was tried first but returns EMPTY to Cloudflare
//              Workers — datacenter IPs get a consent page — so any fallback source MUST
//              be Workers-reachable; the NEWS_FEEDS already are.)
//
// RESILIENCE / NO SILENT FAILURES: an rss/index club that yields 0 cards auto-falls
// back to the outlet fallback AND emits a `clubNewsFallback` diag event, so a broken official
// source is VISIBLE (never a silently-empty club). A club empty even after fallback
// emits `clubNewsEmpty`. The deploy-time health check (scripts/health_check_club_news.mjs)
// fails if ANY club returns 0. See buildClubNewsCards + emitDiag.
//
// TO ADD / FIX A CLUB (rebrand, domain move, or the health check flags it empty):
//   1. Probe with the browser UA:
//        curl -A "<BROWSER_UA>" https://<domain>/feed/        # valid RSS → `rss`
//        curl -A "<BROWSER_UA>" https://<domain>/<newsPath>   # SSRs article links → `index`
//      Neither (403 / JS-only / no date) → `fallback`.
//   2. `npm run healthcheck` — curls all 16, fails if any returns 0 articles.
//   NOTE: several clubs live on a PARENT/shared domain under a sub-path — keep the
//   prefix in BOTH `url` and `articlePath` (see HOU/UTA/ORL).
type ClubNewsSource =
	| { kind: "rss"; url: string }
	| { kind: "index"; url: string; articlePath: string }
	| { kind: "fallback" };

const CLUB_NEWS: Record<string, ClubNewsSource> = {
	// ── Official RSS/Atom (dated, structured) ──
	BAY: { kind: "rss", url: "https://bayfc.com/feed/" },
	LOU: { kind: "rss", url: "https://racingloufc.com/feed/" },
	SD: { kind: "rss", url: "https://sandiegowavefc.com/feed/" },
	WAS: { kind: "rss", url: "https://washingtonspirit.com/feed/" },
	// Angel City runs on HubSpot — its blog RSS lives under the /acfc-post blog path
	// (the /news page redirects there). Owner-confirmed Jun 2026.
	LA: { kind: "rss", url: "https://angelcity.com/acfc-post/rss.xml" },

	// ── SSR news index → scrape links → OG-scrape (date via JSON-LD on these platforms) ──
	KC: { kind: "index", url: "https://www.kansascitycurrent.com/news", articlePath: "/news/" },
	// Denver's WordPress /feed/ is only the default "Hello world!" stub, but its real news
	// lives at /news/ — articles nested under a category (/news/<cat>/<slug>/) on the www
	// host, dated via microdata (<meta itemprop="datePublished"> / <time>). Owner-flagged
	// Jun 2026 (don't use /feed/).
	DEN: { kind: "index", url: "https://www.denversummitfc.com/news/", articlePath: "/news/" },
	// NC + POR are configured for their official index but currently auto-fall-back (NC's
	// index lists only category links, not article slugs, in SSR HTML; thorns.com article
	// pages carry no machine-readable date). The clubNewsFallback diag flags both — revisit
	// if their sites expose article links / dates (then they promote to official with no
	// config change).
	NC: { kind: "index", url: "https://nccourage.com/news", articlePath: "/news/" },
	POR: { kind: "index", url: "https://www.thorns.com/news", articlePath: "/news/" },
	SEA: { kind: "index", url: "https://www.reignfc.com/news", articlePath: "/news/" },
	// These three live on a shared PARENT domain under a club sub-path (owner-confirmed
	// Jun 2026), NOT their own *.com — keep the sub-path in url AND articlePath:
	// HOU under the Houston Dynamo site, UTA on the RSL platform, ORL under Orlando City.
	HOU: { kind: "index", url: "https://www.houstondynamofc.com/houstondash/news/", articlePath: "/houstondash/news/" },
	UTA: { kind: "index", url: "https://www.rsl.com/utahroyals/news/", articlePath: "/utahroyals/news/" },
	ORL: { kind: "index", url: "https://www.orlandocitysc.com/pride/news/", articlePath: "/pride/news/" },

	// ── Outlet fallback (official site unusable → curated NWSL press, sourceType "news") ──
	// GFC: gothamfc.com articles carry NO machine-readable date (no og:published / JSON-LD),
	//      so they can't be dated/sorted reliably — press-sourced until they add one.
	GFC: { kind: "fallback" },
	// CHI: chicagostars.com/feed/ IS a valid, dated official WordPress RSS feed from a normal
	// (residential) IP — but the Cloudflare Worker's datacenter IP still gets blocked/empty
	// (re-tested Jun 30 2026: configured as `rss`, the Worker fetched 0 and auto-fell-back to
	// press). So CHI stays on press fallback (sourceType "news") until the host stops blocking
	// datacenter egress. Re-test by flipping to `{ kind: "rss", url: ".../feed/" }` + deploy.
	CHI: { kind: "fallback" },
	// BOS: brand-new Shopify site is JS-rendered with no feed (revisit when they add a news section).
	BOS: { kind: "fallback" },
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

// Claude Haiku relevance + team-tag (Step 2). Runs on the third-party Bluesky
// bucket — REPORTER and LEAGUE-OUTLET accounts (both post off-topic/non-NWSL and
// neither carries a team tag of its own). It gates relevance AND tags the team so a
// post about a followed club gets that club's color/label; off-topic + non-followed
// posts are dropped (decideFeedItem). Club-official and player accounts are the
// trusted FAST PATHS — they carry their own abbr and never touch the API. Each post
// is classified ONCE (verdict cached in KV by post id, ~7d); only never-seen posts
// hit Haiku on a miss. This bucket fails toward DROP when unjudged (no key / Haiku
// outage / unsure) — the club + player fast paths keep the feed populated.
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

// Social (reporter + league-outlet) Bluesky classifier. These accounts post
// off-topic too, so each post is gated AND team-tagged: isNWSL (strict — false
// for non-NWSL incl. men's soccer, foreign leagues, personal/off-topic), teams[]
// (the NWSL clubs it's primarily about; [] for genuinely league-wide), and
// leagueNews (a HIGH bar — true only for real league-wide NWSL news, not general
// reporter chatter/opinion). The keep/drop + tag rule lives in decideFeedItem,
// which fails toward DROP when a post is unjudged (fixes the old fail-open leak).
const SOCIAL_POLICY = `You are filtering and tagging Bluesky posts for an NWSL (US National Women's Soccer League) fan app. The posts come from soccer reporters/journalists and NWSL media/league accounts, who also post off-topic things (other sports, foreign leagues, men's soccer, personal life, general chatter).

For each post (handle + text) decide three things:
1. "isNWSL": true ONLY if the post is clearly about the NWSL — an NWSL club, an NWSL match/result/standing/award, a player at an NWSL club, a transfer into or out of an NWSL club, or the US women's national team (USWNT). false for everything else, INCLUDING women's soccer that isn't NWSL (England's WSL, Liga F, the UEFA Women's Champions League, other foreign leagues), other sports (PWHL, WNBA), men's soccer (including the men's World Cup), and the author's personal/off-topic posts. A post that only mentions another league, market, or country in passing — the size of the WSL's audience, a foreign transfer market, broadcast deals abroad — is NOT about the NWSL: the NWSL (a club/player/match/the league itself) or the USWNT must be the SUBJECT of the post. Example: "Japan is the joint-largest market for the WSL outside of the UK" is about England's WSL → isNWSL false. When you are unsure whether a post is about the NWSL, return false.
2. "teams": if isNWSL, the NWSL club abbreviation(s) the post is primarily about; [] for genuinely league-wide/general NWSL or USWNT posts. If isNWSL is false, return [].
3. "leagueNews": true ONLY when isNWSL is true AND teams is empty AND the post is genuine league-wide NWSL NEWS — expansion, the schedule/fixtures release, awards/honors, the playoff race, rule/CBA/roster-rule changes, or other league-wide announcements. false for general opinion, hot takes, predictions, banter, or chatter not tied to hard news. If isNWSL is false or teams is non-empty, return false.

The 16 NWSL teams and their abbreviations:
LA = Angel City FC, BAY = Bay FC, BOS = Boston, CHI = Chicago Stars, DEN = Denver, GFC = Gotham FC, HOU = Houston Dash, KC = Kansas City Current, NC = North Carolina Courage, ORL = Orlando Pride, POR = Portland Thorns, LOU = Racing Louisville, SD = San Diego Wave, SEA = Seattle Reign, UTA = Utah Royals, WAS = Washington Spirit.

Rules: a single-team post → exactly that one abbreviation; a multi-team post → all clubs named; league-wide → []. Only use the 16 abbreviations above. Echo each post's id exactly.`;

// Forced structured output (output_config.format) — Haiku 4.5 returns the first
// text block as JSON matching this schema. No min/max constraints (unsupported);
// additionalProperties:false is required on every object.
const SOCIAL_SCHEMA = {
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
					leagueNews: { type: "boolean" },
				},
				required: ["id", "isNWSL", "teams", "leagueNews"],
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
1. "isNWSL": true ONLY if the article is primarily about the NWSL itself — an NWSL club, an NWSL match/standing/award/power-ranking, a player AT an NWSL club in an NWSL context, or a transfer INTO or OUT OF an NWSL club. false for everything else, INCLUDING: national-team soccer (the USWNT or ANY country's national team — international friendlies, tournaments, the World Cup, call-ups, FIFA windows) EVEN WHEN NWSL players take part; women's soccer that isn't NWSL (England's WSL, Spain's Liga F, the UEFA Women's Champions League, other foreign leagues); players moving between two non-NWSL clubs; other sports (PWHL, WNBA); and men's soccer. When the headline centers a national team, an international match/window, a foreign league, or a non-NWSL transfer, isNWSL is false even though it may involve women's soccer or NWSL players. When unsure, return false.
2. "teams": if isNWSL, the NWSL club abbreviation(s) it is primarily about; [] for genuinely league-wide/general NWSL news. If isNWSL is false, return [].

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
			try {
				const bEnv = env as unknown as BracketEnv;
				// ?force=close → close the open round now, so this same tick tallies it
				// (verification only).
				const forced = url.searchParams.get("force") === "close"
					? `${await forceCloseActiveRound(bEnv)}; ` : "";
				const msg = await runBracketTick(bEnv);
				return new Response(`${forced}${msg}\n`);
			} catch (e) {
				const err = e as Error;
				// Redact anything secret-shaped so a misconfig can't leak a key.
				const safe = `${err.message}\n${err.stack ?? ""}`.replace(
					/sb_secret_[A-Za-z0-9_]+|sb_publishable_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_.\-]+/g,
					"[redacted]",
				);
				return new Response(`bracket tick error: ${safe}\n`, { status: 500 });
			}
		}

		// Admin-only: rebuild the player-headshot map on demand (the weekly cron does this
		// automatically; this is for verification + auditing the unmatched list). Guarded by
		// the same BRACKET_ADMIN_KEY secret as /bracket/run.
		if (url.pathname === "/headshots/run") {
			const key = (env as unknown as { BRACKET_ADMIN_KEY?: string }).BRACKET_ADMIN_KEY;
			if (request.method !== "POST" || !key || request.headers.get("x-admin-key") !== key) {
				return new Response("forbidden", { status: 403 });
			}
			try {
				const meta = await buildHeadshotMap(env);
				return new Response(`${JSON.stringify(meta, null, 2)}\n`, {
					headers: { "Content-Type": "application/json" },
				});
			} catch (e) {
				const err = e as Error;
				return new Response(`headshots build error: ${err.message}\n${err.stack ?? ""}\n`, { status: 500 });
			}
		}

		// POST telemetry ingest must be registered BEFORE the GET-only guard below.
		if (url.pathname === "/telemetry") {
			return handleTelemetryIngest(request, env, ctx);
		}

		// POST account deletion: the privileged "right to be forgotten" route. Verifies the
		// caller's Supabase JWT, then service-role deletes their auth.users row (cascading
		// every per-user table). The client can't do this — deleting an auth user needs the
		// service-role key. Registered before the GET-only guard (it's POST + self-checks).
		if (url.pathname === "/account/delete") {
			return handleAccountDelete(request, env, ctx);
		}

		// POST SIWA token exchange: trade Apple's short-lived authorizationCode for a
		// refresh_token (stored on the user's profiles row) so account deletion can revoke
		// the Apple credential (guideline 5.1.1(v)). Verifies the caller's Supabase JWT;
		// before the GET-only guard (it's POST + self-checks secrets).
		if (url.pathname === "/auth/apple-token-exchange") {
			return handleAppleTokenExchange(request, env, ctx);
		}

		// Operator-only Bracket Battle admin: GET /bracket/admin = the page (public shell),
		// POST /bracket/admin/api = key-gated control. Before the GET-only guard (it serves
		// both methods + does its own BRACKET_ADMIN_KEY check).
		if (url.pathname === "/bracket/admin" || url.pathname === "/bracket/admin/api") {
			return handleBracketAdmin(request, env as unknown as BracketEnv & { BRACKET_ADMIN_KEY?: string });
		}

		// Operator-only Know Her Game admin: GET /knowher/admin = the page, POST /knowher/admin/api
		// = key-gated content ops (paste pool → KV, flip manual/auto, view eligible players). Before
		// the GET-only guard (it serves both methods + does its own BRACKET_ADMIN_KEY check).
		if (url.pathname === "/knowher/admin" || url.pathname === "/knowher/admin/api") {
			return handleKnowHerAdmin(request, env as unknown as KnowHerEnv);
		}

		// All other routes are GET-only; reject early so the 405 is shared.
		if (request.method !== "GET") {
			return new Response("Method not allowed. Use GET.", {
				status: 405,
				headers: { Allow: "GET" },
			});
		}

		// Forced-update version gate. The app calls this at launch and blocks itself if its
		// CFBundleVersion < minBuild. Deliberately trivial: two hardcoded numbers, no KV/DB — to
		// force an update, bump these + redeploy. minBuild is the integer compared (monotonic
		// per-upload); minVersion is informational. Short cache so a bump propagates within the hour.
		if (url.pathname === "/config") {
			return new Response(JSON.stringify({ minVersion: MIN_APP_VERSION, minBuild: MIN_APP_BUILD }), {
				status: 200,
				headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
			});
		}

		// The two ESPN routes are transparent caching pass-throughs (shared
		// proxyAndCache). /team-videos is different: it *builds* a response by
		// calling the YouTube Data API and normalizing to ContentCard JSON.
		if (url.pathname === "/scoreboard") {
			// `?league=<slug>` selects the competition (default NWSL). Allowlisted so an
			// arbitrary slug can't be forwarded into an ESPN URL. `league` rides the
			// cache key (independent per competition) but is stripped before ESPN (its
			// scoreboard doesn't take it — the league lives in the path).
			const league = url.searchParams.get("league") ?? "usa.nwsl";
			if (!SCOREBOARD_LEAGUES.has(league)) {
				return new Response(`Unknown league "${league}".`, { status: 400 });
			}
			return proxyAndCache(url, scoreboardUpstream(league), chooseScoreboardTTL, ctx);
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
		if (url.pathname === "/trivia") {
			return handleTrivia(url, env, ctx);
		}
		if (url.pathname === "/knowher") {
			return handleKnowHer(url, env, ctx);
		}
		if (url.pathname === "/knowher/eligible") {
			return handleKnowHerEligible(url, env);
		}
		if (url.pathname === "/quiz-results") {
			return handleQuizResults(url, env as unknown as { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string }, ctx);
		}
		if (url.pathname === "/headshots") {
			return handleHeadshots(url, env, ctx);
		}
		if (url.pathname === "/crest/manifest") {
			return handleAssetManifest(env);
		}
		if (url.pathname === "/national-teams") {
			return handleNationalTeams(ctx);
		}
		// `/crest/{ABBR}` (preferred) or legacy `/crest?team=ABBR`. `/crest/manifest` is
		// matched earlier, so it never reaches here.
		if (url.pathname === "/crest" || url.pathname.startsWith("/crest/")) {
			return handleCrest(url, env, ctx);
		}
		if (url.pathname === "/roster") {
			return handleRoster(url, env, ctx);
		}
		if (url.pathname === "/telemetry/recent") {
			return handleTelemetryRecent(request, env);
		}

		return new Response(
			"Not found. This proxy serves GET /scoreboard, /summary, /team-videos, /feed, /spotlight, /trivia, /knowher, /knowher/eligible, /quiz-results, /headshots, /crest, /crest/manifest, /roster, /national-teams, and POST /telemetry.",
			{ status: 404 },
		);
	},

	// B3b — once-daily cron: scrape IG via Apify and refresh the social-card
	// snapshot in KV. Decoupled from user requests so a slow ~50-account scrape never
	// blocks the app and Apify spend is pinned to ~1 run/day (see wrangler.jsonc crons).
	// Await (not waitUntil) — a cron should keep its invocation alive until the work is
	// done; best-effort, a failed refresh leaves the last good snapshot in place.
	async scheduled(controller, env, _ctx): Promise<void> {
		// The every-5-min cron drives the Bracket Battle engine (manual-action pickup / auto
		// tally + advance / rotate). The every-other-day cron refreshes the Instagram social
		// cache. The full env is cast to BracketEnv — it carries FEED_TAGS too, so the engine
		// can emit NO-SILENT-FAILURES diag telemetry.
		if (controller.cron === "*/5 * * * *") {
			try {
				await runBracketTick(env as unknown as BracketEnv);
			} catch {
				/* swallow — the next 5-min tick retries; the engine is idempotent */
			}
			return;
		}
		// Weekly → rebuild the NWSL↔ESPN player-headshot map. Idempotent; a failure leaves
		// the last good map in KV serving, and the next week retries.
		if (controller.cron === "0 9 * * 1") {
			try {
				await buildHeadshotMap(env);
			} catch {
				/* swallow — next weekly run retries; the stale map stays serving */
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
	// `league` (scoreboard only) is encoded in `upstreamBase`'s path, not an ESPN
	// query param — strip it from the forwarded search. No-op for routes without it.
	upstream.searchParams.delete("league");

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
 * 30s; future → once-daily BUT capped at kickoff (see `preKickoffTTL`) so a
 * pre-kickoff shell can't be served stale through the whole live game. Parse
 * failure → safe 1hr default.
 */
export function chooseSummaryTTL(body: ArrayBuffer): number {
	try {
		const json = JSON.parse(new TextDecoder().decode(body)) as {
			header?: {
				competitions?: Array<{
					date?: string;
					status?: { type?: { state?: string } };
				}>;
			};
		};
		const competition = json.header?.competitions?.[0];
		const state = competition?.status?.type?.state;
		switch (state) {
			case "post":
				return IMMUTABLE_TTL;
			case "in":
				return LIVE_TTL;
			case "pre":
				return preKickoffTTL(competition?.date);
			default:
				return SUMMARY_DEFAULT_TTL;
		}
	} catch {
		return SUMMARY_DEFAULT_TTL;
	}
}

/**
 * TTL for a "pre" (pre-kickoff) summary — the empty shell ESPN serves before a
 * match starts (no lineups, no plays). We cap it at kickoff so it can NEVER
 * outlive the pre→in transition: otherwise a shell cached minutes before kickoff
 * is served — empty — for the ENTIRE live game and past full-time, until the next
 * daily refresh (the "stale summary" bug). Once this expires around kickoff, the
 * next fetch sees state "in" → LIVE_TTL → the real, populated summary flows.
 *
 * Far-future matches are unaffected: their kickoff is further out than the daily
 * refresh, so the `min` keeps the original once-daily preview cadence.
 *   - missing/unparseable `date` → original daily-refresh behavior (safe fallback).
 *   - kickoff already passed but still "pre" (ESPN status lag / delayed start) →
 *     a short TTL so we re-check and catch the live transition within seconds.
 */
const PRE_KICKOFF_BUFFER = 120;
const LINEUP_WINDOW_SECONDS = 7200;   // 2h out — ESPN posts the starting XI ~1h before kickoff
const LINEUP_WINDOW_TTL = 600;        // 10-min freshness so the app + watcher catch the lineup drop

function preKickoffTTL(date?: string): number {
	const daily = secondsUntilDailyRefresh();
	if (!date) return daily;
	const kickoff = Date.parse(date);
	if (Number.isNaN(kickoff)) return daily;
	const untilKickoff = Math.floor((kickoff - Date.now()) / 1000);
	if (untilKickoff <= 0) return LIVE_TTL;
	// Inside the final ~2h, poll ~every 10 min: a summary cached hours out (capped at kickoff) would
	// otherwise sleep through the ~1h-pre lineup publish, so the app's pre-match view would show a stale
	// pre-lineup shell until kickoff. Still expires by kickoff (the +buffer never overshoots meaningfully).
	if (untilKickoff <= LINEUP_WINDOW_SECONDS) {
		return Math.max(60, Math.min(LINEUP_WINDOW_TTL, untilKickoff + PRE_KICKOFF_BUFFER));
	}
	return Math.max(60, Math.min(daily, untilKickoff + PRE_KICKOFF_BUFFER));
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
		// YouTube uploads + each club's own article-news (per-club CLUB_NEWS discovery,
		// all 16 clubs) + the club's own IG (read from the cron-built KV snapshot,
		// placement "home"), merged newest-first. News + social are best-effort (neither
		// throws); only a YouTube outage trips the stale/502 fallback below. Club Bluesky
		// lives in the Feed now — IG is the club's Home voice.
		const [videos, articles, social] = await Promise.all([
			buildTeamCards(teams, env.YOUTUBE_API_KEY),
			buildClubNewsCards(teams, env, ctx),
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
const CLUBNEWS_TTL = 2 * 60 * 60; // 2h per-club cache (Home's own route cache is 1h)
const CLUBNEWS_PER_CLUB = 4; // most-recent articles surfaced per club

/** Home "Club News": each followed club's own recent article-news, via its configured
 *  CLUB_NEWS strategy (rss / index-scrape / fallback). Per-club + best-effort: one
 *  club failing never breaks the others or the route. */
async function buildClubNewsCards(teams: string[], env: Env, ctx: ExecutionContext): Promise<unknown[]> {
	const per = await Promise.all(teams.map((abbr) => clubNewsFor(abbr, env, ctx)));
	return per.flat();
}

/** Resolve one club's news cards: KV cache → primary strategy → outlet fallback,
 *  emitting `diag` telemetry on any official-source miss (NO SILENT FAILURES). */
async function clubNewsFor(abbr: string, env: Env, ctx: ExecutionContext): Promise<unknown[]> {
	const src = CLUB_NEWS[abbr];
	if (!src) return [];

	const cacheKey = `clubnews-${abbr}`;
	const cached = (await env.FEED_TAGS.get(cacheKey, "json")) as NewsCard[] | null;
	if (cached) return cached;

	let cards: NewsCard[] = [];
	try {
		if (src.kind === "rss") cards = await clubRssCards(abbr, src.url);
		else if (src.kind === "index") cards = await clubIndexCards(abbr, src.url, src.articlePath);
		// kind === "fallback": handled by the outlet-fallback path below.
	} catch {
		cards = [];
	}

	// A configured OFFICIAL source returning nothing is a failure — surface it (visible in
	// Diagnostics), then fall back so the club is never empty.
	if (cards.length === 0 && src.kind !== "fallback") {
		emitDiag(env, ctx, "clubNewsFallback", abbr);
	}
	if (cards.length === 0) {
		try {
			cards = await buildOutletFallbackCards(abbr);
		} catch {
			cards = [];
		}
	}

	// Fill any MISSING article thumbnail by OG-scraping the article's og:image — WordPress
	// club feeds (e.g. Washington Spirit) don't put the post's FEATURED image in the RSS body,
	// so an article whose image isn't inline lands here text-only. This is the same best-effort,
	// KV-cached enrichment the league/outlet feeds already use; run it BEFORE caching so the
	// recovered image persists in the club cache. Cards that already have an image are skipped.
	if (cards.length > 0) {
		cards = await enrichNewsOG(cards, env, ctx);
	}

	if (cards.length === 0) {
		emitDiag(env, ctx, "clubNewsEmpty", abbr); // true miss — flagged, not hidden
	} else {
		ctx.waitUntil(env.FEED_TAGS.put(cacheKey, JSON.stringify(cards), { expirationTtl: CLUBNEWS_TTL }));
	}
	return cards;
}

/** Strategy: the club's own RSS/Atom feed → cards (structured, dated; no scraping). */
async function clubRssCards(abbr: string, url: string): Promise<NewsCard[]> {
	const r = await fetch(url, {
		headers: { "User-Agent": BROWSER_UA, Accept: "application/rss+xml, application/xml, text/xml" },
	});
	if (!r.ok) return [];
	const name = CLUB_SOCIAL[abbr]?.name ?? abbr;
	const cards: NewsCard[] = [];
	for (const it of parseOutletRSS(await r.text())) {
		const timestamp = isoNoFraction(it.pubDate);
		if (!timestamp) continue; // undatable → skip rather than fake "now"
		if (isPlaceholderArticle(it.title)) continue; // stub-site default post → not real news
		cards.push(clubNewsCard(abbr, it.link, it.title, it.description, name, it.image, timestamp, "club"));
		if (cards.length >= CLUBNEWS_PER_CLUB) break;
	}
	return cards;
}

/** Strategy: scrape the club's SSR'd news index for the latest article links, then
 *  OG-scrape each (fetchOG reads JSON-LD dates too). The date gate doubles as the
 *  "is this a real article?" filter — section/category pages carry no date → dropped. */
async function clubIndexCards(abbr: string, indexUrl: string, articlePath: string): Promise<NewsCard[]> {
	const r = await fetch(indexUrl, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } });
	if (!r.ok) return [];
	const links = extractArticleLinks(await r.text(), indexUrl, articlePath);
	const name = CLUB_SOCIAL[abbr]?.name ?? abbr;
	const built = await Promise.all(
		links.map(async (link) => {
			try {
				const og = await fetchOG(link);
				const timestamp = isoNoFraction(og.published);
				if (!og.title || !timestamp || isPlaceholderArticle(og.title)) return null;
				return clubNewsCard(abbr, link, og.title, og.description, name, og.image, timestamp, "club");
			} catch {
				return null;
			}
		}),
	);
	return built.filter((c): c is NewsCard => c !== null).slice(0, CLUBNEWS_PER_CLUB);
}

/** Strategy / fallback: a club's recent news filtered from the curated NWSL outlet RSS
 *  feeds (NEWS_FEEDS — the same feeds /feed already pulls successfully from the Worker).
 *  Press, not club-official → sourceType "news". NOTE: this replaced a per-club Google
 *  News RSS fallback, which returns EMPTY to Cloudflare Workers (datacenter IPs get a
 *  consent/empty page) — caught only by the deploy-time health check + clubNewsEmpty
 *  telemetry, never locally. Use a Workers-reachable source here, always. */
async function buildOutletFallbackCards(abbr: string): Promise<NewsCard[]> {
	const match = clubNewsMatcher(abbr);
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
				const xml = await r.text();
				// Match each RAW item block (title + body/content:encoded + categories), not
				// just parseOutletRSS's excerpt — outlets often name a club only in the
				// article body, which the <description> excerpt omits (that hid NC's coverage).
				const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/g) ?? [];
				const out: NewsCard[] = [];
				for (const block of blocks) {
					if (!match(block)) continue;
					const it = parseOutletRSS(block)[0];
					if (!it) continue;
					const timestamp = isoNoFraction(it.pubDate);
					if (!timestamp) continue;
					out.push(clubNewsCard(abbr, it.link, it.title, it.description, feed.source, it.image, timestamp, "news"));
				}
				return out;
			} catch {
				return [] as NewsCard[];
			}
		}),
	);
	return perFeed.flat().sort(byTimestampDesc).slice(0, CLUBNEWS_PER_CLUB) as NewsCard[];
}

/** Match an article's text to a club for the outlet fallback: the club's name (with and
 *  without an FC/SC suffix) plus a distinctive press nickname where the name and the way
 *  outlets refer to the club differ. Terms <4 chars are dropped (too generic). */
function clubNewsMatcher(abbr: string): (text: string) => boolean {
	const name = CLUB_SOCIAL[abbr]?.name ?? abbr;
	const terms = new Set<string>([name, name.replace(/\s+(FC|SC)$/i, "")]);
	const nick: Record<string, string> = { GFC: "Gotham", NC: "Courage", POR: "Thorns" };
	if (nick[abbr]) terms.add(nick[abbr]);
	const lowered = [...terms].map((t) => t.toLowerCase()).filter((t) => t.length >= 4);
	return (text) => {
		const low = text.toLowerCase();
		return lowered.some((t) => low.includes(t));
	};
}

/** One Home club-news card (newsArticle layout). `sourceType` is "club" for the club's
 *  own site, "news" for the outlet fallback. */
function clubNewsCard(
	abbr: string,
	url: string,
	headline: string,
	blurb: string | undefined,
	sourceName: string,
	image: string | undefined,
	timestamp: string,
	sourceType: "club" | "news",
): NewsCard {
	return {
		id: `clubnews-${hashId(url)}`,
		layout: "newsArticle",
		platform: "article",
		placement: "home",
		sourceType,
		teamAbbreviation: abbr,
		isLeague: false,
		headline,
		blurb,
		sourceName,
		thumbnailURL: image,
		igFallback: false,
		timestamp,
		url,
		ctaLabel: sourceType === "club" ? "Read more" : "Read article",
	};
}

/** Extract candidate article URLs from a club's news-index HTML: links under `articlePath`
 *  whose FINAL path segment looks like an article slug (a long, multi-word title), minus
 *  obvious non-articles (tag/author/page/category/video/search/feed). Host match is
 *  www-insensitive and the slug may be NESTED under a section (e.g. some sites file
 *  articles as `/news/<category>/<slug>/`). Permissive by design — the date gate in
 *  clubIndexCards is the final article filter. */
export function extractArticleLinks(html: string, indexUrl: string, articlePath: string, max = 12): string[] {
	const origin = new URL(indexUrl).origin;
	const host = new URL(indexUrl).hostname.replace(/^www\./, "");
	const deny = /\/(tags?|authors?|page|categor(?:y|ies)|videos?|search|archive|feed|rss)(\/|$|\.)/i;
	const seen = new Set<string>();
	const out: string[] = [];
	const hrefRe = /href="([^"#?]+)"/gi;
	let m: RegExpExecArray | null;
	while ((m = hrefRe.exec(html)) !== null && out.length < max) {
		let abs: URL;
		try {
			abs = m[1].startsWith("http") ? new URL(m[1]) : new URL(m[1], origin);
		} catch {
			continue;
		}
		if (abs.hostname.replace(/^www\./, "") !== host) continue; // same site, www-insensitive
		if (!abs.pathname.startsWith(articlePath)) continue;
		const rest = abs.pathname.slice(articlePath.length).replace(/\/$/, "");
		if (!rest) continue; // the index itself
		if (deny.test(abs.pathname)) continue;
		// An article slug is a long, multi-word title; a section/category segment is short.
		// This (not "direct child only") is what tells an article from a listing page and
		// allows nested `/news/<category>/<slug>/` paths.
		const lastSeg = rest.split("/").pop() ?? "";
		const hyphens = (lastSeg.match(/-/g) ?? []).length;
		if (lastSeg.length < 24 && hyphens < 3) continue;
		const u = abs.origin + abs.pathname;
		if (seen.has(u)) continue;
		seen.add(u);
		out.push(u);
	}
	return out;
}

/** Supabase secrets the account-delete route needs. They're Worker secrets (set via
 *  `wrangler secret`, used by the bracket engine too) but may not be in the generated
 *  Env typing, so we read them through a narrow cast. */
type SupabaseAdminEnv = { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };

const jsonResponse = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** POST /account/delete — permanently delete the caller's account (App Store "account
 *  deletion" requirement + GDPR right-to-be-forgotten). Flow:
 *    1. Require a `Bearer <supabase-jwt>` — the caller's session token.
 *    2. Verify it against Supabase Auth (`GET /auth/v1/user`) → the real user id. We
 *       NEVER trust a client-supplied id; the token is the only identity source.
 *    3. Service-role hard-delete that auth user (`DELETE /auth/v1/admin/users/{id}`),
 *       which cascades every per-user row (the cascade migration backs this).
 *  Fails LOUD: every error path emits diag + returns a non-2xx, so the app never reports
 *  a successful delete while the data still exists. */
async function handleAccountDelete(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") {
		return jsonResponse({ error: "use POST" }, 405);
	}
	// Secrets checked first (before auth) so a tokenless health probe can tell apart
	// route-missing (404) / secret-missing (500) / ready (401). Leaks only "configured
	// or not", never a value.
	const cfg = env as unknown as SupabaseAdminEnv;
	if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
		emitDiag(env, ctx, "accountDeleteMisconfig", "missing supabase secrets");
		return jsonResponse({ error: "server misconfigured" }, 500);
	}
	const base = cfg.SUPABASE_URL.replace(/\/$/, "");

	const authz = request.headers.get("Authorization") ?? "";
	const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
	if (!token) {
		return jsonResponse({ error: "missing bearer token" }, 401);
	}

	// 2. Verify the JWT → user id.
	let userId: string;
	try {
		const userResp = await fetch(`${base}/auth/v1/user`, {
			headers: { Authorization: `Bearer ${token}`, apikey: cfg.SUPABASE_SERVICE_ROLE_KEY },
		});
		if (!userResp.ok) {
			emitDiag(env, ctx, "accountDeleteAuth", `verify ${userResp.status}`);
			return jsonResponse({ error: "invalid or expired session" }, 401);
		}
		const user = (await userResp.json()) as { id?: string };
		if (!user.id) {
			emitDiag(env, ctx, "accountDeleteAuth", "no user id in token");
			return jsonResponse({ error: "invalid session" }, 401);
		}
		userId = user.id;
	} catch (e) {
		emitDiag(env, ctx, "accountDeleteAuth", `verify threw: ${(e as Error).message.slice(0, 40)}`);
		return jsonResponse({ error: "could not verify session" }, 502);
	}

	// 2b. Revoke the Sign in with Apple credential (guideline 5.1.1(v)) BEFORE deleting,
	// so Apple stops treating the user as linked. Best-effort and fully non-fatal: a
	// missing token (existing users pre-migration), unconfigured SIWA secrets, or Apple
	// being down must NEVER block the delete — the user's data always gets removed. Every
	// branch emits a diag (no silent failures), then we fall through to the cascade.
	const appleEnv = env as unknown as AppleAuthEnv;
	try {
		if (!appleEnv.SIWA_PRIVATE_KEY || !appleEnv.SIWA_KEY_ID || !appleEnv.APPLE_TEAM_ID) {
			emitDiag(env, ctx, "appleRevokeSkip", "siwa not configured");
		} else {
			const refreshToken = await readAppleRefreshToken(appleEnv, userId);
			if (!refreshToken) {
				emitDiag(env, ctx, "appleRevokeSkip", `no token ${userId.slice(0, 8)}`);
			} else {
				await revokeRefreshToken(appleEnv, refreshToken);
				emitDiag(env, ctx, "appleRevoked", userId.slice(0, 8));
			}
		}
	} catch (e) {
		emitDiag(env, ctx, "appleRevokeFail", `${(e as Error).message.slice(0, 60)}`);
	}

	// 3. Hard-delete the auth user (default is a hard delete → FK cascade fires).
	try {
		const delResp = await fetch(`${base}/auth/v1/admin/users/${userId}`, {
			method: "DELETE",
			headers: {
				apikey: cfg.SUPABASE_SERVICE_ROLE_KEY,
				Authorization: `Bearer ${cfg.SUPABASE_SERVICE_ROLE_KEY}`,
			},
		});
		if (!delResp.ok) {
			const body = (await delResp.text()).slice(0, 60);
			emitDiag(env, ctx, "accountDeleteFail", `${delResp.status} ${body}`);
			return jsonResponse({ error: `deletion failed (${delResp.status})` }, 502);
		}
	} catch (e) {
		emitDiag(env, ctx, "accountDeleteFail", `delete threw: ${(e as Error).message.slice(0, 40)}`);
		return jsonResponse({ error: "deletion failed" }, 502);
	}

	emitDiag(env, ctx, "accountDeleted", userId.slice(0, 8));
	return jsonResponse({ ok: true }, 200);
}

/** POST /auth/apple-token-exchange — trade Apple's short-lived authorizationCode for a
 *  refresh_token and store it on the caller's profiles row (for later SIWA revocation).
 *  Body: { authorizationCode: string, userId: string }. Flow:
 *    1. Require Bearer <supabase-jwt>; verify against Supabase Auth → the real user id.
 *       We NEVER trust the client-supplied userId; it must match the token's id.
 *    2. Exchange the code at Apple (ES256 client_secret JWT), then upsert the
 *       refresh_token onto profiles.
 *  Fire-and-forget on the app side: failures emit diag + a non-2xx (the user's account
 *  still works; they just get a token on their next sign-in). */
async function handleAppleTokenExchange(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") {
		return jsonResponse({ error: "use POST" }, 405);
	}
	// Secrets checked before auth so a tokenless health probe tells apart route-missing
	// (404) / secret-missing (500) / ready (401). Leaks only "configured or not".
	const cfg = env as unknown as AppleAuthEnv;
	if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
		emitDiag(env, ctx, "appleExchangeMisconfig", "missing supabase secrets");
		return jsonResponse({ error: "server misconfigured" }, 500);
	}
	if (!cfg.SIWA_PRIVATE_KEY || !cfg.SIWA_KEY_ID || !cfg.APPLE_TEAM_ID) {
		emitDiag(env, ctx, "appleExchangeMisconfig", "missing siwa secrets");
		return jsonResponse({ error: "server misconfigured" }, 500);
	}
	const base = cfg.SUPABASE_URL.replace(/\/$/, "");

	const authz = request.headers.get("Authorization") ?? "";
	const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
	if (!token) {
		return jsonResponse({ error: "missing bearer token" }, 401);
	}

	// 1. Verify the JWT → user id (same pattern as handleAccountDelete).
	let userId: string;
	try {
		const userResp = await fetch(`${base}/auth/v1/user`, {
			headers: { Authorization: `Bearer ${token}`, apikey: cfg.SUPABASE_SERVICE_ROLE_KEY },
		});
		if (!userResp.ok) {
			emitDiag(env, ctx, "appleExchangeAuth", `verify ${userResp.status}`);
			return jsonResponse({ error: "invalid or expired session" }, 401);
		}
		const user = (await userResp.json()) as { id?: string };
		if (!user.id) {
			emitDiag(env, ctx, "appleExchangeAuth", "no user id in token");
			return jsonResponse({ error: "invalid session" }, 401);
		}
		userId = user.id;
	} catch (e) {
		emitDiag(env, ctx, "appleExchangeAuth", `verify threw: ${(e as Error).message.slice(0, 40)}`);
		return jsonResponse({ error: "could not verify session" }, 502);
	}

	// Parse the body; the client-supplied userId must match the token's id.
	let body: { authorizationCode?: string; userId?: string };
	try {
		body = (await request.json()) as { authorizationCode?: string; userId?: string };
	} catch {
		return jsonResponse({ error: "invalid JSON body" }, 400);
	}
	if (!body.authorizationCode) {
		return jsonResponse({ error: "missing authorizationCode" }, 400);
	}
	// Case-insensitive: Supabase returns a lowercase UUID, while the app's
	// UUID.uuidString is uppercase — same id, different case. The stored row keys off
	// the authoritative token-derived `userId`, never the body value.
	if (body.userId && body.userId.toLowerCase() !== userId.toLowerCase()) {
		emitDiag(env, ctx, "appleExchangeAuth", "body userId != token userId");
		return jsonResponse({ error: "user mismatch" }, 403);
	}

	// 2. Exchange at Apple + store. Either step failing is non-fatal to the user (the app
	// treats this fire-and-forget), but we fail LOUD with a diag + non-2xx.
	try {
		const refreshToken = await exchangeAuthorizationCode(cfg, body.authorizationCode);
		await storeAppleRefreshToken(cfg, userId, refreshToken);
	} catch (e) {
		emitDiag(env, ctx, "appleExchangeFail", `${(e as Error).message.slice(0, 60)}`);
		return jsonResponse({ error: "token exchange failed" }, 502);
	}

	emitDiag(env, ctx, "appleTokenStored", userId.slice(0, 8));
	return jsonResponse({ ok: true }, 200);
}

/** NO SILENT FAILURES (proxy edition): write one operational event to the SAME KV +
 *  record shape the app's `POST /telemetry` sink uses (see handleTelemetryIngest), so a
 *  proxy-side miss surfaces in the owner's `GET /telemetry/recent` Diagnostics alongside
 *  app telemetry. Best-effort, non-PII. */
function emitDiag(env: Env, ctx: ExecutionContext, kind: string, detail: string): void {
	const record = {
		at: new Date().toISOString(),
		app: "proxy",
		os: "worker",
		events: [{ kind: kind.slice(0, 40), detail: detail.slice(0, 80), ts: Date.now() }],
	};
	console.log("telemetry", JSON.stringify(record));
	const key = `diag:${1e15 - Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
	ctx.waitUntil(env.FEED_TAGS.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 }));
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
 *  publish date. The date falls back to JSON-LD `datePublished` when there's no
 *  `<meta article:published_time>` — several club platforms (the MLS digital platform
 *  behind Houston/Utah/Orlando/Portland/etc.) carry the date ONLY in JSON-LD, so
 *  without this the date gate would drop every one of their articles. */
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

	const ld = extractJsonLdArticle(html);
	return {
		title: meta("og:title")?.trim() ?? ld?.headline?.trim(),
		description: meta("og:description") ?? ld?.description,
		image: meta("og:image") ?? ld?.image,
		// Date precedence: og: → JSON-LD → microdata `<meta itemprop="datePublished">`
		// (WordPress/Yoast on some club sites) → `<time datetime>`. Without the last two,
		// sites that expose the date ONLY as microdata (e.g. denversummitfc.com) get dropped.
		published:
			meta("article:published_time") ?? ld?.datePublished ?? metaDate(html) ?? timeDate(html),
	};
}

/** `<meta itemprop="datePublished" content="…">` (Schema.org microdata), either attr order. */
function metaDate(html: string): string | undefined {
	const m =
		/<meta[^>]*\bitemprop="datePublished"[^>]*\bcontent="([^"]+)"/i.exec(html) ??
		/<meta[^>]*\bcontent="([^"]+)"[^>]*\bitemprop="datePublished"/i.exec(html);
	return m ? m[1] : undefined;
}

/** First `<time datetime="…">` on the page (the article's published time on most CMS templates). */
function timeDate(html: string): string | undefined {
	const m = /<time[^>]*\bdatetime="([^"]+)"/i.exec(html);
	return m ? m[1] : undefined;
}

/** Pull date/headline/image from a page's JSON-LD Article node (NewsArticle / Article /
 *  BlogPosting). Best-effort: scans each `<script type="application/ld+json">`, handles a
 *  bare object, an array, or an `@graph`. Returns the first article-typed node found. */
export function extractJsonLdArticle(
	html: string,
): { datePublished?: string; headline?: string; image?: string; description?: string } | undefined {
	const blocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
	for (const block of blocks) {
		const json = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch {
			continue; // malformed LD block — skip
		}
		const root = parsed as { [k: string]: unknown };
		const nodes: unknown[] = Array.isArray(parsed)
			? parsed
			: Array.isArray(root["@graph"])
				? (root["@graph"] as unknown[])
				: [parsed];
		for (const node of nodes) {
			const n = node as { [k: string]: unknown };
			const t = n?.["@type"];
			const types = Array.isArray(t) ? t : [t];
			if (!types.some((x) => /(news)?article|blogposting/i.test(String(x ?? "")))) continue;
			const rawImg = Array.isArray(n.image) ? n.image[0] : n.image;
			const img =
				typeof rawImg === "string" ? rawImg : ((rawImg as { url?: string })?.url ?? undefined);
			return {
				datePublished: typeof n.datePublished === "string" ? n.datePublished : undefined,
				headline: typeof n.headline === "string" ? n.headline : undefined,
				image: typeof img === "string" ? img : undefined,
				description: typeof n.description === "string" ? n.description : undefined,
			};
		}
	}

	// Fallback: some club platforms (the MLS digital platform behind Houston/Orlando/
	// Utah) ship the NewsArticle's "headline"/"datePublished"/"image" inline in a JS/JSON
	// blob — no og: tags, no parseable ld+json <script>. Targeted regex recovers them
	// (a NewsArticle page carries one canonical headline+date pair).
	const field = (key: string): string | undefined => {
		const m = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "i").exec(html);
		return m ? decodeEntities(m[1]) : undefined;
	};
	const datePublished = field("datePublished");
	const headline = field("headline");
	if (datePublished || headline) {
		const imgM = /"(?:thumbnailUrl|leadMediaUrl|image)"\s*:\s*"(https?:\/\/[^"]+)"/i.exec(html);
		return {
			datePublished,
			headline,
			image: imgM ? decodeEntities(imgM[1]) : undefined,
			description: undefined,
		};
	}
	return undefined;
}

/** WordPress/CMS placeholder posts that aren't real club news (a brand-new club site
 *  with only the default first post). Filtered so the club falls back gracefully to
 *  the outlet fallback + a `clubNewsFallback` diag, instead of surfacing junk. */
export function isPlaceholderArticle(title: string): boolean {
	return /^(hello world!?|sample post|uncategorized|test post)$/i.test(title.trim());
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
async function buildNewsCards(teams: string[], env: Env, ctx: ExecutionContext): Promise<unknown[]> {
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
						sourceType: "news",
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

	// Haiku FIRST (drop non-NWSL + non-followed-team + route), so we only spend OG
	// scrapes on keepers.
	const kept = await tagNewsTeams(perFeed.flat(), teams, env, ctx);
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
		const [rawReporters, rawLeague, teamCards, newsCards, social] = await Promise.all([
			buildBlueskyCards(reporterHandles),
			buildBlueskyCards(leagueHandles),
			buildTeamBlueskyCards(teams),
			// News (B1): per-outlet RSS → Haiku NWSL-gate + team-tag + followed-team
			// filter → OG-enrich → newsArticle cards. Self-isolating; failures yield [].
			buildNewsCards(teams, env, ctx),
			// Social (B3b): the cron-built IG snapshot; here we take the player
			// clips (placement "feed") routed to the followed teams. Club Bluesky is
			// already in teamCards (now placement "feed" too).
			readSocialCards(env),
		]);
		// Reporter + league-outlet Bluesky carry no team tag of their own and post
		// off-topic too → one Haiku pass gates relevance, team-tags, and filters to
		// the followed teams (classifySocialBluesky). Club-official Bluesky (teamCards)
		// and player IG (playerSocial) are trusted fast paths — already team-tagged,
		// no Haiku. News is gated+filtered inside buildNewsCards.
		const socialBluesky = await classifySocialBluesky(
			[...rawReporters, ...rawLeague],
			teams,
			env,
			ctx,
		);
		const playerSocial = socialFor(social, teams, new Set(["feed"]));
		cards = [...socialBluesky, ...teamCards, ...newsCards, ...playerSocial].sort(
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
		// Source class for the app's Feed chips (Clubs · Reporters · …). Players come
		// from the IG pipe; here it's club-official / reporter / league-outlet.
		sourceType: isTeam ? "club" : h.kind === "league" ? "league" : "reporter",
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

interface SocialVerdict {
	id: string;
	isNWSL: boolean;
	teams: string[];
	leagueNews: boolean;
}
type FeedCard = {
	id?: string;
	handle?: string;
	bodyText?: string;
	teamAbbreviation?: string;
	isLeague?: boolean;
	sourceType?: string; // "club" | "league" | "reporter" | "player" | "news" — gates reporter vs league
};

/**
 * The shared keep/tag/drop rule for the Haiku-classified feed buckets (social
 * Bluesky + news). Given a verdict (or undefined when unjudged) and the requested
 * followed teams:
 *  - non-NWSL → drop;
 *  - tagged to specific team(s) → keep ONLY if one is followed (return its abbr so
 *    the caller colors/labels the card), else drop (someone else's team);
 *  - no team → keep as league-wide ONLY if it clears the league-news bar
 *    (`requireLeagueNews`); otherwise drop.
 * `failClosed` decides an UNJUDGED item (KV miss + Haiku outage/no key): social
 * fails CLOSED (drop the leak, per owner); news fails OPEN (keep league-wide,
 * staying resilient). A kept item with no `abbr` is league-wide (caller sets
 * isLeague true).
 */
export function decideFeedItem(
	v: { isNWSL: boolean; teams: string[]; leagueNews?: boolean } | undefined,
	followed: Set<string>,
	opts: { requireLeagueNews: boolean; failClosed: boolean },
): { keep: boolean; abbr?: string } {
	if (!v) return opts.failClosed ? { keep: false } : { keep: true };
	if (!v.isNWSL) return { keep: false };
	const tagged = (v.teams ?? []).filter((t) => NEWS_TEAM_ABBR_SET.has(t));
	if (tagged.length > 0) {
		const hit = tagged.filter((t) => followed.has(t));
		return hit.length > 0 ? { keep: true, abbr: hit[0] } : { keep: false };
	}
	if (opts.requireLeagueNews && !v.leagueNews) return { keep: false };
	return { keep: true }; // genuinely league-wide
}

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
		// Source class for the app's Feed chips (Clubs vs Players — both are
		// socialVideo/IG, so the layout alone can't tell them apart).
		sourceType: h.kind === "team" ? "club" : "player",
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
 * Classify the third-party Bluesky bucket (reporter + league-outlet posts): gate
 * relevance AND team-tag, then keep/drop per decideFeedItem against the requested
 * `teams`. A post about a followed club gets that club's abbr (color/label); a
 * genuinely league-wide NWSL-news post is kept league-wide; off-topic, non-followed
 * -team, and general-chatter posts are dropped. Each post's verdict is cached in KV
 * by its stable post id under a versioned key (`sv2-`, so the schema change
 * invalidates the old relevance-only verdicts); only never-seen posts hit Haiku on a
 * miss. Fails toward DROP when unjudged (KV miss + Haiku error/no key) — the club +
 * player fast paths keep the feed populated. KV writes are deferred via
 * ctx.waitUntil so tagging never blocks longer than the one Haiku round-trip.
 */
// Deterministic backstop for the Haiku social gate. A post that centers a NON-NWSL
// competition (England's WSL, Liga F, the UWCL, …) and carries NO NWSL/USWNT signal is
// dropped even if Haiku mislabels it `isNWSL` — Haiku is probabilistic, and these
// foreign-league false positives (e.g. a 5-month-old "WSL audience in Japan" post)
// should never reach the feed. Conservative: fires ONLY when a foreign-league phrase is
// present AND nothing ties the post to the NWSL, so genuine NWSL posts that merely name
// another league in comparison still pass (they'll carry an NWSL signal). `\bWSL\b` does
// not match inside "NWSL" (no word boundary before the W).
const FOREIGN_LEAGUE_RE =
	/\bWSL\b|women'?s super league|\bliga\s?f\b|frauen[-\s]?bundesliga|uefa women|women'?s champions league|\bUWCL\b|d1 arkema|premi[eè]re ligue/i;
const NWSL_SIGNAL_RE =
	/\bNWSL\b|\bUSWNT\b|national women'?s soccer|angel city|\bbay fc\b|boston legacy|chicago stars|gotham|houston dash|kansas city current|north carolina courage|orlando pride|portland thorns|racing louisville|san diego wave|seattle reign|utah royals|washington spirit/i;

export function centersNonNWSLLeague(text: string | undefined): boolean {
	if (!text) return false;
	return FOREIGN_LEAGUE_RE.test(text) && !NWSL_SIGNAL_RE.test(text);
}

async function classifySocialBluesky(
	cards: unknown[],
	teams: string[],
	env: Env,
	ctx: ExecutionContext,
): Promise<unknown[]> {
	const typed = cards as FeedCard[];
	if (typed.length === 0) return [];
	const followed = new Set(teams);
	const verdicts = new Map<string, SocialVerdict>();
	const vkey = (id: string) => `sv2-${id}`;

	// 1. Load cached verdicts (one KV read per card; misses return null).
	const cached = await Promise.all(
		typed.map((c) => (c.id ? env.FEED_TAGS.get(vkey(c.id), "json") : Promise.resolve(null))),
	);
	const uncached: FeedCard[] = [];
	typed.forEach((c, i) => {
		const v = cached[i] as SocialVerdict | null;
		if (v) verdicts.set(c.id!, v);
		else if (c.id) uncached.push(c);
	});

	// 2. Classify the misses via Haiku, batched. No key → skip (those fail closed below).
	if (uncached.length > 0 && env.ANTHROPIC_API_KEY) {
		for (let i = 0; i < uncached.length; i += HAIKU_BATCH) {
			const batch = uncached.slice(i, i + HAIKU_BATCH);
			let out: SocialVerdict[] | null;
			try {
				out = await haikuClassifySocialBatch(batch, env.ANTHROPIC_API_KEY);
			} catch {
				out = null; // fail closed: this batch stays unjudged → dropped below
			}
			if (out) {
				for (const v of out) {
					if (!v?.id) continue;
					const tms = (v.teams ?? []).filter((t) => NEWS_TEAM_ABBR_SET.has(t));
					const clean: SocialVerdict = {
						id: v.id,
						isNWSL: v.isNWSL === true,
						teams: tms,
						leagueNews: v.leagueNews === true,
					};
					verdicts.set(v.id, clean);
					ctx.waitUntil(
						env.FEED_TAGS.put(vkey(v.id), JSON.stringify(clean), { expirationTtl: TAG_TTL }),
					);
				}
			}
		}
	}

	// 3. Keep + tag (or drop). Social fails CLOSED on an unjudged post. The league-wide
	//    bar is split by source: official LEAGUE outlets must clear the hard-news bar
	//    (requireLeagueNews), but REPORTERS don't — a reporter's value is exactly the
	//    analysis / rumor / transfer chatter that bar would drop, so general league-wide
	//    NWSL reporter posts are kept (still gated on isNWSL + still fail-closed). The
	//    MAX_PER_HANDLE cap bounds how many any one reporter contributes.
	const keepers: unknown[] = [];
	for (const c of typed) {
		// Deterministic foreign-league backstop — drop before trusting the Haiku verdict
		// (also catches stale cached verdicts, no cache-key bump needed).
		if (centersNonNWSLLeague(c.bodyText)) continue;
		const v = c.id ? verdicts.get(c.id) : undefined;
		const isReporter = c.sourceType === "reporter";
		const d = decideFeedItem(v, followed, { requireLeagueNews: !isReporter, failClosed: true });
		if (!d.keep) continue;
		if (d.abbr) {
			c.teamAbbreviation = d.abbr;
			c.isLeague = false;
		} else {
			c.teamAbbreviation = undefined;
			c.isLeague = true;
		}
		keepers.push(c);
	}
	return keepers;
}

/** Classify one batch of social posts via a single Haiku call (forced JSON). */
async function haikuClassifySocialBatch(cards: FeedCard[], apiKey: string): Promise<SocialVerdict[]> {
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
					content: `${SOCIAL_POLICY}\n\nClassify each post. Echo its id exactly.\n\n${list}`,
				},
			],
			output_config: { format: { type: "json_schema", schema: SOCIAL_SCHEMA } },
		}),
	});
	if (!r.ok) throw new Error(`haiku ${r.status}`);

	const json = (await r.json()) as { content?: Array<{ type?: string; text?: string }> };
	const text = json.content?.find((b) => b.type === "text")?.text;
	if (!text) throw new Error("haiku: no text block");
	return (JSON.parse(text) as { verdicts?: SocialVerdict[] }).verdicts ?? [];
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
 * Gate each news card on NWSL relevance, tag the keepers to team(s), AND filter by
 * the requested `teams` (verdict KV-cached by card id, ~7d). Per decideFeedItem: a
 * card judged non-NWSL is dropped; a card tagged to specific team(s) is kept ONLY if
 * one is followed (tagged for color), else dropped (someone else's team); a
 * league-wide NWSL card is kept league-wide and shown to all followers. News fails
 * OPEN (no key / Haiku error → kept league-wide) so an outage degrades to the
 * un-gated feed rather than an empty chip. Unknown abbreviations are ignored.
 */
async function tagNewsTeams(
	cards: NewsCard[],
	teams: string[],
	env: Env,
	ctx: ExecutionContext,
): Promise<NewsCard[]> {
	if (cards.length === 0) return cards;
	const followed = new Set(teams);
	const verdicts = new Map<string, NewsVerdict>();

	// 1. Load cached verdicts (one KV read per card; misses return null). The key is
	//    versioned (`nv2-`) so tightening the policy/schema can be rolled by bumping
	//    the version rather than waiting out every cached verdict's TTL. (nv1→nv2:
	//    dropped the USWNT/national-team relevance allowance.)
	const vkey = (id: string) => `nv2-${id}`;
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

	// 3. Keep + tag (or drop) per the shared rule. News fails OPEN on an unjudged
	//    card (kept league-wide) and has no league-news bar (an article is news).
	const keepers: NewsCard[] = [];
	for (const c of cards) {
		const v = verdicts.get(c.id);
		const d = decideFeedItem(v, followed, { requireLeagueNews: false, failClosed: false });
		if (!d.keep) continue;
		if (d.abbr) {
			c.teamAbbreviation = d.abbr;
			c.isLeague = false;
		} else {
			c.teamAbbreviation = undefined;
			c.isLeague = true;
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

const TRIVIA_TTL = 6 * 3600; // 6h edge cache — the question pool changes rarely (owner reloads via scripts/load_trivia.mjs)
const TRIVIA_POOL_KEY = "trivia-pool-v1"; // KV key for the owner-loaded question pool

/** Daily Trivia's question pool. League-wide (no `teams` param) and read-only:
 *  returns the owner-loaded `[TriviaQuestion]` array straight from KV (loaded via
 *  scripts/load_trivia.mjs). Returns `[]` when the pool hasn't been loaded yet —
 *  the app then falls back to its bundled seed — so the route is safe to deploy
 *  before the pool exists. (A reload is picked up after the 6h edge cache expires.) */
async function handleTrivia(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const cache = caches.default;
	// Normalized, versioned cache key: the pool is league-wide, so every request
	// (with or without a cache-busting query) maps to ONE entry. `cv` is a manual
	// cache-version lever — bump it to abandon a stale edge entry without waiting
	// out the TTL.
	const cacheUrl = new URL(url);
	cacheUrl.search = "";
	cacheUrl.searchParams.set("cv", "1");
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let pool: unknown[] = [];
	try {
		pool = ((await env.FEED_TAGS.get(TRIVIA_POOL_KEY, "json")) as unknown[] | null) ?? [];
	} catch {
		// A KV read failure serves a stale copy if we have one, else 502 (the app
		// falls back to its seed on any non-2xx).
		return (await serveStale(cache, cacheKey)) ?? upstreamError();
	}

	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	// Never cache an EMPTY pool — at the edge OR on the client. A `[]` sent with a 6h max-age
	// would make URLSession keep serving "no trivia" for 6h after a load; `no-store` re-checks
	// each launch until the pool exists. Only a real pool gets the long TTL + edge cache.
	headers.set("Cache-Control", pool.length > 0 ? `public, max-age=${TRIVIA_TTL}` : "no-store");
	const body = new Response(JSON.stringify(pool), { status: 200, headers });
	if (pool.length > 0) {
		ctx.waitUntil(cache.put(cacheKey, body.clone()));
	}
	return withCacheStatus(body, "MISS");
}

const KNOWHER_TTL = 5 * 60; // 5 min — SHORT so owner content edits (iteration + the weekly swap) go live
// near-instantly, not after 6h. The pool is tiny, so a 5-min edge/client cache still sheds ~all load.
const KNOWHER_ELIGIBLE_TTL = 3600; // 1h — roster stats move a few times/day

/** Know Her Game's weekly pool, filtered to the requested `teams` (docs §3/§4): the app
 *  fetches `?teams=WAS,POR` and gets only those followed teams' featured players. Returns an
 *  empty `players` array (never cached) when the pool hasn't been loaded — the app then hides
 *  the game (online-only, no seed). Content lives in KV `knowher-pool-v1`, loaded by the owner
 *  via GET /knowher/admin (manual mode) or the deferred auto generator. */
async function handleKnowHer(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const teams = normalizeTeams(url.searchParams.get("teams"));

	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.search = "";
	cacheUrl.searchParams.set("teams", teams.join(","));
	cacheUrl.searchParams.set("cv", "2"); // bump to abandon the old 6h-TTL edge entries on deploy
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let pool: KnowHerPool | null;
	try {
		pool = (await env.FEED_TAGS.get(KNOWHER_POOL_KEY, "json")) as KnowHerPool | null;
	} catch {
		// A KV read failure serves a stale copy if we have one, else 502 (the app treats any
		// non-2xx as "couldn't load" and hides the game — no seed fallback, online-only).
		return (await serveStale(cache, cacheKey)) ?? upstreamError();
	}

	const filtered = pool ? filterPoolByTeams(pool, teams) : { weekKey: "", season: 0, players: [] };
	const hasPlayers = filtered.players.length > 0;
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	// Never cache an EMPTY result — not at the edge AND not on the client. An empty response
	// means the game isn't available yet (pre-load / offseason / no featured followed team); if
	// the CLIENT caches that for 6h (URLSession honors max-age), it keeps showing "no game" long
	// after the pool is loaded. `no-store` makes the app re-check every launch until content lands.
	headers.set("Cache-Control", hasPlayers ? `public, max-age=${KNOWHER_TTL}` : "no-store");
	const body = new Response(JSON.stringify(filtered), { status: 200, headers });
	if (hasPlayers) {
		ctx.waitUntil(cache.put(cacheKey, body.clone()));
	}
	return withCacheStatus(body, "MISS");
}

/** Roster-learning eligibility for one team (docs §4): `?team=WAS` → the players who started
 *  ≥ 1 match this season, ranked core-starters-first. Powers the admin's "who's pickable" view
 *  and the deferred auto generator's weekly selection. */
async function handleKnowHerEligible(url: URL, env: Env): Promise<Response> {
	const team = (url.searchParams.get("team") ?? "").toUpperCase();
	if (!team) return new Response(`Missing ?team=`, { status: 400 });
	const year = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
	const cache = caches.default;
	const cacheKey = new Request(url.toString(), { method: "GET" });
	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let players;
	try {
		players = await computeEligiblePlayers(team, year);
	} catch {
		return upstreamError();
	}
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", `public, max-age=${KNOWHER_ELIGIBLE_TTL}`);
	const body = new Response(JSON.stringify({ team, year, count: players.length, players }), { status: 200, headers });
	if (players.length > 0) {
		// Note: no ctx here (admin/debug endpoint) — cache synchronously via the returned clone.
		await cache.put(cacheKey, body.clone());
	}
	return withCacheStatus(body, "MISS");
}

const CREST_TTL = 30 * 24 * 3600; // 30d edge cache — team crests effectively never change

/** Serve the asset version manifest: `GET /crest/manifest` →
 *  `{ generatedAt, crests: {ABBR: hash}, flags: {CODE: hash} }`. The app's AssetRefreshService
 *  diffs this against the hashes it bundled and re-downloads ONLY a crest/flag whose source
 *  master changed (a rebrand). Each hash is sha256(sourceMaster) truncated to 16 hex — the SAME
 *  masters the app hashed at build time — so a fresh install matches and nothing re-downloads.
 *  Built offline by `scripts/build_asset_manifest.mjs` and stored in KV `asset:manifest`. */
async function handleAssetManifest(env: Env): Promise<Response> {
	let json: string | null;
	try {
		json = await env.FEED_TAGS.get("asset:manifest");
	} catch {
		return new Response("manifest unavailable", { status: 502 });
	}
	// Not built yet → empty manifest (the app then keeps every bundled asset; never an error path).
	const body = json ?? JSON.stringify({ crests: {}, flags: {} });
	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": `public, max-age=${CREST_TTL}`,
		},
	});
}

/** The data-driven women's national-team directory: `GET /national-teams` → a deduped, name-sorted
 *  `[{code, name, flag}]` built from the UNION of ESPN's `/teams` across the women's national-team
 *  feeds. Lets the app's "Browse all" list reflect real ESPN coverage and pick up future additions
 *  with no app release (and no hand-maintained list). `flag` is ESPN's own country-flag href, keyed
 *  by the same code that identifies the team (no FIFA→ISO translation that could mis-flag a team).
 *  Edge-cached 24h — rosters change rarely. Keep WOMENS_NT_FEEDS in sync with the app's
 *  NationalTeamFeed.all (the same feeds it pulls fixtures from). */
const WOMENS_NT_FEEDS = [
	"fifa.friendly.w", "fifa.shebelieves", "concacaf.w.gold", "concacaf.womens.championship",
	"uefa.weuro", "fifa.wwc", "fifa.w.olympics",
];
const NATIONAL_TEAMS_TTL = 24 * 3600;

const NATIONAL_TEAMS_CV = "2"; // bump to drop the stale edge-cached directory after a feed change
async function handleNationalTeams(ctx: ExecutionContext): Promise<Response> {
	const cacheKey = new Request(`https://nwslapp-proxy/national-teams?cv=${NATIONAL_TEAMS_CV}`, { method: "GET" });
	const cache = caches.default;
	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	const byCode = new Map<string, { code: string; name: string; flag: string }>();
	await Promise.all(
		WOMENS_NT_FEEDS.map(async (slug) => {
			try {
				const res = await fetch(
					`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams`,
					{ headers: { "User-Agent": "Mozilla/5.0 Chrome/120" } },
				);
				if (!res.ok) return;
				const data = (await res.json()) as {
					sports?: { leagues?: { teams?: { team?: { abbreviation?: string; displayName?: string; logos?: { href?: string }[] } }[] }[] }[];
				};
				const teams = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
				for (const entry of teams) {
					const team = entry.team ?? {};
					const code = (team.abbreviation ?? "").toUpperCase();
					if (!code || byCode.has(code)) continue;
					byCode.set(code, { code, name: team.displayName ?? code, flag: team.logos?.[0]?.href ?? "" });
				}
			} catch {
				/* a single feed failing just narrows coverage; never fail the whole list */
			}
		}),
	);

	const list = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
	const body = new Response(JSON.stringify(list), {
		status: 200,
		headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${NATIONAL_TEAMS_TTL}` },
	});
	ctx.waitUntil(cache.put(cacheKey, body.clone()));
	return withCacheStatus(body, "MISS");
}

/** Collect the app's NO-SILENT-FAILURE telemetry: `POST /telemetry` with a small JSON batch of
 *  NON-PII operational events (kind + a short operational detail like a team abbr/host, a relative
 *  timestamp, app + OS version). Stores each batch in KV under a reverse-time key (newest first)
 *  with a 30-day TTL and logs it (visible in `wrangler tail`), so a field miss reaches the owner
 *  without a user report. Deliberately stores NO identifiers and NO client IP — App Store
 *  "Diagnostics" data, not linked to identity. Best-effort: malformed input is dropped, never 5xx. */
async function handleTelemetryIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") return new Response("POST only", { status: 405 });
	let body: { app?: unknown; os?: unknown; events?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return new Response("bad json", { status: 400 });
	}
	const raw = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
	// Whitelist + cap every field so nothing unexpected (or PII-shaped) is persisted.
	const events = raw
		.map((e) => {
			const ev = e as { kind?: unknown; detail?: unknown; ts?: unknown };
			return {
				kind: String(ev.kind ?? "").slice(0, 40),
				detail: String(ev.detail ?? "").slice(0, 80),
				ts: typeof ev.ts === "number" ? ev.ts : null,
			};
		})
		.filter((e) => e.kind);
	if (events.length === 0) return new Response(null, { status: 204 });

	const record = {
		at: new Date().toISOString(),
		app: String(body.app ?? "").slice(0, 20),
		os: String(body.os ?? "").slice(0, 20),
		events,
	};
	console.log("telemetry", JSON.stringify(record));
	// Reverse-time key so a later list() returns newest-first. NO client IP stored.
	const key = `diag:${1e15 - Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
	ctx.waitUntil(env.FEED_TAGS.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 }));
	return new Response(null, { status: 204 });
}

/** Owner view of recent telemetry: `GET /telemetry/recent` (newest first), gated by the same
 *  `x-admin-key`/`BRACKET_ADMIN_KEY` secret as the other admin routes. */
async function handleTelemetryRecent(request: Request, env: Env): Promise<Response> {
	const key = (env as unknown as { BRACKET_ADMIN_KEY?: string }).BRACKET_ADMIN_KEY;
	if (!key || request.headers.get("x-admin-key") !== key) {
		return new Response("forbidden", { status: 403 });
	}
	const list = await env.FEED_TAGS.list({ prefix: "diag:", limit: 100 });
	const records = await Promise.all(list.keys.map((k) => env.FEED_TAGS.get(k.name)));
	const parsed = records.filter((s): s is string => s !== null).map((s) => JSON.parse(s));
	return Response.json(parsed);
}

/** Serve a team's NWSL crest as a transparent PNG: `GET /crest?team=WAS`. The PNGs are
 *  rasterized offline from NWSL's vector/raster sources (named-transform-only CDN ⇒ no clean
 *  client-side transparent PNG) and stored per team in KV (`crest:{ABBR}`) by
 *  scripts/load_crests.mjs. A team not loaded yet → 404, and the app keeps its existing ESPN
 *  crest (TeamLogo's fallback). Read-only and keyed by the normalized abbreviation, so every
 *  request for a team maps to one edge-cache entry. */
async function handleCrest(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	// Team comes from the path (`/crest/{ABBR}`, the preferred form) or the legacy
	// `?team=` query. The path form exists because a consumer's managed fetch cache can
	// pin a 404 keyed on the `/crest` path ALONE (ignoring the query), which a query
	// cache-version bump then can't evict — a per-team path sidesteps that entirely.
	const pathTeam = url.pathname.startsWith("/crest/") ? url.pathname.slice("/crest/".length) : "";
	const team = (pathTeam || url.searchParams.get("team") || "").toUpperCase().replace(/[^A-Z]/g, "");
	if (!team) return new Response("missing team", { status: 400 });

	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.search = "";
	cacheUrl.searchParams.set("team", team);
	cacheUrl.searchParams.set("cv", "3"); // manual cache-version lever (bump to drop stale edge crests)
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let bytes: ArrayBuffer | null;
	try {
		bytes = await env.FEED_TAGS.get(`crest:${team}`, "arrayBuffer");
	} catch {
		return new Response("crest unavailable", { status: 502 });
	}
	// `no-store` on the 404 so a consumer NEVER pins this miss in its managed cache (the
	// bug that made the self-hosted crest "dead": an early 404 cached for a day). The app
	// falls back to ESPN/ring on a 404 anyway.
	if (!bytes) return new Response("no crest for team", { status: 404, headers: { "Cache-Control": "no-store" } });

	const headers = new Headers();
	headers.set("Content-Type", "image/png");
	headers.set("Cache-Control", `public, max-age=${CREST_TTL}`);
	const body = new Response(bytes, { status: 200, headers });
	ctx.waitUntil(cache.put(cacheKey, body.clone()));
	return withCacheStatus(body, "MISS");
}

// Roster resilience: ESPN occasionally serves an implausibly small roster for a
// team (e.g. 1 player) while every other team is full. We cache the last-known-good
// roster in KV and serve it (with an honest `proxyCachedAsOf` marker) when ESPN
// comes back short — so the app stops over-relying on data ESPN doesn't prioritize.
const ESPN_ROSTER = (id: string) => `https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/teams/${id}/roster`;
const ROSTER_GOOD_MIN = 16; // a real NWSL squad is ~22–26; below this is implausible, not a small squad
const ROSTER_CACHE_TTL = 60 * 60 * 24 * 90; // 90d last-known-good
const ROSTER_EDGE_TTL = 60 * 60 * 6; // 6h upstream edge cache (fan-out); short so a healed roster recovers same-day

interface RosterCacheRecord {
	fetchedAt: string; // ISO timestamp of the good fetch (surfaced to the app as proxyCachedAsOf)
	body: unknown; // ESPN's roster payload, verbatim
}

export function athleteCount(body: unknown): number {
	const a = (body as { athletes?: unknown })?.athletes;
	return Array.isArray(a) ? a.length : -1;
}

/** Pure roster-serve decision (unit-tested; the route wires fetch/KV/diag around it):
 *  - "live": ESPN returned a plausible squad → serve it (and the caller caches it).
 *  - "cached": ESPN came back short but a fuller last-known-good exists → serve cached + marker.
 *  - "live-small": ESPN short and no better cache → serve the small live payload honestly.
 *  - "none": no live payload and no cache → caller 502s. */
export function chooseRosterServe(opts: {
	hasLive: boolean;
	liveCount: number;
	hasCached: boolean;
	cachedCount: number;
}): "live" | "cached" | "live-small" | "none" {
	const { hasLive, liveCount, hasCached, cachedCount } = opts;
	if (hasLive && liveCount >= ROSTER_GOOD_MIN) return "live";
	if (hasCached && cachedCount > liveCount) return "cached";
	if (hasLive) return "live-small";
	return "none";
}

/** Serialize a roster body. When served from the last-known-good cache, inject a top-level
 *  `proxyCachedAsOf` so the app can show an honest "Roster as of <date>" indicator. */
export function rosterResponse(body: unknown, cachedAsOf: string | null): Response {
	const out =
		cachedAsOf && body && typeof body === "object"
			? { ...(body as Record<string, unknown>), proxyCachedAsOf: cachedAsOf }
			: body;
	// Short max-age: a roster can change (and ESPN can heal), so fan-out briefly but don't pin.
	return Response.json(out, { headers: { "Cache-Control": "public, max-age=300" } });
}

/** Serve one club's roster: `GET /roster?team=<espnTeamId>`. Passes ESPN through when it
 *  returns a plausible squad (and caches it as last-known-good), but falls back to the cached
 *  roster when ESPN comes back implausibly small or fails — never silently (emits diag). */
async function handleRoster(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const id = (url.searchParams.get("team") ?? "").replace(/[^0-9]/g, "");
	if (!id) return new Response("missing ?team", { status: 400 });
	const kvKey = `roster:${id}`;

	// 1. Fetch ESPN live (briefly edge-cached for fan-out).
	let live: unknown = null;
	let liveCount = -1;
	try {
		const r = await fetch(ESPN_ROSTER(id), {
			headers: { Accept: "application/json" },
			cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": ROSTER_EDGE_TTL, "404": 0, "500-599": 0 } },
		});
		if (r.ok) {
			live = await r.json();
			liveCount = athleteCount(live);
		} else {
			emitDiag(env, ctx, "rosterUpstreamStatus", `${id} → ${r.status}`);
		}
	} catch (e) {
		emitDiag(env, ctx, "rosterUpstreamThrew", `${id}: ${(e as Error).message.slice(0, 40)}`);
	}

	// 2. Plausible squad → refresh last-known-good, serve verbatim (no marker).
	if (liveCount >= ROSTER_GOOD_MIN) {
		const record: RosterCacheRecord = { fetchedAt: new Date().toISOString(), body: live };
		ctx.waitUntil(env.FEED_TAGS.put(kvKey, JSON.stringify(record), { expirationTtl: ROSTER_CACHE_TTL }));
		return rosterResponse(live, null);
	}

	// 3. Implausibly small (or upstream failed) → fall back to last-known-good if it's fuller.
	let cached: RosterCacheRecord | null = null;
	try {
		cached = (await env.FEED_TAGS.get(kvKey, "json")) as RosterCacheRecord | null;
	} catch {
		/* KV read failure → treat as no cache, fall through */
	}
	const cachedCount = cached ? athleteCount(cached.body) : -1;
	const decision = chooseRosterServe({
		hasLive: live != null,
		liveCount,
		hasCached: cached != null,
		cachedCount,
	});
	if (decision === "cached" && cached) {
		emitDiag(env, ctx, "rosterStaleServe", `${id} live=${liveCount} cached=${cachedCount}`);
		return rosterResponse(cached.body, cached.fetchedAt);
	}
	if (decision === "live-small") {
		// Nothing better than the live (small) payload — serve it honestly (diag flags it).
		emitDiag(env, ctx, "rosterImplausibleNoCache", `${id} live=${liveCount}`);
		return rosterResponse(live, null);
	}
	// No live payload AND no cache to fall back to → loud failure.
	emitDiag(env, ctx, "rosterUnavailable", `${id} live=${liveCount} cached=${cachedCount}`);
	return new Response("roster unavailable", { status: 502 });
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
