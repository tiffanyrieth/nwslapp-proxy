/**
 * nwslapp-proxy — NWSLApp's ESPN caching proxy (V2 milestone 0.2.0).
 *
 * The core routes are transparent caching pass-throughs of ESPN's unofficial NWSL
 * endpoints: `GET /scoreboard` (the full-season fixture list) and `GET /summary`
 * (one match's rich detail, added in 0.3.1). Each forwards to ESPN, caches the
 * response at the edge, and fans out — so one upstream ESPN call serves every
 * app instance ("poll once, fan out"). Alongside them sit enriched endpoints that
 * add data ESPN doesn't carry (e.g. `/roster` last-known-good, and `/weather`, a
 * past match's historical kickoff temperature from Open-Meteo — see weather.ts).
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

import {
	runBracketTick,
	forceCloseActiveRound,
	handleBracketAdmin,
	ROSTER_GOOD_MIN,
	fetchTeamSeasonStats,
	fetchTeamAbbrs,
	fetchRosterResilient,
	mapEspnRosterAthletes,
	type BracketEnv,
} from "./bracket-engine.ts";
import { buildHeadshotMap, handleHeadshots, normalizeName } from "./headshots.ts";
import { adminAuthed, adminRealm } from "./admin-auth.ts";
import { handleAnalyticsAdmin } from "./analytics-admin.ts";
import { ADMIN_PORTAL_HTML } from "./admin-portal.ts";
import {
	runRosterTruth,
	readRosterTruthReport,
	readVerdicts,
	readOverrides,
	writeOverrides,
	applyOverrides,
	activeOverrides,
	overrideExpiry,
	applyAutoRulings,
	pendingAdjudications,
	OVERRIDE_TTL_DAYS,
	type OverrideMap,
	type RosterOverride,
	type AutoRuling,
} from "./roster-truth.ts";
import {
	handleKnowHerAdmin,
	computeEligiblePlayers,
	readFeaturedIds,
	pickWeeklyFeatured,
	filterPoolByTeams,
	publishKnowHerPool,
	stageKnowHerCandidate,
	readKnowHerCandidate,
	stageVerifiedCandidate,
	publishVerifiedPool,
	isoWeekKey,
	KNOWHER_POOL_KEY,
	type KnowHerPool,
	type KnowHerEnv,
} from "./knowher.ts";
import {
	publishTriviaPool,
	stageTriviaCandidate,
	readTriviaCandidate,
	resolveRound,
	sliceFlatPool,
	parseEditionKey,
	DEFAULT_GROUP_CONFIG,
	TRIVIA_POOL_V2_KEY,
	type TriviaPoolDoc,
	type TriviaQuestion,
	type TriviaEnv,
} from "./trivia.ts";
import { handleQuizResults } from "./quiz-results.ts";
import { handlePredictCommunity } from "./predict-community.ts";
import { handleWeather } from "./weather.ts";
import { attendanceSweep, enrichSummaryAttendance, handleAdminAttendance } from "./attendance.ts";
import { handlePlayoffOverride } from "./playoff-override.ts";
import {
	exchangeAuthorizationCode,
	storeAppleRefreshToken,
	readAppleRefreshToken,
	revokeRefreshToken,
	type AppleAuthEnv,
} from "./apple-auth.ts";

// Forced-update version gate (served at GET /config). To force everyone onto a newer TestFlight
// build, raise MIN_APP_BUILD (the integer the app compares against its CFBundleVersion) and redeploy.
// MIN_APP_VERSION is the informational marketing string.
//
// ⚠️ DEPLOY ORDER IS THE WHOLE RISK: raise this ONLY once the target build is LIVE AND INSTALLABLE on
// TestFlight. Deploying ahead of the build walls every user below it — including the owner's own
// device — with nowhere to go. It is a manual FLOOR and must never auto-track the latest build
// (see docs/versioning.md).
//
// 2026-07-31: 21 → 31, the FIRST raise since introduction. Retires builds ≤30 (28 was known-broken);
// until now the gate had never fired for anyone.
const MIN_APP_VERSION = "0.4.5";
const MIN_APP_BUILD = 31;

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
	"uefa.w.nations",                 // UEFA Women's Nations League (national teams — Euro WC/Olympic path)
	"fifa.wworldq.uefa",              // FIFA Women's World Cup Qualifying — UEFA
	"afc.w.asian.cup",                // AFC Women's Asian Cup (national teams — Asia)
	"caf.w.nations",                  // Women's Africa Cup of Nations (national teams — Africa)
	"conmebol.america.femenina",      // Copa América Femenina (national teams — South America)
	"fifa.wwcq.ply",                  // FIFA Women's World Cup Qualifying — inter-confederation playoff
	"fifa.w.concacaf.olympicsq",      // Concacaf Women's Olympic Qualifying
	"global.pinatar_cup",             // Pinatar Cup (national-team invitational)
	"global.w.finalissima",           // Women's Finalissima (Euro champ vs Copa América champ)
	"concacaf.w.champions_cup",       // Concacaf W Champions Cup (CLUB: NWSL clubs vs Liga MX)
	"usa.nwsl.cup",                   // NWSL Challenge Cup (CLUB: one annual NWSL-vs-NWSL match)
]);
const scoreboardUpstream = (slug: string) =>
	`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard`;
// `/summary?league=<slug>` mirrors the scoreboard's allowlisted-league pattern (same set — every
// slug we serve fixtures for can serve a match summary). NWSL stays the default so existing app
// builds and the watcher's pre-2026-08 lineup poll keep working unchanged. The cache key already
// forks per-league for free: proxyAndCache keys on the FULL incoming URL (query included), and
// strips `league` from the forwarded search before ESPN sees it.
const summaryUpstream = (slug: string) =>
	`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary`;

// Cache TTLs (seconds).
const LIVE_TTL = 30; // a match is in progress — keep scores/lineups fresh
const SCOREBOARD_DEFAULT_TTL = 300; // fixture list barely changes between matches
const SUMMARY_DEFAULT_TTL = 3600; // 1hr — safe fallback when summary state can't be read
const IMMUTABLE_TTL = 31536000; // 1yr — a SETTLED, COMPLETE match's data is final (see chooseSummaryTTL)
// A settled match whose record is still filling in (attendance lands hours-to-days late for some
// venues). Long enough to be nearly free, short enough that the number appears the same day.
const SUMMARY_PENDING_TTL = 21600; // 6h
// Past this, slow the re-check from 6h to weekly — but NEVER pin a zero as immutable. The old
// giveUp→IMMUTABLE promotion froze `attendance: 0` for a year on every match >14d old (the
// frozen-attendance regression, found 2026-08-09). Most NT matches never report attendance at
// all; the cold tier caps them at ~1 demand-driven fetch/week/colo, which is effectively free,
// while a figure that lands late (or a zero frozen by a past bug) still heals within a week.
// 14d → 30d (owner 2026-08-11): ESPN's Aug-2026 attendance ingestion ran late/never for weeks,
// so keep actively trying a full month. The attendanceSweep cron (attendance.ts) is the real
// engine now — it probes proactively instead of waiting for a visitor — but the demand tier
// keeps the same 30-day shape so the two mechanisms agree on what "still worth asking" means.
const SUMMARY_PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const SUMMARY_PENDING_COLD_TTL = 604800; // 7d — settled, old, still incomplete: re-check weekly
// Last-known-good snapshot lifetime (recovery-ladder step 3, see proxyAndCache). 24h: long enough
// to cover a full game day's ESPN outage, short enough that a rolled-over scoreboard window or a
// long-dead entry can't be served a week later.
const SNAPSHOT_TTL = 86400; // 24h
// What we tell the CLIENT to cache, regardless of the (much longer) edge TTL. A device that pins a
// summary for a year is unreachable: no server-side fix can reach it, because the device never even
// asks. The edge still absorbs the load — a client revalidation is an edge HIT, not an ESPN fetch.
const CLIENT_MAX_TTL = 3600; // 1h
// ⚠️ CACHE-KEY EPOCH — bump to orphan every cached summary/scoreboard on deploy. The Cache API is
// PER-COLO, so a Worker can only delete from the colo that happened to serve its own request, and
// `workers.dev` has no zone to purge through the Cloudflare API. Changing the KEY invalidates
// globally instead, at the cost of one re-fetch per distinct URL. Bumped to 2 on 2026-07-31 to
// evict summaries frozen mid-suspension by the `post`-means-final bug below (WAS @ UTA sat pinned
// at 23' with attendance 0 for a year, 1.9 days in when it was found). Bumped to 3 on 2026-08-09
// to evict settled-zero summaries pinned IMMUTABLE by the 14-day give-up (and any re-pinned via
// ESPN's own stale CDN before /summary busted upstream) — the frozen-attendance regression.
const CACHE_EPOCH = "3";
const TEAM_VIDEOS_TTL = 3600; // 1hr — a club's recent uploads change at most a few times/day
const TEAM_STATS_TTL = 3600; // 1hr — a squad's season stat totals only move after a match (a few times/week);
// 1h keeps the shared cache warm so the team page's ~27-athlete stat bundle is one edge-cached call, not 27
// per-device ESPN calls. Not a live surface — the live match card is elsewhere.

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
	| { kind: "api"; url: string } // a club JSON news API (e.g. NC's SDP dapi) → items mapped directly
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
	// NC Courage is a Next.js/RSC site whose HTML carries NO article list (js-rendered), but its
	// SDP `dapi` JSON API IS Worker-reachable and has everything inline → mapped directly by
	// clubApiCards. (Found via the browser network tab, 2026-08; the /news HTML is a bot-shell.)
	NC: { kind: "api", url: "https://www.nccourage.com/api/dapi/selection/latest-news" },
	// POR (Portland/Webflow) is configured `index`, but LIVE it returns 0 and auto-falls-back to
	// press: thorns.com serves the Worker's DATACENTER IP a JS-shell (no FinSweet data) even
	// though residential IPs get the full SSR. So extractIndexDates works ONLY when fed the real
	// HTML — POR needs the app-side device-IP fetch (dynamic fallback, Phase 2b), same as CHI.
	POR: { kind: "index", url: "https://www.thorns.com/news", articlePath: "/news/" },
	SEA: { kind: "index", url: "https://www.reignfc.com/news", articlePath: "/news/" },
	// These three live on a shared PARENT domain under a club sub-path (owner-confirmed
	// Jun 2026), NOT their own *.com — keep the sub-path in url AND articlePath:
	// HOU under the Houston Dynamo site, UTA on the RSL platform, ORL under Orlando City.
	HOU: { kind: "index", url: "https://www.houstondynamofc.com/houstondash/news/", articlePath: "/houstondash/news/" },
	UTA: { kind: "index", url: "https://www.rsl.com/utahroyals/news/", articlePath: "/utahroyals/news/" },
	ORL: { kind: "index", url: "https://www.orlandocitysc.com/pride/news/", articlePath: "/pride/news/" },

	// GFC (Gotham/Sanity): article pages have NO machine date, but each index card shows a
	// visible "August 2, 2026" that extractIndexDates reads → promoted from fallback to index
	// (2026-08 audit — verified live).
	GFC: { kind: "index", url: "https://www.gothamfc.com/news", articlePath: "/news/" },
	// BOS (Boston/Shopify): Shopify auto-generates a per-blog Atom feed — the press blog is
	// dated + structured (2026-08 audit — verified live). Promoted from fallback to rss.
	BOS: { kind: "rss", url: "https://bostonlegacyfc.com/blogs/press.atom" },

	// CHI: chicagostars.com/feed/ IS a valid dated WordPress RSS from a residential IP, but the
	// Worker's datacenter IP is IP/ASN-blocked (BROWSER_UA doesn't help). Left as `rss` on
	// PURPOSE: the Worker keeps trying (fails → press fallback), so the moment CHI stops blocking
	// this auto-promotes to official with no change. Meanwhile the app's DEVICE-IP fallback
	// (dynamic, Phase 2b) fetches this same feed from a residential IP and POSTs it to
	// /club-news/normalize — so CHI followers get official news now, and it self-heals later.
	CHI: { kind: "rss", url: "https://www.chicagostars.com/feed/" },
};

// A desktop-browser UA so article fetches get the full SSR'd HTML (with OG tags)
// rather than a stripped bot page.
const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ⚠️ ESPN bot rule: EVERY ESPN fetch needs the shared UA (ESPN 403s UA-less Worker fetches,
// 2026-08-04) — the constant + full story live in espn-ua.ts so no module can miss it again.
import { ESPN_UA, ESPN_HEADERS } from "./espn-ua.ts";

// Bluesky AT Protocol PUBLIC API (keyless, no auth) — backs the Feed's
// reporter/league/team posts (and the team voices merged onto Home).
const BSKY_PUBLIC = "https://public.api.bsky.app/xrpc";
const BSKY_UA = "nwslapp-proxy/0.3 (+https://nwslapp-proxy.tiffany-rieth.workers.dev)";
const FEED_TTL = 900; // 15min — the Feed is conversational, fresher than Home's 1h
const POSTS_PER_HANDLE = 12; // recent posts pulled per account (app applies staleness)

/** Hang bound for /feed's upstream fetches (Bluesky author feeds, outlet RSS, OG scrapes).
 *  GENEROUS by design — these normally answer in 1-2s, so 8s only converts a HUNG connection
 *  into that one source sitting out THIS refresh (per-source isolation + a diag at the call
 *  site; the next refresh retries it fresh). It must never skip a merely-slow-normal source.
 *  Added 2026-08-16 after one hung upstream dragged a cold /feed build past the app's 60s
 *  client timeout (owner-approved: fix the hang class only, never blanket-ignore a source). */
const UPSTREAM_FETCH_MS = 8000;
// TRUE cancellation (AbortController), not a bare Promise.race: workerd allows ~6 concurrent
// outbound connections per invocation, so a hung upstream doesn't just cost itself — it
// STARVES the lane queue for healthy sources behind it. Abort actually frees the lane.
// (Proven during the 2026-08-16 Bluesky degradation: 16 hung bsky fetches at 50s+ made a
// 0.6s Guardian RSS "time out" purely from queueing. A race-only bound can't fix that.)
async function fetchBounded(url: string, init?: RequestInit): Promise<Response> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), UPSTREAM_FETCH_MS);
	try {
		return await fetch(url, { ...init, signal: ac.signal });
	} catch (e) {
		if ((e as Error)?.name === "AbortError") throw Object.assign(new Error(`upstream hang >${UPSTREAM_FETCH_MS}ms`), { name: "TimeoutError" });
		throw e;
	} finally {
		clearTimeout(timer);
	}
}
const isTimeout = (e: unknown): boolean => ["TimeoutError", "AbortError"].includes((e as Error)?.name ?? "");

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

// B3b — Instagram social pipe, LOAD-BALANCED across two scrape services (swapped 2026-08-14):
//   PLAYERS (→ Feed tab) = Apify sones/instagram-posts-scraper-lowcost ($0.30/1k items).
//     The cheap actor ignores postsPerProfile and returns ~12/profile; players only ever
//     serve 3/handle (capPerHandle), so the excess is harmless and cheap.
//     34 × ~12 × ~15 runs/mo ≈ 6,120 items ≈ $1.84/mo — inside Apify's free $5.
//     Budget cap: ~90 handles fit the free tier; MAX_PLAYER_HANDLES guards the ceiling.
//   CLUBS (16 handles → Home tab) = Bright Data Web Scraper API (free 5,000 records/mo,
//     recurring). BD DOES honor a per-profile cap: 16 × 6 × ~15 ≈ 1,440 records/mo = $2.16.
//     ⚠️ BD bills a record even when a handle returns EMPTY (renamed/dead account) — a stale
//     handle list silently eats the free quota, so empties emit diag (bdHandleEmpty).
//   Until BRIGHTDATA_TOKEN is set, clubs fall back to the Apify run (full all-handle scrape,
//   the pre-split behavior) so the split deploys without a flag day.
// TikTok (clockworks/tiktok-scraper, $3.70/1k, no rental) is DEFERRED but its id + mapper
// are kept ready. Apify API path uses "~" for the actor "/".
// We DON'T scrape on the user request path (an 80-account sync run is too slow and would
// risk a Worker timeout). Instead a CRON refreshes the card snapshot into KV; /feed and
// /team-videos just READ that snapshot — pinning scrape spend to ~1 run/cron regardless
// of app traffic. The app's staleness filter (Home 72h / Feed 7d) drops old posts
// client-side, so a mixed-age snapshot is fine to display.
const APIFY_API = "https://api.apify.com/v2/acts";
const APIFY_IG_ACTOR = "sones~instagram-posts-scraper-lowcost";
const APIFY_TIKTOK_ACTOR = "clockworks~tiktok-scraper"; // deferred; kept ready for re-enable
const SOCIAL_POSTS_PER_PROFILE = 4; // requested of Apify (ignored by the cheap actor — see above)
// Bright Data Web Scraper API (clubs). ASYNC: the cron POSTs /trigger with the club
// profile URLs + webhook delivery params; BD scrapes (~1–3 min) then POSTs the finished
// JSON to /brightdata-webhook, echoing BD_WEBHOOK_SECRET in the Authorization header.
const BRIGHTDATA_API = "https://api.brightdata.com/datasets/v3";
const BRIGHTDATA_IG_DATASET = "gd_lk5ns7kz21pck8jpis"; // Instagram Posts scraper dataset id
const BD_POSTS_PER_PROFILE = 6; // BD honors per-profile caps; 3/handle is the serve cap anyway
const MAX_POOL_HANDLES = 80; // per-RUN budget guardrail: ~90 fit Apify's $5 free tier; 80 leaves headroom
const MAX_PLAYER_HANDLES = 160; // TOTAL ceiling = 2 rotating pools × 80 (owner 2026-08-17); still a CEILING, never a target
// The cron has no incoming request to derive its own origin from, so the webhook endpoint
// base is pinned here (workers.dev origin; update if the worker ever moves to a custom domain).
const PROXY_PUBLIC_ORIGIN = "https://nwslapp-proxy.tiffany-rieth.workers.dev";
// SPLIT snapshot keys: clubs and players have DIFFERENT writers (Apify = the cron itself;
// BD = the webhook, minutes later), so each side owns a KV key — two writers on one key
// would race. The legacy combined key remains a read-only fallback until both exist.
const SOCIAL_CACHE_KEY = "social-cards-v1"; // legacy combined snapshot (read fallback only)
const SOCIAL_CLUB_KEY = "social-cards-club-v1"; // written by the Bright Data webhook
const SOCIAL_PLAYER_KEY = "social-cards-player-v1"; // written by the Apify cron path
const SOCIAL_CACHE_TTL = 3 * 24 * 3600; // 3d KV safety net — the every-2-day cron refreshes well within it

// Social (reporter + league-outlet) Bluesky classifier. These accounts post
// off-topic too, so each post is gated AND team-tagged: isNWSL (strict — false
// for non-NWSL incl. men's soccer, foreign leagues, personal/off-topic), teams[]
// (the NWSL clubs it's primarily about; [] for genuinely league-wide), and
// leagueNews (a HIGH bar — true only for real league-wide NWSL news, not general
// reporter chatter/opinion). The keep/drop + tag rule lives in decideFeedItem,
// which fails toward DROP when a post is unjudged (fixes the old fail-open leak).
const SOCIAL_POLICY = `You are filtering and tagging Bluesky posts for an NWSL (US National Women's Soccer League) fan app. The posts come from soccer reporters/journalists and NWSL media/league accounts, who also post off-topic things (other sports, foreign leagues, men's soccer, personal life, general chatter).

For each post (handle + text) decide three things:
1. "isNWSL": true ONLY if the post is clearly about the NWSL — an NWSL club, an NWSL match/result/standing/award, a player at an NWSL club, a transfer into or out of an NWSL club, or the US women's national team (USWNT) — OR if an NWSL-rostered player is a PRIMARY SUBJECT of the post in ANY competition, including her own country's national team (a hat trick at WAFCON, a World Cup or Olympics performance, a continental tournament, an international friendly). Soccer is worldwide and NWSL players represent many countries: the NWSL connection is the PLAYER, not the competition. "Banda scores a hat trick for Zambia at WAFCON" → isNWSL true (Barbra Banda plays for Orlando Pride). PRIMARY SUBJECT is a real bar: the post must be meaningfully about her — her performance, her news, her story. Being one name among many (a tournament preview naming dozens of players, a best-XI list, a full squad announcement for a non-US country) is a passing mention, NOT primary-subject. false for everything else, INCLUDING women's soccer that isn't NWSL with no NWSL player as a primary subject (England's WSL, Liga F, the UEFA Women's Champions League, other foreign leagues), other sports (PWHL, WNBA), men's soccer (including the men's World Cup), and the author's personal/off-topic posts. A post that only mentions another league, market, or country in passing — the size of the WSL's audience, a foreign transfer market, broadcast deals abroad — is NOT about the NWSL. Example: "Japan is the joint-largest market for the WSL outside of the UK" is about England's WSL → isNWSL false. When you are unsure, return false.
2. "teams": if isNWSL, the NWSL club abbreviation(s) the post is primarily about; for a national-team post kept because of an NWSL player, tag HER NWSL CLUB (use the FEATURED NWSL PLAYERS list when present, plus your knowledge of current NWSL rosters); [] for genuinely league-wide/general NWSL or USWNT posts. If isNWSL is false, return [].
3. "leagueNews": true ONLY when isNWSL is true AND teams is empty AND the post is genuine league-wide NWSL NEWS — expansion, the schedule/fixtures release, awards/honors, the playoff race, rule/CBA/roster-rule changes, or other league-wide announcements. false for general opinion, hot takes, predictions, banter, or chatter not tied to hard news. If isNWSL is false or teams is non-empty, return false.

The 16 NWSL teams and their abbreviations:
LA = Angel City FC, BAY = Bay FC, BOS = Boston, CHI = Chicago Stars, DEN = Denver, GFC = Gotham FC, HOU = Houston Dash, KC = Kansas City Current, NC = North Carolina Courage, ORL = Orlando Pride, POR = Portland Thorns, LOU = Racing Louisville, SD = San Diego Wave, SEA = Seattle Reign, UTA = Utah Royals, WAS = Washington Spirit.

Rules: a single-team post → exactly that one abbreviation; a multi-team post → all clubs named; league-wide → []. Only use the 16 abbreviations above. Echo each post's id exactly.`;

/** The featured-player ↔ club map injected into BOTH classifier prompts (social + news) so
 *  Haiku can connect an international post to the player's NWSL club ("Banda scores for
 *  Zambia" → ORL). Built from the LIVE KV player list — the day the routine adds a player,
 *  the classifiers know her with no deploy. ~34–80 names ≈ trivial input tokens, and
 *  verdicts are cached per post, so cost impact is nil. */
function featuredPlayerMapBlock(players: PlayerSocialEntry[]): string {
	const pairs = players.map((p) => `${p.name} → ${p.abbr}`).join("; ");
	return `FEATURED NWSL PLAYERS (name → club; not exhaustive — any current NWSL player qualifies): ${pairs}.`;
}

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
1. "isNWSL": true ONLY if the article is primarily about the NWSL itself — an NWSL club, an NWSL match/standing/award/power-ranking, a player AT an NWSL club, a transfer INTO or OUT OF an NWSL club, or the US women's national team (USWNT) — OR if an NWSL-rostered player is a PRIMARY SUBJECT of the article in ANY competition, including her own country's national team (WAFCON, the World Cup, the Olympics, continental tournaments, friendlies). Soccer is worldwide and NWSL players represent many countries: she plays for her club AND her country, so an article about her national-team goal is news about an NWSL club's player. "Banda hat trick sends Zambia to the WAFCON final" → isNWSL true (Barbra Banda plays for Orlando Pride). PRIMARY SUBJECT is a real bar: the article must be meaningfully about her — her performance, her news, her story. Being one name among many (a tournament preview naming dozens, a squad-list announcement for a non-US country, a best-XI round-up) is a passing mention, NOT primary-subject. false for everything else, INCLUDING: women's soccer that isn't NWSL with no NWSL player as a primary subject (England's WSL, Spain's Liga F, the UEFA Women's Champions League, other foreign leagues); players moving between two non-NWSL clubs; other sports (PWHL, WNBA); and men's soccer. When unsure, return false.
2. "teams": if isNWSL, the NWSL club abbreviation(s) it is primarily about; for a national-team article kept because of an NWSL player, tag HER NWSL CLUB (use the FEATURED NWSL PLAYERS list when present, plus your knowledge of current NWSL rosters); [] for genuinely league-wide/general NWSL or USWNT news. If isNWSL is false, return [].

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

// Curated, API-VERIFIED Bluesky handles for the Feed's reporters + league outlets.
// Every handle was confirmed to currently return posts from the keyless public
// AT-Proto API; dead/dormant candidates were dropped. All render as blueskyReporter,
// placement "feed", isLeague true. (Club-official Bluesky was retired from the Feed
// 2026-08 — the app's Clubs chip is gone; a club's Home voice is its IG/YT/news.)
interface FeedHandle {
	handle: string;
	kind: "reporter" | "league" | "player";
	// Player-kind extras (2c): her NWSL club (default players; undefined for a user add) and
	// her IG id — the app's player-follow key, so bsky + IG cards toggle as ONE player.
	abbr?: string;
	playerId?: string;
}
// The default reporter list is DATA (owner 2026-08-17, reporter automation): the live list is
// KV `social:reporter-list`, written by the monthly routine through POST
// /social/reporter-audit/apply under server guardrails (MAX_FEED_HANDLES budget ceiling,
// per-call add cap, drop rules). This constant is the SEED — served until the first apply;
// never hand-edited for adds/drops after that.
const REPORTER_LIST_KEY = "social:reporter-list";
const MAX_FEED_HANDLES = 24; // classification-budget ceiling for the default list — a CEILING, never a target
const MAX_REPORTER_ADDS_PER_CALL = 2; // the routine can never go on an add spree in one run

async function loadFeedHandles(env: Env): Promise<FeedHandle[]> {
	try {
		const raw = await env.FEED_TAGS.get(REPORTER_LIST_KEY);
		if (raw) {
			const list = JSON.parse(raw) as FeedHandle[];
			if (Array.isArray(list) && list.length > 0 && list.every((h) => h.handle && (h.kind === "reporter" || h.kind === "league"))) return list;
		}
	} catch {
		/* fall through to seed */
	}
	return FEED_HANDLES;
}

const FEED_HANDLES: FeedHandle[] = [
	// Reporters / journalists (league-wide)
	{ handle: "meglinehan.com", kind: "reporter" },
	{ handle: "jeffkassouf.bsky.social", kind: "reporter" },
	{ handle: "sandraherrera.bsky.social", kind: "reporter" },
	{ handle: "pcattry.bsky.social", kind: "reporter" },
	{ handle: "katiewhyatt.bsky.social", kind: "reporter" },
	// Added 2026-08 audit — each verified active on the keyless AT-Proto API. Haiku still
	// gates every post to NWSL + the reader's followed teams, so all-soccer writers (Rueter,
	// Tannenwald) only surface on their NWSL/USWNT items.
	{ handle: "scoutripley.bsky.social", kind: "reporter" }, // Claire Watkins (Just Women's Sports / The Late Sub)
	{ handle: "jennatonelli.bsky.social", kind: "reporter" }, // Jenna Tonelli (SI / broadcast)
	// caitlinmurr.bsky.social removed 2026-08-17 (routine audit #1): no original posts in 236d
	// (reposts only). The default list serves accounts that post original coverage here; an
	// account can be re-added instantly if it becomes active again.
	{ handle: "jeffrueter.bsky.social", kind: "reporter" }, // Jeff Rueter (The Athletic)
	{ handle: "jtannenwald.bsky.social", kind: "reporter" }, // Jonathan Tannenwald (Philadelphia Inquirer)
	{ handle: "girlssoccernetwork.bsky.social", kind: "reporter" }, // Girls Soccer Network (outlet)
	// League / official outlets
	{ handle: "nwslsoccer.com", kind: "league" },
	{ handle: "equalizersoccer.bsky.social", kind: "league" },
	{ handle: "nwslthisweek.bsky.social", kind: "league" },
	{ handle: "nwslstat.bsky.social", kind: "league" },
	{ handle: "allforxi.bsky.social", kind: "league" },
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

// The featured-player pool is DATA, not code (owner 2026-08-16, full automation): the live
// list lives in KV (`social:player-list`), written by the self-tuning routine through
// POST /social/player-audit/apply. This constant is only the SEED — served verbatim until
// the first apply creates the KV record; never edited to add/drop players after that.
// Europe-based (Fox/Girma/A.Thompson) grandfathered per owner, tagged to last NWSL club.
// bsky was removed from the DEFAULT schema (owner 2026-08-17): the app does not self-discover
// player Bluesky — defaults are IG-only. (User adds carry their own bsky via /feed?playerBsky=.)
type PlayerSocialEntry = { name: string; abbr: string; ig: string; addedAt?: string; source?: string; pool?: "A" | "B" };
const PLAYER_LIST_KEY = "social:player-list";

// ── Pool ROTATION (owner 2026-08-17): the every-2-day scrape alternates pools A/B — same
// monthly Apify volume (cost driver = results/month, not distinct handles), DOUBLE the player
// ceiling. Serving merges both pool snapshots, so every player is in the app all week; each
// player's cards refresh every 4 days. Resilience UP vs the old single snapshot: a missed cron
// costs one pool's freshness, never the whole chip. Pool TTL = 6 days = tolerate exactly ONE
// missed cycle, then that pool goes honestly empty (the owner's one-miss canary design).
// New adds auto-assign to the LIGHTER pool (server-side — the routine needs no pool awareness).
const POOL_MARKER_KEY = "social:pool-last-scraped";
const POOL_SNAPSHOT_TTL = 60 * 60 * 24 * 6;
const poolKey = (p: "A" | "B") => `social-cards-player-pool-${p.toLowerCase()}`;
const lighterPool = (list: PlayerSocialEntry[]): "A" | "B" => {
	const a = list.filter((p) => p.pool === "A").length;
	const b = list.filter((p) => p.pool === "B").length;
	return a <= b ? "A" : "B";
};
const PLAYER_SOCIAL_SEED: PlayerSocialEntry[] = [
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
// Clubs stay STATIC code (16 clubs, changes ~never); players are loaded per-use from KV.
const CLUB_HANDLES: SocialHandle[] = Object.entries(CLUB_SOCIAL).map(
	([abbr, c]): SocialHandle => ({ handle: c.ig, platform: "instagram", kind: "team", abbr, name: c.name }),
);

/** The LIVE featured-player list: KV overlay if the routine has ever written one, else the seed.
 *  Fail-open to the seed on a corrupt record (diag'd by the writer path, never silent-empty). */
async function loadPlayerSocial(env: Env): Promise<PlayerSocialEntry[]> {
	try {
		const raw = await env.FEED_TAGS.get(PLAYER_LIST_KEY);
		if (raw) {
			const list = JSON.parse(raw) as PlayerSocialEntry[];
			if (Array.isArray(list) && list.length > 0 && list.every((p) => p.name && p.abbr && p.ig)) return list;
		}
	} catch {
		/* fall through to seed */
	}
	return PLAYER_SOCIAL_SEED;
}

function playerIgHandles(players: PlayerSocialEntry[]): SocialHandle[] {
	return players.map((p): SocialHandle => ({ handle: p.ig, platform: "instagram", kind: "player", abbr: p.abbr, name: p.name }));
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Liveness probe: answer any HEAD with an empty 200. Uptime monitors (UptimeRobot's free
		// tier only sends HEAD) otherwise hit the GET-only guard below and read 405 as "down" — a
		// false alarm on a healthy Worker. HEAD = "are you there?", so a bare 200 is the correct
		// reply; no route runs, no body.
		if (request.method === "HEAD") return new Response(null, { status: 200 });

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

		// Weekly adjudication routine (dedicated key, same blast-radius logic as KNOWHER_INGEST_KEY:
		// the routine holds ONLY this, so a leak exposes one narrow feature that rotates alone).
		// GET /roster-truth/todo = the open mismatches; POST /roster-truth/rulings = cited pins.
		if (url.pathname === "/roster-truth/todo" || url.pathname === "/roster-truth/rulings") {
			return handleAdjudication(request, env, ctx);
		}

		// The single operator portal: GET /admin (tabbed shell) + POST /admin/roster (its ops).
		// Same HTTP Basic realm as the Bracket/KHG panels, so the browser authenticates once for
		// the whole origin and the iframed tabs inherit it. Registered above the GET-only guard.
		if (url.pathname === "/admin" || url.pathname === "/admin/roster") {
			return handleAdminPortal(request, env, ctx);
		}
		if (url.pathname === "/admin/status") {
			return handleAdminStatus(request, env);
		}
		// Owner-only analytics dashboard: GET the page, POST /api the computed metrics. Admin-key gated
		// inside the handler; registered before the GET-only guard (it serves POST too).
		if (url.pathname === "/analytics/admin" || url.pathname === "/analytics/admin/api") {
			return handleAnalyticsAdmin(request, env as unknown as {
				SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; BRACKET_ADMIN_KEY?: string;
			});
		}
		// Attendance backstop ops: the ledger + sweep state; `?sweep=1` forces a run.
		if (url.pathname === "/admin/attendance") {
			const adminKey = (env as unknown as { BRACKET_ADMIN_KEY?: string }).BRACKET_ADMIN_KEY;
			if (!adminAuthed(request, adminKey)) {
				return new Response("Authentication required.", {
					status: 401, headers: { "WWW-Authenticate": adminRealm("NWSLApp Admin") },
				});
			}
			return handleAdminAttendance(env, (kind, detail) => emitDiag(env, ctx, kind, detail),
				url.searchParams.get("sweep") === "1");
		}

		// Admin/routine-keyed social self-tuning audit surface: GET ?nt= (ledger populate),
		// GET ?section=nwsl (decision report), POST /research + /apply (routine write-back).
		// Prefix match + registered BEFORE the GET-only guard (the two POSTs need it).
		if (url.pathname === "/social/player-audit" || url.pathname.startsWith("/social/player-audit/")) {
			return handlePlayerAudit(request, env, ctx);
		}
		if (url.pathname === "/social/reporter-audit" || url.pathname.startsWith("/social/reporter-audit/")) {
			return handleReporterAudit(request, env, ctx);
		}

		// POST telemetry ingest must be registered BEFORE the GET-only guard below.
		if (url.pathname === "/telemetry") {
			return handleTelemetryIngest(request, env, ctx);
		}

		// POST anonymous usage counters (Level-3 analytics) — same pre-guard placement.
		if (url.pathname === "/analytics") {
			return handleAnalyticsIngest(request, env, ctx);
		}

		// POST Bright Data webhook: the async player-IG scrape's push delivery lands here
		// (~1–3 min after the cron's trigger). Before the GET-only guard; self-authenticates
		// against BD_WEBHOOK_SECRET (see handleBrightDataWebhook).
		if (url.pathname === "/brightdata-webhook") {
			return handleBrightDataWebhook(request, env, ctx);
		}

		// Admin-only: refresh the IG social snapshot on demand (the every-2-day cron does
		// this automatically; this forces an immediate pull after a token swap or an aborted
		// run). Same BRACKET_ADMIN_KEY gate as /headshots/run.
		if (url.pathname === "/refresh-social") {
			const key = (env as unknown as { BRACKET_ADMIN_KEY?: string }).BRACKET_ADMIN_KEY;
			if (request.method !== "POST" || !key || request.headers.get("x-admin-key") !== key) {
				return new Response("forbidden", { status: 403 });
			}
			try {
				const summary = await refreshSocialCache(env, ctx);
				return new Response(`${JSON.stringify(summary)}\n`, {
					headers: { "Content-Type": "application/json" },
				});
			} catch (e) {
				const err = e as Error;
				return new Response(`refresh-social error: ${err.message}\n`, { status: 500 });
			}
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

		// Automated weekly Know Her Game publish (docs §5): the scheduled Claude routine POSTs the
		// generated pool here. Gated by the DEDICATED KNOWHER_INGEST_KEY (x-ingest-key) — never the
		// master admin key — and reuses the ONE publish path (validate → KV → markFeatured), so the
		// once-per-season pick rotation always advances. Before the GET-only guard (it's POST +
		// self-checks its key). Every outcome emits a diag — an automated pipeline's failures must
		// be loud, never a silent non-publish.
		if (url.pathname === "/knowher/ingest") {
			return handleKnowHerIngest(request, env, ctx);
		}
		if (url.pathname === "/knowher/candidate") {
			return handleKnowHerCandidate(request, env, ctx);
		}
		// The weekend/Monday split (2026-08-12): the VERIFIER stages its cleaned human-only pool here;
		// the MONDAY watcher pass reads it, injects fresh stats + Lever 1, and publishes.
		if (url.pathname === "/knowher/candidate/verified") {
			return handleKnowHerVerifiedCandidate(request, env, ctx);
		}
		if (url.pathname === "/knowher/publish-verified") {
			return handleKnowHerPublishVerified(request, env, ctx);
		}
		// NWSL Trivia content pipeline (roadmap #2): the GENERATOR stages category batches, the VERIFIER
		// reads them back + publishes the yearly grouped pool. Both serve non-GET methods (POST stage/ingest,
		// GET candidate-read), so they MUST precede the GET-only guard.
		if (url.pathname === "/trivia/ingest") {
			return handleTriviaIngest(request, env, ctx);
		}
		if (url.pathname === "/trivia/candidate") {
			return handleTriviaCandidate(request, env, ctx);
		}

		// Operator escape hatch: a KV JSON the app layers over its ESPN-derived playoff bracket,
		// so an ESPN data/format break during the postseason is a server edit, not an App Store
		// release. Dormant unless set. GET public; POST gated by x-admin-key. MUST be before the
		// GET-only guard (it serves both methods + self-checks the key) — else POST 405s and the
		// override can never be SET.
		if (url.pathname === "/playoff-override") {
			return handlePlayoffOverride(request, url, env as unknown as { FEED_TAGS: KVNamespace; BRACKET_ADMIN_KEY?: string });
		}
		// The device-IP club-news fallback POSTs residentially-fetched bytes here (Phase 2b) — a
		// POST route, so it MUST precede the GET-only guard.
		if (url.pathname === "/club-news/normalize") {
			return handleClubNewsNormalize(request, url);
		}
		if (url.pathname === "/club-news/device-report") {
			return handleClubNewsDeviceReport(request, env, ctx);
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
			// bustUpstream: ESPN serves the full-season scoreboard STALE for tens of minutes during
			// live games; force a recompute on every MISS so the app's 30s poll gets fresh data.
			return proxyAndCache(url, scoreboardUpstream(league), chooseScoreboardTTL, ctx, env, true);
		}
		if (url.pathname === "/summary") {
			// Missing `?event=` isn't validated here — forwarded verbatim, letting
			// ESPN return its own error, exactly as scoreboard doesn't police
			// `dates`/`limit`. `league` IS validated (allowlist — never forward an
			// arbitrary slug into an ESPN URL), defaulting to NWSL for old callers.
			const league = url.searchParams.get("league") ?? "usa.nwsl";
			if (!SCOREBOARD_LEAGUES.has(league)) {
				return new Response(`Unknown league "${league}".`, { status: 400 });
			}
			// bustUpstream: the pending-summary re-check (attendance still 0 after FT) only works if
			// ESPN recomputes — its own CDN serves /summary stale just like /scoreboard, and an
			// unbusted re-check can re-pin the FT-time zero for another 6h window indefinitely.
			// enrich: the attendance-backstop ledger fills a settled match's missing crowd figure
			// (attendance.ts — the one allowed pass-through mutation).
			return proxyAndCache(url, summaryUpstream(league), chooseSummaryTTL, ctx, env, true,
				(body) => enrichSummaryAttendance(env, url.searchParams.get("event"), body));
		}
		if (url.pathname === "/team-videos") {
			return handleTeamVideos(url, env, ctx);
		}
		if (url.pathname === "/feed") {
			return handleFeed(url, env, ctx);
		}
		if (url.pathname === "/feed/players") {
			return handlePlayerDirectory(env);
		}
		if (url.pathname === "/feed/validate-reporter") {
			return handleValidateReporter(url, env, ctx);
		}
		if (url.pathname === "/club-news/sources") {
			return handleClubNewsSources();
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
		if (url.pathname === "/knowher/todo") {
			return handleKnowHerTodo(url, env, ctx);
		}
		if (url.pathname === "/quiz-results") {
			return handleQuizResults(url, env as unknown as { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string }, ctx);
		}
		if (url.pathname === "/predict/community") {
			// Predict the XI community pick distribution. This route is the DEADLINE GATE — it
			// refuses to serve per-player percentages before kickoff − 2h, because readable
			// percentages during picking would flatten the very distribution the feature needs.
			// Kickoff comes from this worker's OWN edge-cached /summary (same closure as /weather;
			// only the immutable header date is read, so no `w=near` and no extra ESPN load).
			const getSummary = async (eventId: string) => {
				const summaryUrl = new URL(`/summary?event=${eventId}`, url);
				// bustUpstream + enrich match the /summary route: this shares its edge cache key, so
				// a MISS here must populate the shared cache exactly as the route would (fresh ESPN
				// bytes, attendance filled from the backstop ledger).
				const resp = await proxyAndCache(summaryUrl, ESPN_SUMMARY, chooseSummaryTTL, ctx, env, true,
					(body) => enrichSummaryAttendance(env, eventId, body));
				return resp.ok ? ((await resp.json()) as never) : null;
			};
			return handlePredictCommunity(
				url,
				env as unknown as { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string },
				ctx,
				getSummary,
				emitDiag as never,
			);
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
		if (url.pathname === "/team-stats") {
			return handleTeamStats(url, env, ctx);
		}
		if (url.pathname === "/weather") {
			// Historical kickoff weather for a past match (see weather.ts). The event →
			// (venue, kickoff, state) lookup reuses this worker's OWN edge-cached /summary
			// pass-through — the byte-identical URL the app itself requests, so it's almost
			// always a warm HIT. emitDiag is injected to keep weather.ts self-contained.
			const getSummary = async (eventId: string) => {
				const summaryUrl = new URL(`/summary?event=${eventId}`, url);
				// bustUpstream + enrich match the /summary route (shared edge cache key — see /predict/community).
				const resp = await proxyAndCache(summaryUrl, ESPN_SUMMARY, chooseSummaryTTL, ctx, env, true,
					(body) => enrichSummaryAttendance(env, eventId, body));
				return resp.ok ? ((await resp.json()) as never) : null;
			};
			return handleWeather(url, env, ctx, getSummary, emitDiag);
		}
		if (url.pathname === "/telemetry/recent") {
			return handleTelemetryRecent(request, env);
		}

		return new Response(
			"Not found. This proxy serves GET /scoreboard, /summary, /weather, /team-videos, /feed, /spotlight, /trivia, /knowher, /knowher/eligible, /knowher/todo, /quiz-results, /predict/community, /headshots, /crest, /crest/manifest, /roster, /team-stats, /national-teams, /playoff-override, and POST /telemetry, /analytics.",
			{ status: 404 },
		);
	},

	// B3b — once-daily cron: scrape IG via Apify and refresh the social-card
	// snapshot in KV. Decoupled from user requests so a slow ~50-account scrape never
	// blocks the app and Apify spend is pinned to ~1 run/day (see wrangler.jsonc crons).
	// Await (not waitUntil) — a cron should keep its invocation alive until the work is
	// done; best-effort, a failed refresh leaves the last good snapshot in place.
	async scheduled(controller, env, ctx): Promise<void> {
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
			// Error-spike alerting rides the same 5-min tick (owner decision 2026-07-16: every
			// existing channel is PULL — dashboards nobody watches mid-incident; the 7/15 CPU-error
			// burst was found a day late. This is the PUSH channel.) Isolated: an alerting bug can
			// never affect the bracket engine.
			try {
				await checkErrorSpike(env, ctx);
			} catch {
				/* swallow — best-effort; next tick retries */
			}
			// Attendance backstop: internally gated to ~every 6h (attendance-sweep:last), so this
			// is a no-op on almost every tick. Isolated like the pager — a sweep bug can never
			// affect the bracket engine or alerting.
			try {
				await attendanceSweep(env, (kind, detail) => emitDiag(env, ctx, kind, detail));
			} catch {
				/* swallow — best-effort; the next gated tick retries */
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
		// Nightly → OBSERVE-MODE roster verification (ESPN × NWSL). Writes a report + diags and
		// changes nothing users see. Nightly rather than weekly because the cost is identical
		// (~36 fetches either way) and ESPN breakage should surface in hours, not up to six days.
		// ⚠️ This explicit branch is REQUIRED: the fall-through below runs the Apify social scrape,
		// so a new cron string without a branch would silently trigger paid scraping every night.
		if (controller.cron === "0 8 * * *") {
			try {
				await runRosterTruth(env, (events) => emitDiagBatch(env, ctx, events));
			} catch (e) {
				emitDiag(env, ctx, "rosterTruthRunFail", (e as Error).message.slice(0, 80));
			}
			return;
		}
		try {
			await refreshSocialCache(env, ctx);
		} catch {
			/* swallow — next run retries; the stale snapshot stays serving */
		}
	},
} satisfies ExportedHandler<Env>;

/**
 * The shared caching pass-through. Checks the edge cache, and on a MISS forwards
 * the incoming query string verbatim to `upstreamBase`, caches the bytes with a
 * TTL from `chooseTTL`, and returns them unchanged.
 *
 * On an upstream failure it walks a RECOVERY LADDER (2026-08-10 — ESPN 502s its live-window
 * recomputes intermittently; a failed watcher tick delayed V2-LA goal pushes, owner-observed):
 *   1. bust-enabled routes retry once WITHOUT `_cb` — ESPN's own cached copy is near-fresh for
 *      windowed queries and beats any snapshot we could hold (diag: `espnRetryRecovered`, quiet);
 *   2. a stale edge copy under the SAME key (useless for the watcher — its `_cb` URLs are
 *      unique keys that never have one) (diag: `staleServe`, PAGES on a sustained burst);
 *   3. the last-known-good SNAPSHOT: written on every successful bust-route fetch under a
 *      normalized key (`_cb`/`w` stripped), so the watcher's busted polls and the app's clean
 *      polls share it (diag: `staleServe`, pages; served with a 30s client TTL so devices
 *      re-ask as soon as ESPN recovers);
 *   4. else 502 (diag: `apiFailure`, pages) — before this ladder, upstream failures emitted NO
 *      diagnostics at all: the pager was blind to an ESPN outage on the app's hottest routes.
 */
async function proxyAndCache(
	url: URL,
	upstreamBase: string,
	chooseTTL: (body: ArrayBuffer) => number,
	ctx: ExecutionContext,
	env: Env,
	// When true, append a per-fetch `_cb` cache-buster to the UPSTREAM (ESPN) URL only — the edge
	// cache key stays the clean incoming URL, so app traffic still collapses to ≤2 ESPN hits/min. Used
	// by /scoreboard: ESPN's own cache serves the full-season `dates=` query STALE for 25–47 min during
	// live games (device-proven 2026-07-11 — a game stuck at `pre`/`HT`/`70'` while reality was 90'+),
	// and only a query it hasn't cached forces a recompute. `_cb` is the same mechanism the watcher's
	// VAR re-poll uses; every un-stuck moment that night came from exactly this poke. Also used by
	// /summary (2026-08-09): the pending-attendance re-check is pointless if ESPN's CDN answers it
	// with the same stale FT-time snapshot — the zero just gets re-pinned every 6h window.
	bustUpstream = false,
	// The ONE allowed body mutation on this pass-through (owner-approved 2026-08-11): the
	// /summary route fills a settled match's missing attendance from the backstop ledger
	// (enrichSummaryAttendance). Runs BEFORE chooseTTL, so a filled figure settles immutable
	// and both the edge entry and the snapshot store the patched bytes. Anything else must
	// leave this unset — the bytes-unchanged contract stands for every other route and field.
	enrich?: (body: ArrayBuffer) => Promise<ArrayBuffer>,
): Promise<Response> {
	// Cache key = the incoming URL (query string included), so different
	// `dates`/`limit` or `event` values are cached independently — plus CACHE_EPOCH, which is
	// how we invalidate globally (see its comment; the Cache API can't be purged per-colo).
	// ESPN never sees this: the upstream URL is rebuilt from `url.search` below.
	const cache = caches.default;
	const keyURL = new URL(url.toString());
	keyURL.searchParams.set("_e", CACHE_EPOCH);
	const cacheKey = new Request(keyURL.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) {
		return withCacheStatus(withClientTTL(hit), "HIT");
	}

	// MISS — forward to ESPN, preserving the incoming query string verbatim.
	const upstream = new URL(upstreamBase);
	upstream.search = url.search;
	// `league` (scoreboard only) is encoded in `upstreamBase`'s path, not an ESPN
	// query param — strip it from the forwarded search. No-op for routes without it.
	upstream.searchParams.delete("league");
	// `w` is a CACHE-KEY-ONLY window bucket (the app sends `w=near` on /summary inside the 2h
	// pre-kickoff window). It forks the edge-cache key so entering the lineup window is a
	// guaranteed MISS → fresh fetch under the short near TTL — an empty pre-lineup shell cached
	// HOURS earlier (with a TTL running to ~kickoff) can no longer mask a freshly posted XI.
	// ESPN must never see it; the caller computes it because only the caller knows kickoff
	// at request time (the proxy would need the body it hasn't fetched yet).
	upstream.searchParams.delete("w");

	// `bust` appends `_cb` per-fetch so ESPN must recompute rather than serve its own stale cache
	// (see bustUpstream). Cache-key unaffected — added AFTER `cacheKey` was built from the clean URL.
	const fetchUpstream = (bust: boolean): Promise<Response> => {
		const u = new URL(upstream.toString());
		if (bust) u.searchParams.set("_cb", String(Date.now()));
		return fetch(u.toString(), {
			headers: { "User-Agent": ESPN_UA, Accept: "application/json" },
		});
	};

	let espnResponse: Response | null = null;
	try {
		espnResponse = await fetchUpstream(bustUpstream);
	} catch {
		espnResponse = null;
	}

	// Recovery ladder step 1 — the `_cb` recompute is what ESPN chokes on under live load, so an
	// un-busted retry usually succeeds from ESPN's own cache: near-fresh for windowed queries,
	// strictly better than any snapshot, and it un-blinds a watcher tick that would otherwise skip.
	if (!espnResponse?.ok && bustUpstream) {
		const firstFail = espnResponse ? String(espnResponse.status) : "threw";
		try {
			const retry = await fetchUpstream(false);
			if (retry.ok) {
				emitDiag(env, ctx, "espnRetryRecovered", `${url.pathname} upstream ${firstFail}`);
				espnResponse = retry;
			}
		} catch {
			// fall through to steps 2-4
		}
	}

	if (!espnResponse?.ok) {
		const failDetail = `${url.pathname} upstream ${espnResponse ? espnResponse.status : "threw"}`;
		// Step 2 — stale copy under the same key (expired-but-not-evicted edge entry).
		const stale = await serveStale(cache, cacheKey);
		if (stale) {
			emitDiag(env, ctx, "staleServe", `${failDetail} — served stale`);
			return withClientTTL(stale);
		}
		// Step 3 — the last-known-good snapshot (normalized key, see snapshotKeyURL). Short client
		// TTL: a device must not pin outage-era data for the usual hour once ESPN recovers.
		const snap = await cache.match(new Request(snapshotKeyURL(url), { method: "GET" }));
		if (snap) {
			emitDiag(env, ctx, "staleServe", `${failDetail} — served snapshot`);
			const out = new Response(snap.body, snap);
			out.headers.set("Cache-Control", "public, max-age=30");
			return withCacheStatus(out, "STALE");
		}
		// Step 4 — nothing to serve. This is the only outcome the caller sees as an error.
		emitDiag(env, ctx, "apiFailure", `${failDetail} (no fallback)`);
		return upstreamError(espnResponse?.status);
	}

	// Read the body once as bytes so we can both cache it and return it
	// unchanged (modulo the narrowly-scoped `enrich` hook above). Peek at the JSON only to
	// pick a TTL.
	let body = await espnResponse.arrayBuffer();
	if (enrich) body = await enrich(body);
	const ttl = chooseTTL(body);

	const headers = new Headers();
	headers.set(
		"Content-Type",
		espnResponse.headers.get("Content-Type") ?? "application/json",
	);
	headers.set("Cache-Control", `public, max-age=${ttl}`);

	// Store a copy in the edge cache (don't block the response on the write). The EDGE entry keeps
	// the full `ttl`; only the client-facing copy is capped.
	const toCache = new Response(body, { status: 200, headers });
	ctx.waitUntil(cache.put(cacheKey, toCache.clone()));

	// Bust-enabled (ESPN-fragile) routes also refresh the last-known-good snapshot — the Cache API
	// costs nothing per write (unlike KV's 1k/day free-tier budget) and is per-colo, which is fine:
	// the watcher's every-minute polls keep ITS colo's snapshot warm, and that colo is exactly where
	// its future failures will look.
	if (bustUpstream) {
		const snapHeaders = new Headers(headers);
		snapHeaders.set("Cache-Control", `public, max-age=${SNAPSHOT_TTL}`);
		ctx.waitUntil(
			cache.put(
				new Request(snapshotKeyURL(url), { method: "GET" }),
				new Response(body, { status: 200, headers: snapHeaders }),
			),
		);
	}

	return withCacheStatus(withClientTTL(toCache), "MISS");
}

/**
 * The last-known-good snapshot's cache key: the incoming URL with the per-fetch noise stripped —
 * `_cb` (the watcher's cache-buster makes every busted URL unique, so busted polls could never
 * share a cached entry) and `w` (the pre-kickoff window bucket) — plus the epoch and a `_snap`
 * marker so it can never collide with the live entry. One snapshot per (route, league, dates,
 * limit), shared by the watcher's busted polls and the app's clean ones.
 */
export function snapshotKeyURL(url: URL): string {
	const k = new URL(url.toString());
	k.searchParams.delete("_cb");
	k.searchParams.delete("w");
	k.searchParams.set("_e", CACHE_EPOCH);
	k.searchParams.set("_snap", "1");
	return k.toString();
}

/**
 * Cap what the CLIENT is told to cache, WITHOUT shortening the edge entry's own TTL.
 *
 * ⚠️ Why this exists: a device that caches a response for a year is beyond our reach — no
 * server-side fix can correct it, because the device never asks again. That's not theoretical;
 * `URLSession.shared` honours `max-age`, and we were handing out `max-age=31536000` on match
 * summaries, so the frozen WAS @ UTA copy would have outlived the server fix on any phone that
 * had opened it. Revalidating hourly costs a Worker request but almost never an ESPN fetch (the
 * edge entry is still valid and answers the revalidation), so correctness here is nearly free.
 */
function withClientTTL(response: Response, cap = CLIENT_MAX_TTL): Response {
	const current = Number(/max-age=(\d+)/.exec(response.headers.get("Cache-Control") ?? "")?.[1]);
	if (!Number.isFinite(current) || current <= cap) return response;
	const out = new Response(response.body, response);
	out.headers.set("Cache-Control", `public, max-age=${cap}`);
	return out;
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
				date?: string;
				status?: { type?: { state?: string } };
				competitions?: Array<{ status?: { type?: { state?: string } } }>;
			}>;
		};
		const events = json.events ?? [];
		const isLive = events.some(
			(event) =>
				event.status?.type?.state === "in" ||
				(event.competitions ?? []).some((c) => c.status?.type?.state === "in"),
		);
		if (isLive) return LIVE_TTL;
		// KICKOFF WINDOW (2026-07-05, BOS vs BAY lesson): the flat 300s pre-match TTL let a stale
		// "everything is pre" snapshot straddle kickoff — the watcher, the V2 Live Activity flip,
		// AND the app's schedule tab (all reading this one cache) lagged the live transition by up
		// to 5 EXTRA minutes on top of ESPN's own late flip (ESPN went "in" ~10 min after the real
		// whistle, clock reset to ~1'). While any match sits "pre" with a kickoff between 2 min out
		// and 45 min AGO (ESPN's observed flip lag), cache at the live cadence so we track ESPN's
		// transition within ~30s instead of ~5 min. ESPN's own lateness is not ours to fix.
		const now = Date.now();
		const nearKickoff = events.some((event) => {
			const state = event.status?.type?.state ?? (event.competitions ?? [])[0]?.status?.type?.state;
			if (state !== "pre" || !event.date) return false;
			// Normalize ESPN's seconds-less timestamps ("…T17:00Z") before parsing, mirroring the
			// watcher's fixtures.kickoffMs. (V8's Date.parse actually accepts "17:00Z" today, so this is
			// parity + future-proofing on a live-transition-critical path — a silent parse miss here would
			// cache at the 5-min default across kickoff and lag the live flip — not a current-format fix.)
			const rawDate = /T\d{2}:\d{2}Z$/.test(event.date) ? event.date.replace("Z", ":00Z") : event.date;
			const kickoff = Date.parse(rawDate);
			if (!Number.isFinite(kickoff)) return false;
			return now >= kickoff - 2 * 60 * 1000 && now <= kickoff + 45 * 60 * 1000;
		});
		return nearKickoff ? LIVE_TTL : SCOREBOARD_DEFAULT_TTL;
	} catch {
		return SCOREBOARD_DEFAULT_TTL;
	}
}

/** `post` statuses that mean "play stopped but the RESULT IS NOT SETTLED". Mirrors the watcher's
 *  set in `nwslapp-match-watcher/src/events.ts` — keep the two in sync. */
const NON_FINAL_POST_STATUSES = new Set([
	"STATUS_SUSPENDED",
	"STATUS_POSTPONED",
	"STATUS_DELAYED",
	"STATUS_CANCELED",
	"STATUS_CANCELLED",
	"STATUS_ABANDONED",
]);
/** Of those, the ones play can RESUME from within the hour — worth polling at live cadence. */
const RESUMABLE_POST_STATUSES = new Set([
	"STATUS_SUSPENDED",
	"STATUS_DELAYED",
]);

/**
 * Summary TTL: one match, so the state lives at a single path —
 * `header.competitions[0].status.type.state` (NOT the scoreboard's
 * `events[].status…`). Live → 30s; future → once-daily BUT capped at kickoff (see
 * `preKickoffTTL`) so a pre-kickoff shell can't be served stale through the whole live game.
 * Parse failure → safe 1hr default.
 *
 * ⚠️ `post` DOES NOT MEAN FINISHED, and caching it as if it does is uniquely destructive here:
 * unlike the scoreboard (which self-corrects on the next poll) a year-long TTL FREEZES the match
 * permanently. Live-proven 2026-07-31 on WAS @ UTA: suspended for weather at 23', cached at that
 * instant for a year, and 1.9 days later the app was still showing a 23-minute play-by-play and
 * attendance 0 while ESPN had the full 90'+7' and 9,538. The scoreboard healed on resume; the
 * summary could not, because nothing ever asked ESPN again. So "settled" is checked exactly the
 * way the app (`Event.isFinalResult`) and the watcher (`isUnfinishedPost`) check it, FAIL-OPEN:
 * only positive evidence of non-completion downgrades the TTL.
 *
 * ⚠️ And settled is NOT the same as COMPLETE. Attendance arrives late at some venues — hours,
 * occasionally days (verified 2026-07-31: GFC @ BAY was a normal final with attendance still 0
 * two days on). An immutable cache means a number that lands on Tuesday is never seen. So a
 * settled-but-incomplete record re-checks every 6h, and only becomes immutable once the field is
 * actually there — the same "write-once, but only when it's real" rule the kickoff-weather cache
 * uses. Past SUMMARY_PENDING_MAX_AGE_MS the re-check slows to weekly (SUMMARY_PENDING_COLD_TTL)
 * — most NT matches never report attendance at all, and 6h forever would be wasteful — but an
 * incomplete record is NEVER promoted to immutable: pinning a zero for a year is exactly the
 * frozen-attendance regression (2026-08-09), and a weekly demand-driven re-check is nearly free.
 */
export function chooseSummaryTTL(body: ArrayBuffer, now: number = Date.now()): number {
	try {
		const json = JSON.parse(new TextDecoder().decode(body)) as {
			header?: {
				competitions?: Array<{
					date?: string;
					status?: { type?: { state?: string; name?: string; completed?: boolean } };
				}>;
			};
			gameInfo?: { attendance?: number };
		};
		const competition = json.header?.competitions?.[0];
		const type = competition?.status?.type;
		switch (type?.state) {
			case "post": {
				const namedNonFinal = !!type.name && NON_FINAL_POST_STATUSES.has(type.name);
				if (type.completed === false || namedNonFinal) {
					// Not settled. Step DOWN to the hourly tier only when the name explicitly says
					// this won't restart (postponed/canceled/abandoned) — those would otherwise hold a
					// permanent 30s hot path, and they still can't be immutable because the page can
					// gain a rescheduled date. Anything else unsettled — including `completed: false`
					// under a name we don't recognise or one that looks final — stays at live cadence:
					// we don't know why it stopped, and being wrong in that direction costs one fetch
					// per 30s, while being wrong the other way freezes the match (WAS @ UTA).
					const resumable = !namedNonFinal || RESUMABLE_POST_STATUSES.has(type.name!);
					return resumable ? LIVE_TTL : SUMMARY_DEFAULT_TTL;
				}
				// Settled. Immutable only once the record is complete — or old enough that whatever
				// is missing is never coming.
				if ((json.gameInfo?.attendance ?? 0) > 0) return IMMUTABLE_TTL;
				const kickoff = competition?.date ? Date.parse(competition.date) : NaN;
				const giveUp =
					Number.isFinite(kickoff) && now - kickoff > SUMMARY_PENDING_MAX_AGE_MS;
				return giveUp ? SUMMARY_PENDING_COLD_TTL : SUMMARY_PENDING_TTL;
			}
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
		else if (src.kind === "api") cards = await clubApiCards(abbr, src.url);
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

/** GET /club-news/sources — each club's official news source (abbr, kind, url). Backs the app's
 *  DYNAMIC device-IP fallback (Phase 2b): when the proxy returns no official news for a followed
 *  club (a datacenter-IP block like CHI), the app looks up the club's URL here, fetches it from
 *  the device's residential IP, and POSTs the bytes to /club-news/normalize. Only clubs with a
 *  url (rss/index/api). */
function handleClubNewsSources(): Response {
	const sources = Object.entries(CLUB_NEWS)
		.filter(([, s]) => "url" in s)
		.map(([abbr, s]) => ({ abbr, kind: s.kind, url: (s as { url: string }).url, deviceFallback: DEVICE_FALLBACK_CLUBS.has(abbr) }));
	const headers = new Headers({ "Content-Type": "application/json" });
	headers.set("Cache-Control", "public, max-age=3600");
	return new Response(JSON.stringify(sources), { status: 200, headers });
}

/** POST /club-news/normalize?abbr=CHI — the device-IP fallback's brains. The app fetched the
 *  club's RSS from a residential IP (bypassing the datacenter block) and POSTs the raw bytes; we
 *  parse them into cards with the SAME logic the proxy uses. RSS-only today (the clean case that
 *  covers CHI + any future RSS-blocked club); an index-blocked club (POR) needs per-article OG
 *  which its own site also blocks, so it isn't supported here — it stays on press fallback. The
 *  user's own device is the only caller and the cards land only in that user's feed. */
async function handleClubNewsNormalize(request: Request, url: URL): Promise<Response> {
	const abbr = (url.searchParams.get("abbr") ?? "").toUpperCase();
	const src = CLUB_NEWS[abbr];
	if (!src || (src.kind !== "rss" && src.kind !== "index")) return jsonResponse([], 200);
	const body = await request.text();
	if (!body || body.length > 900_000) return jsonResponse([], 200); // size-cap a hostile/huge POST
	// No OG-enrich: the club's OWN pages are the very thing the Worker is blocked from, so an
	// OG-scrape would just waste fetches on shells. Cards carry whatever's inline (RSS image / none).
	const cards = src.kind === "rss"
		? rssTextToClubCards(abbr, body)
		: indexHtmlToClubCards(abbr, body, src.url, src.articlePath);
	return jsonResponse(cards, 200);
}

/** POST /club-news/device-report — the app reports the RESULT of a device-IP club-news fetch so the
 *  admin Status tab can verify the device-fallback clubs (CHI/POR). Without this a URL move on a
 *  blocked club looks identical to the normal block (a masked 🔵); with it the beacon goes stale/🔴.
 *  Body `{abbr, ok, count, error?}`. Open + best-effort (like /telemetry): informational, owner-only
 *  display, one KV row per club (latest wins), 7-day TTL so a silent stop shows as stale. */
async function handleClubNewsDeviceReport(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	let body: { abbr?: string; ok?: boolean; count?: number; error?: string };
	try { body = await request.json(); } catch { return jsonResponse({ ok: false }, 400); }
	const abbr = String(body.abbr ?? "").toUpperCase();
	if (!DEVICE_FALLBACK_CLUBS.has(abbr)) return jsonResponse({ ok: false }, 400); // only the known device clubs
	const record: ClubDeviceHealth = {
		ok: body.ok === true,
		count: Math.max(0, Math.min(500, Math.floor(Number(body.count) || 0))),
		at: Date.now(),
		error: typeof body.error === "string" ? body.error.slice(0, 200) : undefined,
	};
	ctx.waitUntil(env.FEED_TAGS.put(clubDeviceHealthKey(abbr), JSON.stringify(record), { expirationTtl: 7 * 24 * 3600 }));
	return jsonResponse({ ok: true }, 200);
}

/** Parse an already-fetched club NEWS INDEX (HTML) into cards — for the device-IP fallback on an
 *  index-kind club that shells the Worker but SSRs the full page to a residential IP (POR/Webflow,
 *  2026-08). Everything is in the index card: the article link + a TITLE-text anchor
 *  (`<a href="/news/…">Title</a>`, ≥10 chars — the cover link holds an <img>, no text) + a hidden
 *  FinSweet `fs-cmssort-field="date"` ISO (via extractIndexDates). No per-article fetch (the club's
 *  article pages are Worker-blocked too). `sourceUrl` gives the origin for absolute links. */
function indexHtmlToClubCards(abbr: string, html: string, sourceUrl: string, articlePath: string): NewsCard[] {
	let origin = "";
	try { origin = new URL(sourceUrl).origin; } catch { return []; }
	const name = CLUB_SOCIAL[abbr]?.name ?? abbr;
	const dates = extractIndexDates(html, articlePath);
	const esc = articlePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`<a\\b[^>]*href="(${esc}[^"?#]+)"[^>]*>\\s*([^<]{10,})\\s*</a>`, "gi");
	const cards: NewsCard[] = [];
	const seen = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		const path = m[1].replace(/\/$/, "");
		if (seen.has(path)) continue;
		seen.add(path);
		const title = decodeBasicEntities(m[2]).replace(/\s+/g, " ").trim();
		const timestamp = dates.get(path);
		if (!title || !timestamp || isPlaceholderArticle(title)) continue;
		cards.push(clubNewsCard(abbr, origin + path, title, undefined, name, undefined, timestamp, "club"));
		if (cards.length >= CLUBNEWS_PER_CLUB) break;
	}
	return cards;
}

/** Decode the handful of HTML entities a scraped title actually carries. */
function decodeBasicEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&#8217;/g, "’")
		.replace(/&quot;/g, '"').replace(/&#8211;/g, "–").replace(/&#8212;/g, "—")
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Strategy: the club's own RSS/Atom feed → cards (structured, dated; no scraping). */
async function clubRssCards(abbr: string, url: string): Promise<NewsCard[]> {
	const r = await fetch(url, {
		headers: { "User-Agent": BROWSER_UA, Accept: "application/rss+xml, application/xml, text/xml" },
	});
	if (!r.ok) return [];
	return rssTextToClubCards(abbr, await r.text());
}

/** Parse an already-fetched RSS/Atom body into club cards. Split out from clubRssCards so the
 *  device-fallback (POST /club-news/normalize) can reuse it on bytes the APP fetched from a
 *  residential IP when the Worker's datacenter IP is blocked (e.g. CHI). */
function rssTextToClubCards(abbr: string, xml: string): NewsCard[] {
	const name = CLUB_SOCIAL[abbr]?.name ?? abbr;
	const cards: NewsCard[] = [];
	for (const it of parseOutletRSS(xml)) {
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
	const html = await r.text();
	const links = extractArticleLinks(html, indexUrl, articlePath);
	// Fallback dates for platforms whose article pages carry no machine date but whose index
	// cards do (Gotham/Sanity, Portland/Webflow) — empty for clubs that date off the article.
	const indexDates = extractIndexDates(html, articlePath);
	const name = CLUB_SOCIAL[abbr]?.name ?? abbr;
	const built = await Promise.all(
		links.map(async (link) => {
			try {
				const og = await fetchOG(link);
				const timestamp = isoNoFraction(og.published) ?? indexDates.get(new URL(link).pathname.replace(/\/$/, ""));
				if (!og.title || !timestamp || isPlaceholderArticle(og.title)) return null;
				return clubNewsCard(abbr, link, og.title, og.description, name, og.image, timestamp, "club");
			} catch {
				return null;
			}
		}),
	);
	return built.filter((c): c is NewsCard => c !== null).slice(0, CLUBNEWS_PER_CLUB);
}

/** Strategy: a club's JSON news API. NC Courage is a Next.js/RSC site whose HTML carries no
 *  article list, but its SDP `dapi` endpoint (`/api/dapi/selection/latest-news`) returns clean
 *  JSON that IS reachable from the Worker (unlike the bot-shell HTML), with everything inline:
 *  `title`, `url`, `contentDate`, `summary`, and a `thumbnail.templateUrl` (a Cloudinary URL with
 *  a `{formatInstructions}` size slot). Map items → cards directly; no per-article OG scrape. */
async function clubApiCards(abbr: string, url: string): Promise<NewsCard[]> {
	const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } });
	if (!r.ok) return [];
	const data = (await r.json()) as { items?: Array<Record<string, unknown>> };
	const name = CLUB_SOCIAL[abbr]?.name ?? abbr;
	const cards: NewsCard[] = [];
	for (const it of data.items ?? []) {
		if (typeof it.type === "string" && it.type !== "story") continue; // articles only, not photo/video widgets
		const title = typeof it.title === "string" ? it.title : undefined;
		const link = typeof it.url === "string" ? it.url : undefined;
		const timestamp = isoNoFraction(typeof it.contentDate === "string" ? it.contentDate : undefined);
		if (!title || !link || !timestamp || isPlaceholderArticle(title)) continue;
		const summary = typeof it.summary === "string" ? it.summary : undefined;
		const thumb = it.thumbnail as { templateUrl?: string; thumbnailUrl?: string } | undefined;
		const image = thumb?.templateUrl?.replace("{formatInstructions}", "t_w_768") ?? thumb?.thumbnailUrl;
		cards.push(clubNewsCard(abbr, link, title, summary, name, image, timestamp, "club"));
		if (cards.length >= CLUBNEWS_PER_CLUB) break;
	}
	return cards;
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
				const r = await fetchBounded(feed.url, {
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

const MONTH_NUM: Record<string, number> = (() => {
	const full = "january february march april may june july august september october november december".split(" ");
	const m: Record<string, number> = {};
	full.forEach((name, i) => {
		m[name] = i + 1;
		m[name.slice(0, 3)] = i + 1; // 3-letter abbreviations (Jul, Aug, Sept→sep)
	});
	m["sept"] = 9;
	return m;
})();

/** The first publish date found in a chunk of index HTML, as a strict `…Z` datetime at
 *  noon UTC (date-only sources have no time; noon keeps same-day ordering sane). Tries a
 *  machine field first (Webflow/FinSweet hidden `fs-cmssort-field="date">2026-07-31`), then
 *  a visible "August 2, 2026" / "Jul 31, 2026". Returns undefined if neither is present. */
function firstIndexDate(block: string): string | undefined {
	const iso = block.match(/fs-cmssort-field="date"[^>]*>\s*(20\d\d-\d\d-\d\d)/);
	if (iso) return `${iso[1]}T12:00:00Z`;
	const vis = block.match(/\b([A-Z][a-z]{2,8}) (\d{1,2}), (20\d\d)\b/);
	if (vis) {
		const mo = MONTH_NUM[vis[1].toLowerCase()];
		if (mo) return `${vis[3]}-${String(mo).padStart(2, "0")}-${String(Number(vis[2])).padStart(2, "0")}T12:00:00Z`;
	}
	return undefined;
}

/** Map each index article link → its publish date, for platforms whose ARTICLE pages carry
 *  no machine-readable date but whose INDEX cards do (Gotham's Sanity site shows a visible
 *  date per card; Portland's Webflow/FinSweet grid carries a hidden ISO sort field). Keys are
 *  the article PATHNAME (trailing slash stripped) to match `clubIndexCards`. Used ONLY as a
 *  fallback when `fetchOG` finds no date, so it can't disturb clubs that date fine off their
 *  article pages (their index carries neither pattern → empty map → no-op). Exported for tests. */
export function extractIndexDates(html: string, articlePath: string): Map<string, string> {
	const links: { pos: number; path: string }[] = [];
	const seen = new Set<string>();
	const esc = articlePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`href="(${esc}[^"?#]+)"`, "gi");
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		const path = m[1].replace(/\/$/, "");
		if (seen.has(path)) continue;
		seen.add(path);
		links.push({ pos: m.index, path });
	}
	const out = new Map<string, string>();
	for (let i = 0; i < links.length; i++) {
		const end = i + 1 < links.length ? links[i + 1].pos : Math.min(html.length, links[i].pos + 3000);
		const d = firstIndexDate(html.slice(links[i].pos, end));
		if (d) out.set(links[i].path, d);
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
export function emitDiag(env: Env, ctx: ExecutionContext, kind: string, detail: string): void {
	const record = {
		at: new Date().toISOString(),
		app: "proxy",
		os: "worker",
		// UN-FORGEABLE server-origin marker: only emitDiag sets it. The error-spike pager counts ONLY
		// origin:"server" records, so a spoofed client /telemetry POST (which never carries origin —
		// handleTelemetryIngest copies only app/os/events from the body) can't trip the owner's alert.
		origin: "server",
		events: [{ kind: kind.slice(0, 40), detail: detail.slice(0, 80), ts: Date.now() }],
	};
	console.log("telemetry", JSON.stringify(record));
	// SERVER diagnostics use a SEPARATE `sdiag:` prefix from client `/telemetry` (`diag:`) so the
	// error-spike pager (checkErrorSpike) scans server errors ALONE — a fleet-scale client-telemetry
	// flood can never bury them in the newest-N list window. The owner view (/telemetry/recent) merges both.
	const key = `sdiag:${1e15 - Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
	ctx.waitUntil(env.FEED_TAGS.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 }));
}

/** Many events, ONE KV write. For a job that produces a burst of findings at once (the nightly
 *  roster verification emits one event per failing gate across 16 clubs) — a put per finding would
 *  blow the invocation's subrequest budget and burn the free-tier daily write allowance.
 *
 *  `checkErrorSpike` already iterates `record.events`, so a batch of N countable kinds contributes N
 *  toward the alert threshold. That is deliberate: one club failing a gate is 1–2 events and stays
 *  quiet, while a contamination or a deleted club fails many at once and pages. */
export function emitDiagBatch(env: Env, ctx: ExecutionContext, events: { kind: string; detail: string }[]): void {
	if (events.length === 0) return;
	const ts = Date.now();
	const record = {
		at: new Date().toISOString(),
		app: "proxy",
		os: "worker",
		origin: "server",
		events: events.slice(0, 20).map((e) => ({ kind: e.kind.slice(0, 40), detail: e.detail.slice(0, 80), ts })),
	};
	console.log("telemetry", JSON.stringify(record));
	const key = `sdiag:${1e15 - ts}:${crypto.randomUUID().slice(0, 8)}`;
	ctx.waitUntil(env.FEED_TAGS.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 }));
}

// ── Weekly adjudication (GET /roster-truth/todo + POST /roster-truth/rulings) ────

/** The routine's two endpoints. Auth = `x-adjudicate-key` == ROSTER_ADJUDICATE_KEY (a dedicated
 *  secret — deliberately NOT BRACKET_ADMIN_KEY). The hard rules live in `applyAutoRulings`, not
 *  in the routine's prompt: no source → rejected; an owner pin is never overwritten; positions
 *  and jerseys only (membership is structurally untouchable via applyOverrides). */
async function handleAdjudication(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const key = (env as unknown as { ROSTER_ADJUDICATE_KEY?: string }).ROSTER_ADJUDICATE_KEY;
	if (!key || request.headers.get("x-adjudicate-key") !== key) {
		return new Response("forbidden", { status: 403 });
	}
	const url = new URL(request.url);
	const now = Date.now();

	if (url.pathname === "/roster-truth/todo") {
		if (request.method !== "GET") return new Response("use GET", { status: 405 });
		const [report, overrides] = await Promise.all([readRosterTruthReport(env), readOverrides(env)]);
		const pending = pendingAdjudications(report, overrides, now);
		return Response.json({
			reportRanAt: report?.ranAt ?? null,
			...pending,
			counts: { positions: pending.positions.length, jerseys: pending.jerseys.length },
		});
	}

	// POST /roster-truth/rulings
	if (request.method !== "POST") return new Response("use POST", { status: 405 });
	let body: { rulings?: AutoRuling[] } = {};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}
	if (!Array.isArray(body.rulings)) return Response.json({ error: "rulings must be an array" }, { status: 400 });
	if (body.rulings.length > 40) return Response.json({ error: "too many rulings (max 40)" }, { status: 400 });

	const overrides = await readOverrides(env);
	const { next, accepted, skipped } = applyAutoRulings(overrides, body.rulings, now);
	if (accepted.length > 0) await writeOverrides(env, next);
	// One batched diag — visible in telemetry, deliberately not paged (this is routine maintenance).
	emitDiagBatch(env, ctx, [
		{ kind: "rosterAutoRuling", detail: `accepted=${accepted.length} skipped=${skipped.length}` },
		...accepted.slice(0, 10).map((id) => ({ kind: "rosterAutoRulingSet", detail: id })),
	]);
	return Response.json({ ok: true, accepted, skipped, ttlDays: OVERRIDE_TTL_DAYS });
}

// ── Operator portal (GET /admin + POST /admin/roster) ────────────────────────────

/** The tabbed portal shell and the Roster tab's ops. Bracket + Know Her Game keep their own
 *  handlers and URLs untouched — the shell iframes them (see src/admin-portal.ts for why). */
// ── Operator STATUS tab: an on-demand, at-a-glance health check (GET /admin/status) ───────────
// Surfaces the fragile + silently-failing surfaces so a broken club URL / dead reporter handle /
// ESPN outage / stale snapshot shows as a colored row instead of quietly degrading. Complements the
// passive alerting (Resend spike pager + healthchecks.io), it doesn't replace it.
//
// ⚠️ SUBREQUEST BUDGET: Cloudflare caps fetch()+KV subrequests PER Worker invocation. Running every
// check in one request blew that cap and made tail checks FALSELY fail. Two defenses: (1) the club
// probe is LIGHT — one fetch/club, NO per-article OG enrich (that fan-out was the explosion); (2) the
// page loads each SECTION in its own request (own budget) — the shell fetches /admin/status?section=…
// per section and assembles them client-side.

type StatusCheck = { label: string; status: "ok" | "warn" | "fail" | "info"; detail: string };
type StatusSection = { title: string; note?: string; checks: StatusCheck[] };

// Clubs the Worker's datacenter IP is blocked from → the app device-fetches them from a residential
// IP (Phase 2b). Their OFFICIAL health can only be verified from a device, so the app POSTs a beacon
// (/club-news/device-report) and the Status tab reads it back (a URL move → 🔴 instead of a masked 🔵).
const DEVICE_FALLBACK_CLUBS = new Set(["CHI", "POR"]);
const clubDeviceHealthKey = (abbr: string) => `clubnews-devhealth-${abbr}`;
type ClubDeviceHealth = { ok: boolean; count: number; at: number; error?: string };

/** LIGHT probe of a club's OFFICIAL source — ONE fetch, no per-article OG enrich (unlike the real
 *  clubIndexCards, whose OG fan-out blows the subrequest budget). rss/api count inline cards; index
 *  counts article LINKS on the SSR'd page — the "source alive / URL still valid" signal, which is all
 *  the status grid needs (a moved URL → 0 links → 🟡, the Houston-Dash case). */
async function clubOfficialProbe(abbr: string): Promise<{ count: number; newest: string }> {
	const src = CLUB_NEWS[abbr];
	if (!src || !("url" in src)) return { count: 0, newest: "" };
	const url = (src as { url: string }).url;
	const newestOf = (cards: NewsCard[]) => ((cards[0] as { timestamp?: string })?.timestamp ?? "").slice(0, 10);
	try {
		if (src.kind === "rss") { const c = await clubRssCards(abbr, url); return { count: c.length, newest: newestOf(c) }; }
		if (src.kind === "api") { const c = await clubApiCards(abbr, url); return { count: c.length, newest: newestOf(c) }; }
		if (src.kind === "index") {
			const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } });
			if (!r.ok) return { count: 0, newest: `HTTP ${r.status}` };
			const html = await r.text();
			const path = (src as { articlePath: string }).articlePath;
			const links = extractArticleLinks(html, url, path);
			const dates = [...extractIndexDates(html, path).values()].sort();
			return { count: links.length, newest: dates.length ? dates[dates.length - 1].slice(0, 10) : "" };
		}
	} catch { /* → 0 */ }
	return { count: 0, newest: "" };
}

function ageLabel(ms: number): string {
	const h = ms / 3_600_000;
	if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
	if (h < 48) return `${Math.round(h)}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/** The device-fallback health for one blocked club (CHI/POR), from the beacon the app POSTs. */
async function deviceFallbackCheck(abbr: string, url: string | undefined, env: Env): Promise<StatusCheck> {
	const raw = await env.FEED_TAGS.get(clubDeviceHealthKey(abbr)).catch(() => null);
	if (!raw) return { label: abbr, status: "warn", detail: "device-fallback club — NO device check yet (open the app on a device to verify its URL)" };
	let rec: ClubDeviceHealth;
	try { rec = JSON.parse(raw) as ClubDeviceHealth; } catch { return { label: abbr, status: "warn", detail: "device-fallback club — unreadable beacon" }; }
	const age = Date.now() - (rec.at ?? 0);
	if (!rec.ok || rec.count <= 0) {
		return { label: abbr, status: "fail", detail: `device-fetch got NOTHING (${ageLabel(age)}) — URL MOVED/blocked? ${rec.error ? `[${rec.error}] ` : ""}CHECK: ${url ?? "—"}` };
	}
	if (age > 3 * 24 * 3_600_000) {
		return { label: abbr, status: "warn", detail: `verified via device but STALE (last ok ${ageLabel(age)}, ${rec.count} cards) — no recent device to re-check` };
	}
	return { label: abbr, status: "ok", detail: `verified via device: ${rec.count} cards (${ageLabel(age)})` };
}

async function statusCheckClubNews(env: Env): Promise<StatusSection> {
	const abbrs = Object.keys(CLUB_NEWS).sort();
	const checks = await Promise.all(abbrs.map(async (abbr): Promise<StatusCheck> => {
		const src = CLUB_NEWS[abbr];
		if (src.kind === "fallback") return { label: abbr, status: "warn", detail: "press fallback only — no official source configured" };
		const probe = await clubOfficialProbe(abbr);
		if (probe.count > 0) {
			return { label: abbr, status: "ok", detail: `${probe.count} article${probe.count === 1 ? "" : "s"}${probe.newest ? ` · newest ${probe.newest}` : ""}` };
		}
		// 0 official from the proxy: a KNOWN device-fallback club is verified via the app's beacon
		// (so a URL move surfaces as 🔴/stale, not a masked 🔵); an UNKNOWN club is a real regression.
		if (DEVICE_FALLBACK_CLUBS.has(abbr)) return deviceFallbackCheck(abbr, (src as { url?: string }).url, env);
		return { label: abbr, status: "warn", detail: `official source returned 0 → press fallback. CHECK THE URL: ${(src as { url?: string }).url ?? "—"}` };
	}));
	return {
		title: "Club news — official source per club",
		note: "🟡 = quietly on press fallback: a changed/broken club URL (the Houston-Dash case) shows here instead of failing silently. Device-fallback clubs (CHI/POR) are verified from the app's beacon — 🔴 = its URL moved.",
		checks,
	};
}

async function statusFetch(label: string, url: string, ua: string, ok: (d: unknown) => boolean, detail: (d: unknown) => string): Promise<StatusCheck> {
	try {
		const r = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/json" } });
		if (!r.ok) return { label, status: "fail", detail: `HTTP ${r.status}` };
		const d = await r.json();
		return ok(d) ? { label, status: "ok", detail: detail(d) } : { label, status: "warn", detail: "200 but empty / unexpected shape" };
	} catch (e) {
		return { label, status: "fail", detail: String((e as Error)?.message ?? e).slice(0, 90) };
	}
}

async function statusCheckESPN(): Promise<StatusSection> {
	const checks = await Promise.all([
		statusFetch("Scoreboard", ESPN_SCOREBOARD, ESPN_UA, (d) => Array.isArray((d as { events?: unknown[] }).events), (d) => `${(d as { events?: unknown[] }).events?.length ?? 0} events`),
		statusFetch("Standings", "https://site.api.espn.com/apis/v2/sports/soccer/usa.nwsl/standings", ESPN_UA, (d) => JSON.stringify(d).length > 200, () => "reachable"),
		statusFetch("Teams", "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/teams", ESPN_UA, (d) => JSON.stringify(d).includes('"team"'), () => "reachable"),
	]);
	return { title: "ESPN core endpoints (the Aug-4 outage path)", note: "A scoreboard failure takes Home + Schedule dark and paged nobody last time — this catches it at a glance.", checks };
}

// Dormancy tiers for a Bluesky handle, keyed on the age of its most recent ORIGINAL post (reposts
// don't count — they add nothing to the Social tab). 🔴 at >30d because the app's feed only shows
// third-party posts within ~30d, so past that the handle is invisible in Social = a drop candidate.
const BSKY_COOLING_MS = 14 * 86_400_000; // 🟢 → 🟡
const BSKY_DORMANT_MS = 30 * 86_400_000; // 🟡 → 🔴 (matches the app's ~30d feed window)

/** Age (ms) of the newest ORIGINAL post in a newest-first feed, or null if none found. */
function latestOriginalAgeMs(feed: BskyItem[], now: number): number | null {
	for (const it of feed) {
		if (it.reason) continue; // repost — not this account's own content
		const createdAt = it.post?.record?.createdAt;
		if (!createdAt || !it.post?.record?.text) continue;
		const t = Date.parse(createdAt);
		if (!Number.isNaN(t)) return now - t; // first original hit = the most recent
	}
	return null;
}

/** One default Bluesky handle's health, shared by the admin Status tab (HTML) and
 *  GET /social/reporter-audit (JSON) — one source of truth for the tier logic. */
type BskyHealth = { handle: string; kind: "reporter" | "league"; tier: "ok" | "cooling" | "dormant" | "empty" | "dead"; lastPostDays: number | null };
async function bskySourceHealth(env: Env): Promise<BskyHealth[]> {
	const now = Date.now();
	const bsky = (await loadFeedHandles(env)).filter((h) => h.kind === "reporter" || h.kind === "league");
	return Promise.all(bsky.map(async (h): Promise<BskyHealth> => {
		const kind = h.kind as "reporter" | "league";
		try {
			const feed = await bskyAuthorFeed(h.handle, 15); // deeper sample so reposts don't mask an active handle
			const age = latestOriginalAgeMs(feed, now);
			if (age === null) return { handle: h.handle, kind, tier: "empty", lastPostDays: null };
			const days = Math.floor(age / 86_400_000);
			if (age < BSKY_COOLING_MS) return { handle: h.handle, kind, tier: "ok", lastPostDays: days };
			if (age <= BSKY_DORMANT_MS) return { handle: h.handle, kind, tier: "cooling", lastPostDays: days };
			return { handle: h.handle, kind, tier: "dormant", lastPostDays: days };
		} catch {
			return { handle: h.handle, kind, tier: "dead", lastPostDays: null };
		}
	}));
}

async function statusCheckFeedSources(env: Env): Promise<StatusSection> {
	const bskyChecks = (await bskySourceHealth(env)).map((s): StatusCheck => {
		const when = s.lastPostDays !== null ? `last post ${s.lastPostDays}d ago` : "";
		switch (s.tier) {
			case "ok":      return { label: s.handle, status: "ok", detail: when };
			case "cooling": return { label: s.handle, status: "warn", detail: `${when} — cooling` };
			case "dormant": return { label: s.handle, status: "fail", detail: `${when} — past the ~30d feed window, invisible in Social (drop candidate)` };
			case "empty":   return { label: s.handle, status: "fail", detail: "no original posts in last 15 items (repost-only or empty timeline) — drop candidate" };
			case "dead":    return { label: s.handle, status: "fail", detail: "does NOT resolve on the keyless API — dead/renamed?" };
		}
	});
	const rssChecks = await Promise.all(NEWS_FEEDS.map(async (f): Promise<StatusCheck> => {
		try {
			const r = await fetch(f.url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/rss+xml, application/xml, text/xml" } });
			if (!r.ok) return { label: f.source, status: "fail", detail: `HTTP ${r.status} · ${f.url}` };
			const items = parseOutletRSS(await r.text()).length;
			return items > 0 ? { label: f.source, status: "ok", detail: `${items} items` } : { label: f.source, status: "warn", detail: "reachable but 0 items" };
		} catch (e) {
			return { label: f.source, status: "fail", detail: String((e as Error)?.message ?? e).slice(0, 70) };
		}
	}));
	return {
		title: "Feed sources — reporters/league (Bluesky) + news (RSS)",
		note: "Bluesky handles tier on their last ORIGINAL post (reposts don't count): 🟢 <14d · 🟡 14–30d cooling · 🔴 >30d (past the app's feed window → invisible in Social, drop candidate) or dead handle. Catches less-active vs gone.",
		checks: [...bskyChecks, ...rssChecks],
	};
}

async function statusCheckIG(env: Env): Promise<StatusSection> {
	const checks: StatusCheck[] = [];
	for (const [label, k] of [["Players pool A (Feed IG)", poolKey("A")], ["Players pool B (Feed IG)", poolKey("B")], ["Clubs (Home IG)", SOCIAL_CLUB_KEY]] as [string, string][]) {
		const raw = await env.FEED_TAGS.get(k).catch(() => null);
		if (!raw) {
			checks.push({ label, status: "fail", detail: "snapshot MISSING (cron failed or KV expired → no IG on that tab)" });
			continue;
		}
		let n = 0;
		try {
			const p = JSON.parse(raw) as unknown;
			n = Array.isArray(p) ? p.length : Array.isArray((p as { instagram?: unknown[] }).instagram) ? (p as { instagram: unknown[] }).instagram.length : Object.keys(p as object).length;
		} catch { /* keep 0 */ }
		checks.push({ label, status: n > 0 ? "ok" : "warn", detail: `${n > 0 ? `${n} cards` : "present"} · ${Math.round(raw.length / 1024)}KB cached` });
	}
	return { title: "Instagram snapshot (cron-refreshed every other day)", note: "IG is the fragile scrape path; a stale/empty snapshot = no player/club IG until the next cron.", checks };
}

async function statusCheckErrors(env: Env): Promise<StatusSection> {
	const list = await env.FEED_TAGS.list({ prefix: "sdiag:", limit: 120 });
	const now = Date.now();
	const DAY = 86_400_000, HOUR = 3_600_000;
	let last24 = 0, lastHour = 0;
	const recent: { kind: string; detail: string; ts: number }[] = [];
	const records = await Promise.all(list.keys.slice(0, 30).map((k) => env.FEED_TAGS.get(k.name, "json").catch(() => null)));
	for (const rec of records) {
		const events = (rec as { events?: { kind: string; detail: string; ts: number }[] } | null)?.events;
		if (!Array.isArray(events)) continue;
		for (const e of events) {
			const age = now - (e.ts ?? 0);
			if (age <= DAY) { last24++; if (recent.length < 12) recent.push(e); }
			if (age <= HOUR) lastHour++;
		}
	}
	const status: StatusCheck["status"] = lastHour >= 8 ? "fail" : last24 > 20 ? "warn" : last24 > 0 ? "info" : "ok";
	const checks: StatusCheck[] = [{
		label: "Proxy diagnostics (sdiag)",
		status,
		detail: `${last24} events / 24h · ${lastHour} / last hour${lastHour >= 8 ? " ⚠️ SPIKE (pager threshold)" : ""}`,
	}];
	for (const e of recent) checks.push({ label: `  ${e.kind}`, status: "info", detail: e.detail });
	return { title: "Recent proxy diagnostics (last 24h)", note: "The catch-all: every unexpected condition (fallback / API fail / parse / empty) logs here first.", checks };
}

const statusEsc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Render ONE section as an HTML fragment (the shell fetches these per section and injects them).
 *  Dots carry their status as a CLASS so the shell can tally 🔴/🟡 across all sections client-side. */
function renderStatusSection(sec: StatusSection): string {
	const rows = sec.checks.map((c) =>
		`<tr><td class="d"><span class="dot ${c.status}"></span></td>` +
		`<td class="l">${statusEsc(c.label)}</td><td class="det">${statusEsc(c.detail)}</td></tr>`).join("");
	return `<h2>${statusEsc(sec.title)}</h2>${sec.note ? `<p class="note">${statusEsc(sec.note)}</p>` : ""}<table>${rows}</table>`;
}

// The section registry — each runs in its OWN request (its own subrequest budget). Order = display order.
const STATUS_SECTIONS: Record<string, { label: string; run: (env: Env) => Promise<StatusSection> }> = {
	clubnews: { label: "Club news", run: (env) => statusCheckClubNews(env) },
	espn: { label: "ESPN core", run: () => statusCheckESPN() },
	feeds: { label: "Feed sources", run: (env) => statusCheckFeedSources(env) },
	ig: { label: "Instagram", run: (env) => statusCheckIG(env) },
	errors: { label: "Diagnostics", run: (env) => statusCheckErrors(env) },
};

function renderStatusShell(): string {
	const names = Object.keys(STATUS_SECTIONS);
	const labels: Record<string, string> = Object.fromEntries(names.map((n) => [n, STATUS_SECTIONS[n].label]));
	const placeholders = names.map((n) => `<div class="sec" data-sec="${n}"><h2>${statusEsc(labels[n])}</h2><p class="note pending">checking…</p></div>`).join("");
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><style>
body{background:#111;color:#eee;font:14px/1.55 -apple-system,system-ui,sans-serif;margin:0;padding:16px}
h2{font-size:13px;color:#9ad;margin:20px 0 2px;border-bottom:1px solid #333;padding-bottom:4px;text-transform:uppercase;letter-spacing:.03em}
table{border-collapse:collapse;width:100%} td{padding:3px 8px;vertical-align:top}
td.d{width:16px} .dot{display:inline-block;width:11px;height:11px;border-radius:50%;background:#888}
.dot.ok{background:#30d158} .dot.warn{background:#ffd60a} .dot.fail{background:#ff453a} .dot.info{background:#5ac8fa}
td.l{font-weight:600;white-space:nowrap;color:#ddd} td.det{color:#9a9a9a}
.note{color:#888;font-size:12px;margin:3px 0 6px} .note.pending{color:#5ac8fa}
.banner{padding:9px 13px;border-radius:6px;font-weight:700;margin-bottom:6px;background:#1a1a1a;color:#9ad}
.banner.ok{background:#0c2a16;color:#30d158} .banner.warn{background:#2a2408;color:#ffd60a} .banner.fail{background:#2c0e0e;color:#ff6961}
</style></head><body>
<div id="banner" class="banner">Running live checks…</div>
<p class="note">Each section is checked live in its own request. Reopen the Status tab to re-run.</p>
<div id="secs">${placeholders}</div>
<script>
const NAMES = ${JSON.stringify(names)};
const LABELS = ${JSON.stringify(labels)};
Promise.all(NAMES.map(async (name) => {
  const el = document.querySelector('[data-sec="' + name + '"]');
  try {
    const r = await fetch('/admin/status?section=' + name + '&t=' + Date.now(), { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    el.innerHTML = await r.text();
  } catch (e) {
    el.innerHTML = '<h2>' + LABELS[name] + '</h2><table><tr><td class="d"><span class="dot fail"></span></td>'
      + '<td class="l">section</td><td class="det">failed to load: ' + String(e) + '</td></tr></table>';
  }
})).then(() => {
  const fails = document.querySelectorAll('.dot.fail').length;
  const warns = document.querySelectorAll('.dot.warn').length;
  const b = document.getElementById('banner');
  if (fails) { b.className = 'banner fail'; b.textContent = '🔴 ' + fails + ' failing · ' + warns + ' warning' + (warns === 1 ? '' : 's'); }
  else if (warns) { b.className = 'banner warn'; b.textContent = '🟡 ' + warns + ' warning' + (warns === 1 ? '' : 's') + ' — worth a look'; }
  else { b.className = 'banner ok'; b.textContent = '🟢 All clear'; }
});
</script></body></html>`;
}

/** GET /admin/status — the operator status/health tab (authed; iframed by the /admin shell).
 *  No `section` → the shell (which fetches each section separately); `?section=NAME` → that one
 *  section's fragment, run live in this request's own subrequest budget. */
async function handleAdminStatus(request: Request, env: Env): Promise<Response> {
	const key = (env as unknown as { BRACKET_ADMIN_KEY?: string }).BRACKET_ADMIN_KEY;
	if (!adminAuthed(request, key)) {
		return new Response("Authentication required.", { status: 401, headers: { "WWW-Authenticate": adminRealm("NWSLApp Admin") } });
	}
	const section = new URL(request.url).searchParams.get("section");
	if (section) {
		const entry = STATUS_SECTIONS[section];
		if (!entry) return new Response("unknown section", { status: 404 });
		return new Response(renderStatusSection(await entry.run(env)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
	}
	return new Response(renderStatusShell(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleAdminPortal(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const key = (env as unknown as { BRACKET_ADMIN_KEY?: string }).BRACKET_ADMIN_KEY;
	if (!adminAuthed(request, key)) {
		return new Response("Authentication required.", {
			status: 401,
			headers: { "WWW-Authenticate": adminRealm("NWSLApp Admin") },
		});
	}
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/admin") {
		return new Response(ADMIN_PORTAL_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
	}
	if (request.method !== "POST") {
		return new Response("Method not allowed. Use POST.", { status: 405, headers: { Allow: "POST" } });
	}

	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		/* {} */
	}

	try {
		const op = String(body.op ?? "");
		const now = Date.now();

		// Every op returns the SAME payload shape so the page just re-renders from the response —
		// no partial client-side state to drift out of sync with KV.
		const respond = async () => {
			const [report, overrides] = await Promise.all([readRosterTruthReport(env), readOverrides(env)]);
			return Response.json({ report, overrides, ttlDays: OVERRIDE_TTL_DAYS });
		};

		if (op === "state") return await respond();

		if (op === "run") {
			await runRosterTruth(env, (events) => emitDiagBatch(env, ctx, events));
			return await respond();
		}

		if (op === "setOverride") {
			const id = String(body.espnAthleteId ?? "");
			if (!id) return Response.json({ error: "espnAthleteId required" }, { status: 400 });
			const overrides = await readOverrides(env);
			const pos = body.position ? (String(body.position) as RosterOverride["position"]) : undefined;
			const jersey = body.jersey == null ? undefined : Number(body.jersey);
			overrides[id] = {
				espnAthleteId: id,
				playerName: String(body.playerName ?? id),
				teamAbbr: String(body.teamAbbr ?? ""),
				...(pos ? { position: pos } : {}),
				...(Number.isFinite(jersey) ? { jersey } : {}),
				setAt: new Date(now).toISOString(),
				expiresAt: overrideExpiry(now),
			};
			await writeOverrides(env, overrides);
			emitDiag(env, ctx, "rosterOverrideSet", `${id} ${pos ?? ""}${jersey != null ? `#${jersey}` : ""}`.slice(0, 60));
			return await respond();
		}

		if (op === "renewOverride" || op === "removeOverride") {
			const id = String(body.espnAthleteId ?? "");
			const overrides: OverrideMap = await readOverrides(env);
			if (!overrides[id]) return Response.json({ error: "no such override" }, { status: 404 });
			if (op === "removeOverride") delete overrides[id];
			else overrides[id] = { ...overrides[id], setAt: new Date(now).toISOString(), expiresAt: overrideExpiry(now) };
			await writeOverrides(env, overrides);
			emitDiag(env, ctx, op === "removeOverride" ? "rosterOverrideRemoved" : "rosterOverrideRenewed", id);
			return await respond();
		}

		return Response.json({ error: `unknown op "${op}"` }, { status: 400 });
	} catch (e) {
		const err = e as Error;
		return Response.json({ error: `${err.message ?? err}` }, { status: 500 });
	}
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
	const r = await fetchBounded(url, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } });
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
				const r = await fetchBounded(feed.url, {
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
			} catch (e) {
				// Hang-bound tripped (or outlet died): this outlet sits out THIS refresh only —
				// loud to the engineer, retried fresh next cycle. Never a standing exclusion.
				if (isTimeout(e)) emitDiag(env, ctx, "feedUpstreamTimeout", `rss:${feed.url.slice(0, 60)}`);
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

// Phase 3 "make it yours": a comma-separated, lowercased, de-duped handle/id list from a
// query param (user-added Bluesky reporters via `handles`, followed player IG ids via
// `players`). Sorted so the /feed cache key is stable regardless of the order the app sends.
const MAX_USER_HANDLES = 20; // cap the per-request Bluesky fan-out a user can trigger
function parseHandleList(raw: string | null): string[] {
	return [
		...new Set(
			(raw ?? "")
				.split(",")
				.map((h) => h.trim().toLowerCase().replace(/^@/, ""))
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
	// Phase 3 "make it yours": the user's added Bluesky reporter handles + followed player
	// IG ids. Both personalize the feed and are folded into the cache key below.
	// 2b layering (owner design): `muted` = DEFAULT handles the user toggled off — excluded
	// from the curated fetch, and NOT allowed to supersede a same-handle user add (row 4 of
	// the layering table: default off + user-added ⇒ the unfiltered add resurfaces).
	const userHandles = parseHandleList(url.searchParams.get("handles")).slice(0, MAX_USER_HANDLES);
	const userPlayers = new Set(parseHandleList(url.searchParams.get("players")));
	const mutedDefaults = new Set(parseHandleList(url.searchParams.get("muted")));
	// 2c: Bluesky handles the user added AS PLAYERS (the add-flow's reporter|player pick).
	// Player voices NEVER go through Haiku (owner law) — served unfiltered like player IG.
	const userPlayerBsky = parseHandleList(url.searchParams.get("playerBsky")).slice(0, MAX_USER_HANDLES);

	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.searchParams.set("teams", teams.join(","));
	// Normalize the personalization params into the cache key so one user's picks never
	// leak into another's feed AND send-order variance doesn't fragment the cache.
	if (userHandles.length) cacheUrl.searchParams.set("handles", userHandles.join(","));
	else cacheUrl.searchParams.delete("handles");
	if (userPlayers.size) cacheUrl.searchParams.set("players", [...userPlayers].sort().join(","));
	else cacheUrl.searchParams.delete("players");
	if (mutedDefaults.size) cacheUrl.searchParams.set("muted", [...mutedDefaults].sort().join(","));
	else cacheUrl.searchParams.delete("muted");
	if (userPlayerBsky.length) cacheUrl.searchParams.set("playerBsky", [...userPlayerBsky].sort().join(","));
	else cacheUrl.searchParams.delete("playerBsky");
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let cards: unknown[];
	try {
		// Three sources: reporters + league outlets (always) + the requested clubs'
		// own posts. Per-handle failures are isolated inside blueskyCardsFor, so a
		// single dead account can't trip the stale/502 fallback — that's reserved for
		// a total Bluesky outage.
		// Layering: active defaults = curated list minus the user's muted toggles. A user-added
		// handle that is ALSO an active default is superseded (served filtered, once); if the
		// default is muted, the user add wins and serves unfiltered below.
		const activeDefaults = (await loadFeedHandles(env)).filter((h) => !mutedDefaults.has(h.handle.toLowerCase()));
		const activeDefaultSet = new Set(activeDefaults.map((h) => h.handle.toLowerCase()));
		const reporterHandles = activeDefaults.filter((h) => h.kind === "reporter");
		const leagueHandles = activeDefaults.filter((h) => h.kind === "league");
		// Phase 3 "make it yours": the user's own-added Bluesky reporters, fetched alongside
		// the curated set (per-handle failures isolated in blueskyCardsFor).
		const userReporterHandles: FeedHandle[] = userHandles
			.filter((h) => !activeDefaultSet.has(h.toLowerCase()))
			.map((h) => ({ handle: h, kind: "reporter" }));
		// TWO WAVES, deliberately sequential (2026-08-16): workerd caps ~6 concurrent outbound
		// connections per invocation, so 16 parallel Bluesky fetches starve the lane queue for
		// everything behind them — during a Bluesky degradation that made a 0.6s RSS fetch
		// "time out" from queueing alone. News + the KV snapshot go FIRST (fast, small); the
		// Bluesky wave follows with its hang bound, so a Bluesky incident degrades ONLY the
		// Bluesky sources and the rest of the feed always arrives.
		const [newsCards, social] = await Promise.all([
			// News (B1): per-outlet RSS → Haiku NWSL-gate + team-tag + followed-team
			// filter → OG-enrich → newsArticle cards. Self-isolating; failures yield [].
			buildNewsCards(teams, env, ctx),
			// Social (B3b): the cron-built IG snapshot; here we take the player clips
			// (placement "feed") for the followed teams PLUS the user's followed cross-team
			// players. (Club-official Bluesky was retired from the Feed 2026-08.)
			readSocialCards(env),
		]);
		// 2c: the USER's own player-Bluesky adds (the add-flow's reporter|player pick). NO Haiku.
		// ⚠️ DEFAULT player-Bluesky discovery/serving was DROPPED (owner 2026-08-17): the backfill
		// sweep proved almost no players are really on Bluesky (the name-matches were impersonation
		// squats) — 1-2 default bsky players across 16 clubs would read as broken, not thorough,
		// and bsky identity is far harder to verify than IG. Players = IG-only for DEFAULTS;
		// user adds remain free to include player bsky (their explicit choice).
		const userPlayerBskyHandles: FeedHandle[] = userPlayerBsky.map((h) => ({ handle: h, kind: "player" }));

		const [rawReporters, rawLeague, rawUserReporters, rawUserPlayerBsky] = await Promise.all([
			buildBlueskyCards(reporterHandles, env, ctx),
			buildBlueskyCards(leagueHandles, env, ctx),
			buildBlueskyCards(userReporterHandles, env, ctx),
			buildBlueskyCards(userPlayerBskyHandles, env, ctx),
		]);
		// Reporter + league-outlet Bluesky carry no team tag of their own and post
		// off-topic too → one Haiku pass gates relevance, team-tags, and filters to
		// the followed teams (classifySocialBluesky). Player IG (playerSocial) is a
		// trusted fast path — already team-tagged, no Haiku. News is gated+filtered
		// inside buildNewsCards.
		const socialBluesky = await classifySocialBluesky(
			[...rawReporters, ...rawLeague],
			teams,
			env,
			ctx,
		);
		// ⚠️ COST FIREWALL (owner design, 2b): user-added handles NEVER touch Haiku. The user
		// chose to follow them — show everything, unfiltered (that's the value of a personal
		// add; the curated default list is the filtered experience). This bounds Haiku spend
		// to the owner-curated defaults no matter how many handles users add. `userAdded`
		// marks the cards for the app's layering logic.
		const userReporterCards = rawUserReporters.map((c) => ({ ...(c as Record<string, unknown>), userAdded: true }));
		const userPlayerBskyCards = rawUserPlayerBsky.map((c) => ({ ...(c as Record<string, unknown>), userAdded: true }));
		const playerSocial = socialFor(social, teams, new Set(["feed"]), userPlayers);
		cards = [...socialBluesky, ...userReporterCards, ...newsCards, ...playerSocial, ...userPlayerBskyCards].sort(
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

/** GET /feed/players — the DIRECTORY of the featured players (Phase 3 "Follow players").
 *  The app only receives followed-team player cards on /feed, so it needs this to browse
 *  them all + follow across team lines. Served from the LIVE player list (KV overlay the
 *  self-tuning routine maintains, seed until then) so it's always fresh and the app stays
 *  thin. `id` is the IG handle — the stable key the app sends back in /feed's `players` param. */
async function handlePlayerDirectory(env: Env): Promise<Response> {
	const players = (await loadPlayerSocial(env)).map((p) => ({ id: p.ig, name: p.name, team: p.abbr }));
	const headers = new Headers({ "Content-Type": "application/json" });
	headers.set("Cache-Control", "public, max-age=3600"); // 1h edge cache; routine changes land within the hour
	return new Response(JSON.stringify(players), { status: 200, headers });
}

/** GET /feed/validate-reporter?handle=… — Phase 3 "Add a reporter". Confirms a Bluesky
 *  account resolves on the keyless API, and whether it has NWSL-relevant posts recently (the
 *  same Haiku gate the feed uses, run over the full team set so any NWSL post counts — user-
 *  added handles are never team-scoped). `found` = the account resolves; `hasNWSLPosts` = at
 *  least one recent post survived the gate. Never throws to the caller — a bad handle returns
 *  { found: false }. */
async function handleValidateReporter(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const raw = url.searchParams.get("handle")?.trim().toLowerCase().replace(/^@/, "") ?? "";
	if (!raw) return jsonResponse({ found: false }, 200);
	let feed: BskyItem[];
	try {
		feed = await bskyAuthorFeed(raw, POSTS_PER_HANDLE);
	} catch {
		return jsonResponse({ found: false }, 200); // account doesn't resolve
	}
	const displayName = feed.find((it) => it.post?.author)?.post?.author?.displayName || raw;
	const cards = feed
		.filter((it) => !it.reason && it.post?.record?.text)
		.map((it) => mapBskyPost(it.post as BskyPost, { handle: raw, kind: "reporter" }))
		.filter(Boolean);
	const kept = cards.length ? await classifySocialBluesky(cards, [...NEWS_TEAM_ABBR_SET], env, ctx) : [];
	return jsonResponse({ found: true, displayName, handle: `@${raw}`, hasNWSLPosts: kept.length > 0 }, 200);
}

/** Build cards for a set of Bluesky handles (per-handle failures isolated). */
async function buildBlueskyCards(handles: FeedHandle[], env?: Env, ctx?: ExecutionContext): Promise<unknown[]> {
	const per = await Promise.all(handles.map((h) => blueskyCardsFor(h, env, ctx)));
	return per.flat();
}

/** Fetch one account's recent OWN posts (reposts dropped) and map them to
 *  ContentCards. A single handle failing yields [] — isolated like /team-videos'
 *  per-team try/catch — so one dead account never sinks the whole response. */
async function blueskyCardsFor(h: FeedHandle, env?: Env, ctx?: ExecutionContext): Promise<unknown[]> {
	try {
		const feed = await bskyAuthorFeed(h.handle, POSTS_PER_HANDLE);
		return feed
			// A repost carries a `reason`; drop it so we don't attribute someone
			// else's post to this account. Also require post text.
			.filter((it) => !it.reason && it.post?.record?.text)
			.map((it) => mapBskyPost(it.post as BskyPost, h))
			.filter(Boolean);
	} catch (e) {
		// Hang-bound tripped: this handle sits out THIS refresh only (retried fresh next
		// cycle) — diag'd so a repeat-offender upstream is visible, never silently skipped.
		if (isTimeout(e) && env && ctx) emitDiag(env, ctx, "feedUpstreamTimeout", `bsky:${h.handle}`);
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
	const r = await fetchBounded(u.toString(), {
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

	return {
		id: `bsky-${rkey}`,
		layout: "blueskyReporter",
		platform: "bluesky",
		// Source class for the app's Feed chips. Player-kind (2c) = a player's OWN Bluesky —
		// the trusted fast path like player IG: NEVER Haiku-classified (owner law).
		sourceType: h.kind === "league" ? "league" : h.kind === "player" ? "player" : "reporter",
		// Reporters + league outlets are league-wide (no team tag of their own; Haiku
		// team-tags + scopes them downstream). A DEFAULT player's card carries her club
		// (server already scoped it to followed teams); user adds stay league-wide-relevant.
		placement: "feed",
		teamAbbreviation: h.kind === "player" ? h.abbr : undefined,
		isLeague: h.kind !== "player" || !h.abbr,
		playerId: h.kind === "player" ? h.playerId : undefined,
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
// SOCIAL_* constants / CLUB_HANDLES + loadPlayerSocial above. Mappers are exported for unit tests.
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

/** One Bright Data Instagram post → a `socialVideo` ContentCard, or null if unusable.
 *  Field names are the BD Instagram Posts dataset output (`url`, `description`,
 *  `date_posted`, `photos` [array], `user_posted`, `shortcode`, `likes`); fallbacks kept
 *  for schema drift. SAME card shape as mapApifyInstagram — the app can't tell (and must
 *  not care) which service scraped a card. */
export function mapBrightDataInstagram(raw: unknown, h: SocialHandle): unknown | null {
	const item = raw as Record<string, unknown>;
	const code = (item.shortcode ?? item.post_id) as string | undefined;
	const url = (item.url as string | undefined) ?? (code ? `https://www.instagram.com/p/${code}/` : undefined);
	const ts = isoFromAny(item.date_posted ?? item.timestamp);
	if (!url || !ts) return null;

	const photos = item.photos;
	const image =
		(Array.isArray(photos) ? (photos[0] as string | undefined) : undefined) ??
		(item.display_url as string | undefined) ??
		(item.thumbnail as string | undefined);
	const caption = (item.description ?? item.caption) as string | undefined;

	return {
		id: `ig-${code ?? hashId(url)}`,
		layout: "socialVideo",
		platform: "instagram",
		placement: h.kind === "team" ? "home" : "feed",
		sourceType: h.kind === "team" ? "club" : "player",
		teamAbbreviation: h.abbr,
		isLeague: false,
		authorName: h.name,
		handle: `@${h.handle}`, // only used by capPerHandle; footer shows authorName
		bodyText: typeof caption === "string" ? caption || undefined : undefined,
		thumbnailURL: typeof image === "string" ? image : undefined,
		igFallback: false,
		likes: numOrUndef(item.likes ?? item.like_count),
		timestamp: ts,
		url,
		ctaLabel: "Open in Instagram",
	};
}

/** POST /brightdata-webhook — Bright Data's push delivery for the async player scrape.
 *  Auth: BD echoes BD_WEBHOOK_SECRET verbatim in the Authorization header (the trigger's
 *  `auth_header` param); anything else 403s. Maps items → cards → writes the PLAYER
 *  snapshot key (empty result keeps last-good). NO SILENT FAILURES: bad auth, unparseable
 *  body, and billed-but-empty handles (they eat the free 5k quota) all emit diag. */
export async function handleBrightDataWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const secret = env.BD_WEBHOOK_SECRET;
	if (request.method !== "POST" || !secret || request.headers.get("Authorization") !== secret) {
		emitDiag(env, ctx, "bdWebhookAuth", `rejected ${request.method}`);
		return new Response("forbidden", { status: 403 });
	}
	let items: unknown[];
	try {
		const body = (await request.json()) as unknown;
		items = Array.isArray(body) ? body : (((body as { data?: unknown[] } | null)?.data as unknown[] | undefined) ?? []);
	} catch {
		emitDiag(env, ctx, "bdWebhookBadBody", "unparseable JSON");
		return new Response("bad body", { status: 400 });
	}

	const clubs = CLUB_HANDLES;
	const byUser = new Map(clubs.map((h) => [h.handle.toLowerCase(), h]));
	const seen = new Set<string>();
	const cards = items
		.map((it) => {
			// BD keys the account on `user_posted`; the original input URL is a fallback.
			const rec = it as { user_posted?: string; user_username?: string; input?: { url?: string } };
			const fromInput = /instagram\.com\/([^/?]+)/.exec(rec.input?.url ?? "")?.[1];
			const user = String(rec.user_posted ?? rec.user_username ?? fromInput ?? "").toLowerCase();
			const h = byUser.get(user);
			if (!h) return null;
			seen.add(user);
			return mapBrightDataInstagram(it, h);
		})
		.filter(Boolean) as unknown[];

	// A handle with no delivered posts was still billed a record — flag it so a renamed/
	// dead account can't silently drain the free quota run after run.
	const missing = clubs.filter((h) => !seen.has(h.handle.toLowerCase()));
	if (missing.length > 0 && cards.length > 0) {
		emitDiag(env, ctx, "bdHandleEmpty", `${missing.length} clubs: ${missing.map((h) => h.handle).slice(0, 5).join(",")}`);
	}

	const kept = await writeSideOrKeepLastGood(env, ctx, SOCIAL_CLUB_KEY, cards, "club");
	return new Response(JSON.stringify({ received: items.length, cards: cards.length, kept }), {
		headers: { "Content-Type": "application/json" },
	});
}

/** Scrape the given IG handles via Apify and map to cards (defaults to ALL IG handles —
 *  the pre-split behavior, still used while BRIGHTDATA_TOKEN is unset). Cron-only.
 *  After the 2026-08-14 swap, the normal-path call is PLAYER handles only (clubs → BD).
 *
 *  TikTok is DEFERRED (owner: IG-only for now), so only Instagram is scraped — which
 *  also means a single actor runs, sidestepping the Apify FREE plan's 8192MB TOTAL
 *  concurrent-actor cap (running two at once trips `actor-memory-limit-exceeded`/402).
 *  To re-enable TikTok: add a SEQUENTIAL second pass (after IG, to stay under that cap)
 *  scraping APIFY_TIKTOK_ACTOR over the CLUB_SOCIAL.tiktok handles → mapApifyTikTok.
 *  IG empty (or no APIFY_TOKEN) → caller keeps the last good snapshot (→ seed fallback). */
async function buildSocialCards(env: Env, handles: SocialHandle[], ctx?: ExecutionContext): Promise<{ instagram: unknown[]; tiktok: unknown[] }> {
	const token = env.APIFY_TOKEN;
	if (!token) return { instagram: [], tiktok: [] };

	const igHandles = handles.filter((h) => h.platform === "instagram");
	const igByUser = new Map(igHandles.map((h) => [h.handle.toLowerCase(), h]));

	let instagram: unknown[] = [];
	try {
		const items = await apifyRunSync(
			APIFY_IG_ACTOR,
			{ usernames: igHandles.map((h) => h.handle), postsPerProfile: SOCIAL_POSTS_PER_PROFILE },
			token,
		);
		const seen = new Set<string>();
		instagram = items
			.map((it) => {
				// sones output keys the scraped account on `scraped_username`.
				const rec = it as { scraped_username?: string; ownerUsername?: string; user?: { username?: string } };
				const user = String(rec.scraped_username ?? rec.user?.username ?? rec.ownerUsername ?? "").toLowerCase();
				const h = igByUser.get(user);
				if (!h) return null;
				seen.add(user);
				return mapApifyInstagram(it, h);
			})
			.filter(Boolean) as unknown[];

		// Post-swap the player IG path lost the club webhook's dead-handle detection: a renamed/
		// deleted/private handle just yields zero cards silently. Flag the gap (same shape + total-
		// failure guard as the BD `bdHandleEmpty` diag) so a dead player handle can't drain the
		// free quota run after run unnoticed.
		if (ctx) {
			const missing = igHandles.filter((h) => !seen.has(h.handle.toLowerCase()));
			if (missing.length > 0 && instagram.length > 0) {
				emitDiag(env, ctx, "apifyHandleEmpty", `${missing.length}: ${missing.map((h) => h.handle).slice(0, 5).join(",")}`);
			}
		}
	} catch (e) {
		// IG failed this run — caller keeps the last good IG snapshot. Fail LOUD to the engineer so a
		// persistent Apify outage/402 is visible rather than looking like a quiet "no new posts".
		if (ctx) emitDiag(env, ctx, "apifyRunFail", String((e as Error)?.message ?? e).slice(0, 80));
	}

	return { instagram, tiktok: [] };
}

/** Cron/manual-refresh entry: rebuild the social snapshot → the SPLIT KV keys.
 *  PLAYER side: scraped via Apify inline (sync run) and written here. CLUB side: when
 *  Bright Data is configured, an ASYNC scrape is triggered and /brightdata-webhook writes
 *  the club key minutes later; until then clubs ride the same Apify run (pre-split
 *  fallback — the split deploys without a flag day). Returns a summary for /refresh-social. */
async function refreshSocialCache(env: Env, ctx?: ExecutionContext): Promise<{ playerCards: number; pool: string; clubs: string }> {
	const playerList = await loadPlayerSocial(env);
	// Pool hygiene: any entry without a pool (pre-rotation data, or a write that skipped
	// assignment) gets the lighter pool NOW and the list is persisted — never scrape-skipped.
	let assigned = false;
	for (const p of playerList) {
		if (p.pool !== "A" && p.pool !== "B") {
			p.pool = lighterPool(playerList);
			assigned = true;
		}
	}
	if (assigned) await env.FEED_TAGS.put(PLAYER_LIST_KEY, JSON.stringify(playerList));

	// Alternate pools: scrape the one NOT scraped last run.
	const last = await env.FEED_TAGS.get(POOL_MARKER_KEY);
	const thisPool: "A" | "B" = last === "A" ? "B" : "A";
	await env.FEED_TAGS.put(POOL_MARKER_KEY, thisPool);
	const poolPlayers = playerList.filter((p) => p.pool === thisPool);

	const igHandles = [...CLUB_HANDLES, ...playerIgHandles(poolPlayers)];
	const bdConfigured = !!(env.BRIGHTDATA_TOKEN && env.BD_WEBHOOK_SECRET);

	if (poolPlayers.length > MAX_POOL_HANDLES && ctx) {
		emitDiag(env, ctx, "playerCapExceeded", `pool ${thisPool}: ${poolPlayers.length}/${MAX_POOL_HANDLES}`);
	}

	const apifyHandles = bdConfigured ? igHandles.filter((h) => h.kind === "player") : igHandles;
	const { instagram } = await buildSocialCards(env, apifyHandles, ctx);
	const players = instagram.filter((c) => (c as { placement?: string }).placement === "feed");
	const playerCards = await writeSideOrKeepLastGood(env, ctx, poolKey(thisPool), players, "player", POOL_SNAPSHOT_TTL);

	let clubs: string;
	if (bdConfigured) {
		clubs = await triggerBrightDataClubs(env, ctx);
	} else {
		const fresh = instagram.filter((c) => (c as { placement?: string }).placement === "home");
		const kept = await writeSideOrKeepLastGood(env, ctx, SOCIAL_CLUB_KEY, fresh, "club");
		clubs = `apify-fallback:${kept}`;
		if (ctx) emitDiag(env, ctx, "bdUnconfigured", "clubs via apify fallback");
	}
	return { playerCards, pool: thisPool, clubs };
}

// ── Social self-tuning · Stage 1b: national-team eligibility ledger ───────────────
// The featured-player set's eligibility law is NWSL ∧ NT, EARNED (once an NWSL player has
// represented her NT, she stays eligible forever — a missed camp never drops her). The proxy
// had no NT roster data, so this builds it: per-federation ESPN squad fetch → intersect with
// current NWSL rosters by normalized name → append the matches to a KV ledger. Append-only:
// the ledger records observed fact. Promotion into the live player list is FULLY AUTOMATED
// (owner 2026-08-16): the Stage 1d routine researches handles and writes through
// POST /social/player-audit/apply; the run report is transparency, not a gate. docs/backend.md.
const NT_LEDGER_KEY = "social:nt-ledger";
const NWSL_NAMES_KEY = "social:nwsl-names"; // cached normalized-name → club-abbr map (12h)
const NWSL_NAMES_TTL = 60 * 60 * 12;

/** Feeds the `?nt=` audit accepts = WOMENS_NT_FEEDS minus the two pan-European QUALIFYING feeds
 *  (~53 teams each → 1 + 53 roster fetches, over the free-plan 50-subrequest cap, so they'd
 *  silently under-count). Excluded BY DESIGN, not paged around (owner 2026-08-16): qualifying is
 *  the expanded-trial player pool; anyone who matters appears in a friendly/major within a run or
 *  two, and the ledger is earned-forever so a miss only delays discovery, never loses it. */
const NT_AUDIT_EXCLUDED = new Set(["uefa.w.nations", "fifa.wworldq.uefa"]);
// Lazy: WOMENS_NT_FEEDS is declared further down the module — a top-level .filter() would TDZ-crash at init.
const ntAuditFeeds = () => WOMENS_NT_FEEDS.filter((s) => !NT_AUDIT_EXCLUDED.has(s));

// Owner ruling 2026-08-15: the three Europe-based players STAY while quota is limited —
// never listed as drops, and the apply route refuses to drop them (normalized names).
const GRANDFATHERED_PLAYERS = new Set(["emily fox", "naomi girma", "alyssa thompson"]);

/** Routine auth for the audit surface: the owner's admin key OR the scoped SOCIAL_AUDIT_KEY
 *  (x-audit-key header) the Claude Remote routine holds — so the routine never carries the
 *  full admin credential. Fail-closed: unset audit key ⇒ only the admin key works. */
function auditAuthed(request: Request, env: Env): boolean {
	const adminKey = (env as unknown as { BRACKET_ADMIN_KEY?: string }).BRACKET_ADMIN_KEY;
	if (adminAuthed(request, adminKey)) return true;
	const auditKey = (env as unknown as { SOCIAL_AUDIT_KEY?: string }).SOCIAL_AUDIT_KEY;
	return !!auditKey && request.headers.get("x-audit-key") === auditKey;
}

type LedgerEntry = {
	name: string;
	firstSeen: string;
	source: string;
	nation: string | null;
	// Written once by the routine's web research (POST /social/player-audit/research) so no
	// candidate is ever re-researched: found handles, or an explicit none/private verdict.
	// IDENTITY GATE (owner 2026-08-17): `category` = the account's exact IG professional-category
	// label as found ("Athlete", "Futbolista", …) — the evidence; `athleteClass` = the routine's
	// judgment that it's an athlete-class label. /apply REFUSES adds without athleteClass:true —
	// the same-name protection (verified blue check is an accuracy ACCELERATOR, not the gate).
	research?: { status: "found" | "none" | "private"; ig?: string; bsky?: string; category?: string; athleteClass?: boolean; verified?: boolean; checkedAt: string };
};

/** ESPN NT rosters come GROUPED by position (`athletes[].items[]`), unlike the FLAT NWSL club
 *  shape `mapEspnRosterAthletes` handles — decode defensively, tolerating either. */
function decodeNtRoster(json: unknown): string[] {
	const groups = ((json as { athletes?: unknown[] } | null)?.athletes ?? []) as unknown[];
	const names: string[] = [];
	for (const g of groups) {
		const rec = g as { items?: unknown[]; displayName?: string; fullName?: string };
		const items = Array.isArray(rec.items) ? rec.items : rec.displayName || rec.fullName ? [rec] : [];
		for (const it of items) {
			const p = it as { displayName?: string; fullName?: string };
			const name = p.displayName ?? p.fullName;
			if (name) names.push(String(name));
		}
	}
	return names;
}

/** One NT competition → every squad member with the nation they represent. One `/teams` call +
 *  one `/roster` call per nation, all under the free-tier 50-subrequest cap for a single slug. */
async function fetchNtRosters(slug: string): Promise<{ nation: string; name: string }[]> {
	const teamsRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams`, { headers: ESPN_HEADERS });
	if (!teamsRes.ok) return [];
	const teamsData = (await teamsRes.json().catch(() => null)) as {
		sports?: { leagues?: { teams?: { team?: { id?: string; abbreviation?: string; displayName?: string } }[] }[] }[];
	} | null;
	const teams = teamsData?.sports?.[0]?.leagues?.[0]?.teams ?? [];
	const out: { nation: string; name: string }[] = [];
	await Promise.all(
		teams.map(async (entry) => {
			const team = entry.team ?? {};
			if (!team.id) return;
			const nation = team.displayName ?? team.abbreviation ?? "?";
			try {
				const rRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${team.id}/roster`, { headers: ESPN_HEADERS });
				if (!rRes.ok) return;
				for (const name of decodeNtRoster(await rRes.json())) out.push({ nation, name });
			} catch {
				/* one nation short-read — the ledger is earned-not-snapshot, so a miss only delays */
			}
		}),
	);
	return out;
}

/** normalized NWSL player name → club abbr, across all 16 rosters.
 *  TWO FRESHNESS MODES (the Sam Kerr lesson, 2026-08-16 — a stale gate hid a July transfer from
 *  the first routine run): `live: true` (the ?section=nwsl DECISION report + /apply validation)
 *  skips every cache and fetches all 16 rosters (17 subrequests — affordable there); the default
 *  cached mode (the ?nt= ledger populate, which fans out up to ~33 ESPN calls of its own and
 *  genuinely needs the budget) reads the 12h KV map first, then `roster:{id}` records, then live.
 *  A ledger miss from staleness only DELAYS discovery (earned-forever); a decision-report miss
 *  hides a signing — so the decision path pays for fresh. Live builds write through to the cache. */
async function nwslNameMap(env: Env, ctx: ExecutionContext, opts?: { live?: boolean }): Promise<Map<string, string>> {
	if (!opts?.live) {
		const cached = await env.FEED_TAGS.get(NWSL_NAMES_KEY);
		if (cached) {
			try {
				return new Map(JSON.parse(cached) as [string, string][]);
			} catch {
				/* fall through and rebuild */
			}
		}
	}
	const teams = await fetchTeamAbbrs();
	const map = new Map<string, string>();
	await Promise.all(
		teams.map(async (t) => {
			let players: { name: string; team: string }[] = [];
			if (!opts?.live) {
				try {
					const raw = await env.FEED_TAGS.get(`roster:${t.id}`);
					if (raw) {
						const rec = JSON.parse(raw) as { body?: unknown };
						const decoded = mapEspnRosterAthletes(rec.body as Parameters<typeof mapEspnRosterAthletes>[0], t.abbr);
						if (decoded.length >= ROSTER_GOOD_MIN) players = decoded;
					}
				} catch {
					/* cold/corrupt cache — fall to a live fetch below */
				}
			}
			if (players.length === 0) players = await fetchRosterResilient(env as unknown as BracketEnv, t.id, t.abbr);
			for (const p of players) map.set(normalizeName(p.name), t.abbr);
		}),
	);
	if (map.size > 0) ctx.waitUntil(env.FEED_TAGS.put(NWSL_NAMES_KEY, JSON.stringify([...map]), { expirationTtl: NWSL_NAMES_TTL }));
	return map;
}

function gateLedgerLookup(ledger: Record<string, LedgerEntry>, name: string): LedgerEntry["research"] | undefined {
	return ledger[normalizeName(name)]?.research;
}

/** Read the ledger; if it doesn't exist yet, seed it from the current featured 34 (all
 *  NT-caliber by curation → earned). Returns the in-memory object for the caller to merge + write. */
async function readNtLedger(env: Env): Promise<Record<string, LedgerEntry>> {
	const raw = await env.FEED_TAGS.get(NT_LEDGER_KEY);
	if (raw) {
		try {
			return JSON.parse(raw) as Record<string, LedgerEntry>;
		} catch {
			/* corrupt — reseed below */
		}
	}
	const now = new Date().toISOString();
	const seed: Record<string, LedgerEntry> = {};
	for (const p of await loadPlayerSocial(env)) seed[normalizeName(p.name)] = { name: p.name, firstSeen: now, source: "seed", nation: null };
	return seed;
}

/** GET /social/player-audit — admin-keyed audit surface for the Stage 1d discovery routine.
 *  1b ships the `?nt=<slug>` mode: fetch that federation's squads, intersect with NWSL rosters,
 *  append new matches to the ledger, return a run summary. (`?section=nwsl` report = Stage 1c.) */
async function handlePlayerAudit(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (!auditAuthed(request, env)) {
		return new Response("Authentication required.", { status: 401, headers: { "WWW-Authenticate": adminRealm("NWSLApp Admin") } });
	}
	const j = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
	const url = new URL(request.url);
	const params = url.searchParams;
	const nt = params.get("nt");

	// ── Stage 1d: routine write-back — research memory + fully-automated apply ────────
	// GET /social/player-audit/scrape-meta — the IDENTITY-GATE data source (owner 2026-08-17:
	// verification is a MUST, not nice-to-have). Reads the MOST RECENT already-run Apify dataset
	// (a free API GET — never runs the actor, never spends scrape quota) and extracts each
	// scraped account's own IG metadata: verified flag, full name, follower count, whatever the
	// actor carries. This is Instagram's own answer for every featured handle — no login wall.
	if (request.method === "GET" && url.pathname === "/social/player-audit/scrape-meta") {
		const token = env.APIFY_TOKEN;
		if (!token) return j({ error: "APIFY_TOKEN unset" }, 500);
		const runsRes = await fetch(`${APIFY_API}/${APIFY_IG_ACTOR}/runs?token=${token}&desc=1&limit=1&status=SUCCEEDED`);
		if (!runsRes.ok) return j({ error: `apify runs list ${runsRes.status}` }, 502);
		const runs = (await runsRes.json()) as { data?: { items?: { id?: string; defaultDatasetId?: string; finishedAt?: string }[] } };
		const run = runs.data?.items?.[0];
		if (!run?.defaultDatasetId) return j({ error: "no succeeded runs found" }, 404);
		const dsRes = await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${token}&clean=1&limit=2000`);
		if (!dsRes.ok) return j({ error: `dataset read ${dsRes.status}` }, 502);
		const items = (await dsRes.json()) as Record<string, unknown>[];
		// Aggregate per scraped account; field names are actor-specific, so probe the common
		// spellings and ALSO return one raw item's key list so gaps are diagnosable, not guessed.
		const byHandle: Record<string, { verified?: boolean; fullName?: string; followers?: number; private?: boolean; posts: number; selfPosts?: number }> = {};
		for (const it of items) {
			const user = (it.user ?? {}) as Record<string, unknown>;
			const handle = String(it.scraped_username ?? user.username ?? it.ownerUsername ?? "").toLowerCase();
			if (!handle) continue;
			const e = (byHandle[handle] ??= { posts: 0 });
			e.posts++;
			// ⚠️ `user` = the POST AUTHOR, not the profile owner: a COLLAB post on her profile
			// carries the CO-POSTER's author object (clubs/sponsors — "TJ Maxx" on Mallory Pugh's
			// probe; league/club names across 29 handles). Identity fields are taken ONLY from
			// SELF-AUTHORED posts (author == scraped account) — collab items contribute nothing.
			if (String(user.username ?? "").toLowerCase() !== handle) continue;
			e.selfPosts = (e.selfPosts ?? 0) + 1;
			const v = user.is_verified;
			if (typeof v === "boolean") e.verified = v;
			const fn = user.full_name;
			if (typeof fn === "string" && fn) e.fullName = fn;
			const fo = user.follower_count;
			if (typeof fo === "number") e.followers = fo;
			const pr = user.is_private;
			if (typeof pr === "boolean") e.private = pr;
		}
		const sample = items[0] ? Object.keys(items[0]) : [];
		const sampleUser = items[0] ? Object.keys((items[0].user as Record<string, unknown>) ?? {}) : [];
		return j({ runFinishedAt: run.finishedAt, datasetItems: items.length, accounts: Object.keys(byHandle).length, byHandle, sampleItemKeys: sample, sampleUserKeys: sampleUser });
	}

	if (request.method === "POST" && url.pathname === "/social/player-audit/research") {
		let body: { results?: { name?: string; status?: string; ig?: string; bsky?: string; category?: string; athleteClass?: boolean; verified?: boolean }[] };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return j({ error: "unparseable JSON" }, 400);
		}
		const ledger = await readNtLedger(env);
		const saved: string[] = [];
		const unknown: string[] = [];
		// NO-SILENT-FAILURES (bug found by the 2026-08-17 backfill run): malformed entries used to
		// be skipped without a trace — `saved:0, unknown:[]` looked like success-shaped nothing
		// while the caller retried format after format. Every rejected entry now says WHY.
		const skipped: { name?: string; reason: string }[] = [];
		if (!Array.isArray(body.results)) {
			return j({ saved: 0, unknown: [], skipped: [{ reason: `body must be {"results":[...]} — got keys ${Object.keys(body as object).join(",") || "(none)"}` }] }, 400);
		}
		const now = new Date().toISOString();
		for (const r of body.results ?? []) {
			if (!r.name || !["found", "none", "private"].includes(r.status ?? "")) {
				skipped.push({ name: r.name, reason: !r.name ? "missing name" : `status must be found|none|private (got ${JSON.stringify(r.status)})` });
				continue;
			}
			const entry = ledger[normalizeName(r.name)];
			if (!entry) {
				unknown.push(r.name);
				continue;
			}
			entry.research = {
				status: r.status as "found" | "none" | "private",
				ig: r.ig || undefined,
				bsky: r.bsky || undefined,
				category: r.category || undefined,
				athleteClass: typeof r.athleteClass === "boolean" ? r.athleteClass : undefined,
				verified: typeof r.verified === "boolean" ? r.verified : undefined,
				checkedAt: now,
			};
			saved.push(r.name);
		}
		await env.FEED_TAGS.put(NT_LEDGER_KEY, JSON.stringify(ledger));
		emitDiag(env, ctx, "socialResearchSaved", `${saved.length} saved${unknown.length ? `, ${unknown.length} unknown` : ""}`);
		return j({ saved: saved.length, unknown, skipped });
	}

	if (request.method === "POST" && url.pathname === "/social/player-audit/apply") {
		let body: { add?: { name?: string; abbr?: string; ig?: string }[]; drop?: string[] };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return j({ error: "unparseable JSON" }, 400);
		}
		const list = [...(await loadPlayerSocial(env))];
		const nwsl = await nwslNameMap(env, ctx, { live: true });
		const gateLedger = await readNtLedger(env);
		const clubs = new Set(nwsl.values());
		const igSeen = new Set(list.map((p) => p.ig.toLowerCase()));
		const nameSeen = new Set(list.map((p) => normalizeName(p.name)));
		const now = new Date().toISOString();
		const rejected: { name: string; reason: string }[] = [];
		const added: string[] = [];
		const dropped: string[] = [];

		for (const d of body.drop ?? []) {
			const norm = normalizeName(String(d));
			if (GRANDFATHERED_PLAYERS.has(norm)) {
				rejected.push({ name: d, reason: "grandfathered — owner-only removal" });
				continue;
			}
			const idx = list.findIndex((p) => normalizeName(p.name) === norm);
			if (idx === -1) {
				rejected.push({ name: d, reason: "not on the list" });
				continue;
			}
			const [gone] = list.splice(idx, 1);
			igSeen.delete(gone.ig.toLowerCase());
			nameSeen.delete(norm);
			dropped.push(gone.name);
		}

		for (const a of body.add ?? []) {
			const name = String(a.name ?? "").trim();
			const abbr = String(a.abbr ?? "").trim().toUpperCase();
			const ig = String(a.ig ?? "").trim().replace(/^@/, "");
			if (!name || !abbr || !ig) {
				rejected.push({ name: name || "(missing)", reason: "name/abbr/ig required" });
				continue;
			}
			// ⚠️ IDENTITY GATE (owner 2026-08-17, server-enforced — not even the routine can skip it):
			// an add requires research on the ledger with athleteClass:true — the account carries an
			// athlete-class IG professional-category label ("Athlete"/localized equivalent), the
			// same-name protection. The app must never claim a feed is a pro player's without it.
			const gate = gateLedger[normalizeName(name)]?.research;
			if (gate?.athleteClass !== true) {
				rejected.push({ name, reason: `identity gate: athlete-class category not confirmed${gate?.category ? ` (found: ${gate.category})` : ""}` });
				continue;
			}
			if (!/^[a-z0-9._]{1,30}$/i.test(ig)) {
				rejected.push({ name, reason: `invalid ig handle: ${ig.slice(0, 30)}` });
				continue;
			}
			if (!clubs.has(abbr)) {
				rejected.push({ name, reason: `unknown club abbr: ${abbr}` });
				continue;
			}
			if (nameSeen.has(normalizeName(name)) || igSeen.has(ig.toLowerCase())) {
				rejected.push({ name, reason: "already on the list" });
				continue;
			}
			if (list.length >= MAX_PLAYER_HANDLES) {
				rejected.push({ name, reason: `ceiling ${MAX_PLAYER_HANDLES} reached` });
				continue;
			}
			// Pool auto-assignment (owner rule): new adds join whichever pool is lighter — the
			// routine never needs pool awareness; balance converges on its own.
			list.push({ name, abbr, ig, addedAt: now, source: "routine", pool: lighterPool(list) });
			igSeen.add(ig.toLowerCase());
			nameSeen.add(normalizeName(name));
			added.push(name);
		}

		if (added.length > 0 || dropped.length > 0) {
			await env.FEED_TAGS.put(PLAYER_LIST_KEY, JSON.stringify(list));
		}
		emitDiag(env, ctx, "socialPlayerApply", `+${added.length} -${dropped.length} → ${list.length}/${MAX_PLAYER_HANDLES}${rejected.length ? ` (${rejected.length} rejected)` : ""}`);
		return j({ added, dropped, rejected, total: list.length, ceiling: MAX_PLAYER_HANDLES });
	}

	// ── Stage 1c: the decision report the discovery routine (and owner) reads ─────────
	if (params.get("section") === "nwsl") {
		const [nwsl, ledger, playerList] = await Promise.all([nwslNameMap(env, ctx, { live: true }), readNtLedger(env), loadPlayerSocial(env)]);
		const featured = new Map(playerList.map((p) => [normalizeName(p.name), p]));

		// candidates = (ledger ∩ current NWSL rosters) − featured, split by research state so the
		// routine only ever web-researches the NEW names (token efficiency, adjudication-style).
		// Each carries the feed that earned eligibility so majors can outrank friendly-only later.
		type Candidate = { name: string; club: string; nation: string | null; source: string; firstSeen: string; research?: LedgerEntry["research"] };
		const needsResearch: Candidate[] = [];
		const researched: Candidate[] = [];
		for (const [norm, e] of Object.entries(ledger)) {
			const club = nwsl.get(norm);
			if (!club || featured.has(norm)) continue;
			const c: Candidate = { name: e.name, club, nation: e.nation, source: e.source, firstSeen: e.firstSeen };
			if (e.research) {
				c.research = e.research;
				researched.push(c);
			} else {
				needsResearch.push(c);
			}
		}
		const byClub = (a: Candidate, b: Candidate) => a.club.localeCompare(b.club) || a.name.localeCompare(b.name);
		needsResearch.sort(byClub);
		researched.sort(byClub);

		// drops = featured − current NWSL rosters (the ONLY roster-based drop). Advisory: a name
		// ESPN spells differently would land here too, so the routine verifies before applying.
		const drops: { name: string; club: string; ig: string }[] = [];
		const grandfathered: { name: string; club: string; grandfathered: true }[] = [];
		for (const p of playerList) {
			const norm = normalizeName(p.name);
			if (nwsl.has(norm)) continue;
			if (GRANDFATHERED_PLAYERS.has(norm)) grandfathered.push({ name: p.name, club: p.abbr, grandfathered: true });
			else drops.push({ name: p.name, club: p.abbr, ig: p.ig });
		}

		// Featured-count per club, EVERY club listed (zeros are the point: BOS/DEN/LOU gaps).
		const clubCoverage: Record<string, number> = {};
		for (const abbr of new Set(nwsl.values())) clubCoverage[abbr] = 0;
		for (const p of playerList) if (p.abbr in clubCoverage) clubCoverage[p.abbr]++;

		const bySource: Record<string, number> = {};
		for (const e of Object.values(ledger)) bySource[e.source] = (bySource[e.source] ?? 0) + 1;

		return j({
			generatedAt: new Date().toISOString(),
			capacity: {
				used: playerList.length,
				ceiling: MAX_PLAYER_HANDLES,
				headroom: MAX_PLAYER_HANDLES - playerList.length,
				pools: { A: playerList.filter((p) => p.pool === "A").length, B: playerList.filter((p) => p.pool === "B").length, perRunBudget: MAX_POOL_HANDLES },
				note: "ceiling is a CEILING, never a target — carry exactly who qualifies (2 rotating pools; adds auto-assign to the lighter)",
			},
			clubCoverage,
			// The live featured list WITH each player's research/gate record — what the
			// re-curation + backfill passes read (candidates below exclude featured by definition).
			featured: playerList.map((p) => ({ name: p.name, abbr: p.abbr, ig: p.ig, pool: p.pool, research: gateLedgerLookup(ledger, p.name) })),
			candidates: { needsResearch, researched },
			drops: { players: drops, note: "not on any NWSL roster — verify (ESPN name variant lands here too) before applying" },
			grandfathered,
			ledger: { size: Object.keys(ledger).length, bySource, feedsCovered: Object.keys(bySource).filter((s) => s !== "seed") },
		});
	}

	if (nt) {
		if (!ntAuditFeeds().includes(nt)) return j({ error: "unknown or excluded nt slug", validNt: ntAuditFeeds() }, 400);
		const [ntPlayers, nwsl] = await Promise.all([fetchNtRosters(nt), nwslNameMap(env, ctx)]);
		const ledger = await readNtLedger(env);
		const before = Object.keys(ledger).length;
		const now = new Date().toISOString();
		let matched = 0;
		const added: { name: string; nation: string; club: string }[] = [];
		for (const p of ntPlayers) {
			const norm = normalizeName(p.name);
			const club = nwsl.get(norm);
			if (!club) continue;
			matched++;
			if (!ledger[norm]) {
				ledger[norm] = { name: p.name, firstSeen: now, source: nt, nation: p.nation };
				added.push({ name: p.name, nation: p.nation, club });
			}
		}
		// Persist BEFORE responding (not waitUntil) so the summary's ledgerSize is truthful.
		await env.FEED_TAGS.put(NT_LEDGER_KEY, JSON.stringify(ledger));
		emitDiag(env, ctx, "socialNtLedgerRun", `${nt}: ${ntPlayers.length} nt / ${matched} nwsl / +${added.length}`);
		return j({
			slug: nt,
			ntPlayersFetched: ntPlayers.length,
			nwslRosterSize: nwsl.size,
			nwslMatched: matched,
			newlyAdded: added.length,
			added,
			ledgerSize: { before, after: Object.keys(ledger).length },
		});
	}

	return j({ error: "specify ?section=nwsl (the audit report) or ?nt=<slug> (ledger populate)", validNt: ntAuditFeeds() }, 400);
}

// ── Social self-tuning · Stage 2d: reporter audit surface ─────────────────────────
/** GET /social/reporter-audit — admin/routine-keyed JSON for the reporter side of the
 *  self-tuning routine: default-handle health (same tier logic as the admin Status tab via
 *  bskySourceHealth), a consecutive-dormant streak (the settled drop rule: flagged dormant on
 *  TWO consecutive audits ⇒ strong drop candidate; one flag = watch, could be vacation/leave),
 *  and the fans' add-signals from anonymous analytics (the Stage-3 counter feeds this — built
 *  consumer-first per the backbone rule, empty until that ships). Discovery beyond signals is
 *  the ROUTINE's web research (follows-of-follows graph signals REJECTED by owner). */
const REPORTER_AUDIT_STREAK_KEY = "social:reporter-dormant-streak";
async function handleReporterAudit(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (!auditAuthed(request, env)) {
		return new Response("Authentication required.", { status: 401, headers: { "WWW-Authenticate": adminRealm("NWSLApp Admin") } });
	}
	const url0 = new URL(request.url);

	// POST /social/reporter-audit/apply — the routine's AUTO-APPLY write path (owner 2026-08-17:
	// automate at ~90%, tune from real runs). Server guardrails the routine cannot bypass:
	// ≤ MAX_REPORTER_ADDS_PER_CALL adds per call, the MAX_FEED_HANDLES budget ceiling, handle
	// validation + dedupe. The quality bar (distinctive NWSL coverage, activity recency) lives
	// in the routine prompt; the mechanical limits live HERE.
	if (request.method === "POST" && url0.pathname === "/social/reporter-audit/apply") {
		let body: { add?: { handle?: string; kind?: string }[]; drop?: string[] };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return new Response(JSON.stringify({ error: "unparseable JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
		}
		const list = [...(await loadFeedHandles(env))];
		const seen = new Set(list.map((h) => h.handle.toLowerCase()));
		const added: string[] = [];
		const dropped: string[] = [];
		const rejected: { handle?: string; reason: string }[] = [];

		for (const d of body.drop ?? []) {
			const key = String(d).toLowerCase().replace(/^@/, "");
			const idx = list.findIndex((h) => h.handle.toLowerCase() === key);
			if (idx === -1) {
				rejected.push({ handle: d, reason: "not on the list" });
				continue;
			}
			list.splice(idx, 1);
			seen.delete(key);
			dropped.push(key);
		}

		for (const a of body.add ?? []) {
			const handle = String(a.handle ?? "").trim().replace(/^@/, "").toLowerCase();
			const kind = a.kind === "league" ? "league" : "reporter";
			if (!handle || !/^[a-z0-9][a-z0-9.-]{2,60}$/.test(handle) || !handle.includes(".")) {
				rejected.push({ handle: a.handle, reason: "invalid bluesky handle" });
				continue;
			}
			if (seen.has(handle)) {
				rejected.push({ handle, reason: "already on the list" });
				continue;
			}
			if (added.length >= MAX_REPORTER_ADDS_PER_CALL) {
				rejected.push({ handle, reason: `per-call add cap (${MAX_REPORTER_ADDS_PER_CALL}) reached` });
				continue;
			}
			if (list.length >= MAX_FEED_HANDLES) {
				rejected.push({ handle, reason: `budget ceiling ${MAX_FEED_HANDLES} reached` });
				continue;
			}
			list.push({ handle, kind });
			seen.add(handle);
			added.push(handle);
		}

		if (added.length > 0 || dropped.length > 0) {
			await env.FEED_TAGS.put(REPORTER_LIST_KEY, JSON.stringify(list));
		}
		emitDiag(env, ctx, "socialReporterApply", `+${added.length} -${dropped.length} → ${list.length}/${MAX_FEED_HANDLES}${rejected.length ? ` (${rejected.length} rejected)` : ""}`);
		return new Response(JSON.stringify({ added, dropped, rejected, total: list.length, ceiling: MAX_FEED_HANDLES }, null, 2), { headers: { "Content-Type": "application/json" } });
	}
	const health = await bskySourceHealth(env);

	// Consecutive-dormant streaks: previous audit's flagged set ∩ this one's.
	// ⚠️ OUTAGE GUARD (live-proven necessary during the 2026-08-16 Bluesky outage, when all 16
	// read "dead"): a MAJORITY flagged at once means Bluesky is down, not 16 simultaneous
	// retirements — freeze the streak state (don't persist, don't advance) and say so, so an
	// audit run during an outage can never manufacture mass drop candidates.
	const flaggedNow = health.filter((h) => h.tier === "dormant" || h.tier === "empty" || h.tier === "dead").map((h) => h.handle);
	const outageSuspected = flaggedNow.length > health.length / 2;
	let prevFlagged: string[] = [];
	try {
		prevFlagged = JSON.parse((await env.FEED_TAGS.get(REPORTER_AUDIT_STREAK_KEY)) ?? "[]") as string[];
	} catch {
		/* first run / corrupt — no streaks */
	}
	const secondConsecutive = outageSuspected ? [] : flaggedNow.filter((h) => prevFlagged.includes(h));
	if (!outageSuspected) ctx.waitUntil(env.FEED_TAGS.put(REPORTER_AUDIT_STREAK_KEY, JSON.stringify(flaggedNow)));
	else emitDiag(env, ctx, "reporterAuditOutage", `${flaggedNow.length}/${health.length} flagged — streaks frozen`);

	// Fans' add-signals (anonymous Level-3 counters; NO ids ever): reporter_added rows carry
	// param "TEAM|handle", reporter_add_session is the adders denominator. The threshold rule
	// (owner): 3+ adds of one handle among a team's fans ⇒ escalate to routine research.
	let addSignals: { handle: string; totalAdds: number; byTeam: Record<string, number> }[] = [];
	let totalAdders = 0;
	const sb = env as unknown as { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };
	if (sb.SUPABASE_URL && sb.SUPABASE_SERVICE_ROLE_KEY) {
		try {
			const base = sb.SUPABASE_URL.replace(/\/$/, "");
			const r = await fetch(
				`${base}/rest/v1/analytics_counters?event=in.(reporter_added,reporter_add_session)&select=event,param,count`,
				{ headers: { apikey: sb.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${sb.SUPABASE_SERVICE_ROLE_KEY}` } },
			);
			if (r.ok) {
				const rows = (await r.json()) as { event: string; param: string; count: number }[];
				const byHandle = new Map<string, { totalAdds: number; byTeam: Record<string, number> }>();
				for (const row of rows) {
					if (row.event === "reporter_add_session") {
						totalAdders += row.count;
						continue;
					}
					const [team, ...rest] = row.param.split("|");
					const handle = rest.join("|");
					if (!handle) continue;
					const e = byHandle.get(handle) ?? { totalAdds: 0, byTeam: {} };
					e.totalAdds += row.count;
					e.byTeam[team] = (e.byTeam[team] ?? 0) + row.count;
					byHandle.set(handle, e);
				}
				addSignals = [...byHandle.entries()].map(([handle, e]) => ({ handle, ...e })).sort((a, b) => b.totalAdds - a.totalAdds);
			} else {
				emitDiag(env, ctx, "reporterAuditSbFail", `analytics read ${r.status}`);
			}
		} catch (e) {
			emitDiag(env, ctx, "reporterAuditSbFail", String((e as Error)?.message ?? e).slice(0, 60));
		}
	}

	return new Response(
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				defaults: health,
				outageSuspected,
				dropCandidates: outageSuspected
					? { secondConsecutiveFlag: [], firstFlag: [], note: "MAJORITY of defaults flagged at once ⇒ Bluesky outage suspected — streaks frozen, no candidates this run; re-audit when healthy" }
					: {
							secondConsecutiveFlag: secondConsecutive,
							firstFlag: flaggedNow.filter((h) => !secondConsecutive.includes(h)),
							note: "two consecutive flagged audits = strong drop candidate; one = watch (vacation/leave)",
						},
				addSignals: { totalAdders, handles: addSignals, note: "empty until the reporter_added counter ships (Stage 3); threshold = 3+ adds of one handle among a team's fans" },
			},
			null,
			2,
		),
		{ headers: { "Content-Type": "application/json" } },
	);
}

/** Write one side's fresh cards to its KV key — or, when THIS scrape came back empty
 *  (outage / aborted run), re-put the last-good snapshot with a fresh TTL so the safety
 *  net can't age out mid-outage. Seeds from the LEGACY combined key when the side's own
 *  key doesn't exist yet (first post-split runs). Returns the card count now in KV. */
async function writeSideOrKeepLastGood(
	env: Env,
	ctx: ExecutionContext | undefined,
	key: string,
	fresh: unknown[],
	side: "club" | "player",
	ttl: number = SOCIAL_CACHE_TTL,
): Promise<number> {
	let cards = fresh;
	if (cards.length === 0) {
		const placement = side === "club" ? "home" : "feed";
		const [own, legacy] = await Promise.all([
			env.FEED_TAGS.get(key, "json") as Promise<unknown[] | null>,
			env.FEED_TAGS.get(SOCIAL_CACHE_KEY, "json") as Promise<Array<{ placement?: string }> | null>,
		]);
		cards = own ?? (legacy ?? []).filter((c) => c.placement === placement);
		if (ctx) emitDiag(env, ctx, "socialScrapeEmpty", `${side}: kept last-good ${cards.length}`);
	}
	if (cards.length === 0) return 0; // nothing now, nothing before — keep KV as-is
	await env.FEED_TAGS.put(key, JSON.stringify(cards), { expirationTtl: ttl });
	return cards.length;
}

/** Fire the ASYNC Bright Data scrape for the 16 club handles. Results arrive minutes
 *  later at POST /brightdata-webhook (delivery params on the trigger: our endpoint URL +
 *  BD_WEBHOOK_SECRET echoed as the Authorization header). Returns a status note for
 *  /refresh-social. Only called when BRIGHTDATA_TOKEN + BD_WEBHOOK_SECRET are set. */
async function triggerBrightDataClubs(env: Env, ctx?: ExecutionContext): Promise<string> {
	const clubs = CLUB_HANDLES;
	// Discover-by-profile-URL with a per-profile cap — BD honors num_of_posts (unlike the
	// cheap Apify actor), which is what keeps us inside the free 5k records/mo.
	const inputs = clubs.map((h) => ({
		url: `https://www.instagram.com/${h.handle}/`,
		num_of_posts: BD_POSTS_PER_PROFILE,
	}));
	const params = new URLSearchParams({
		dataset_id: BRIGHTDATA_IG_DATASET,
		type: "discover_new",
		discover_by: "url",
		endpoint: `${PROXY_PUBLIC_ORIGIN}/brightdata-webhook`,
		auth_header: env.BD_WEBHOOK_SECRET as string,
		format: "json",
		uncompressed_webhook: "true",
	});
	const r = await fetch(`${BRIGHTDATA_API}/trigger?${params}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.BRIGHTDATA_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify(inputs),
	});
	if (!r.ok) {
		const body = await r.text().catch(() => "");
		if (ctx) emitDiag(env, ctx, "bdTriggerFail", `${r.status} ${body.slice(0, 60)}`);
		return `bd-trigger-failed:${r.status}`;
	}
	const json = (await r.json().catch(() => null)) as { snapshot_id?: string } | null;
	return `bd-triggered:${json?.snapshot_id ?? "?"}`;
}

/** Read the social snapshot (club + player sides merged), falling back per side to the
 *  legacy combined key until the split keys exist. [] if nothing yet. */
async function readSocialCards(env: Env): Promise<unknown[]> {
	const [club, poolA, poolB, playerLegacy, legacy] = await Promise.all([
		env.FEED_TAGS.get(SOCIAL_CLUB_KEY, "json") as Promise<unknown[] | null>,
		env.FEED_TAGS.get(poolKey("A"), "json") as Promise<unknown[] | null>,
		env.FEED_TAGS.get(poolKey("B"), "json") as Promise<unknown[] | null>,
		env.FEED_TAGS.get(SOCIAL_PLAYER_KEY, "json") as Promise<unknown[] | null>,
		env.FEED_TAGS.get(SOCIAL_CACHE_KEY, "json") as Promise<Array<{ placement?: string }> | null>,
	]);
	const legacyArr = legacy ?? [];
	const clubs = club ?? legacyArr.filter((c) => c.placement === "home");
	// Rotation: players = the MERGE of both pool snapshots (each refreshed on alternate runs, so
	// every featured player is served all week). Pre-rotation keys are fallback-only migration.
	const players =
		poolA || poolB
			? [...(poolA ?? []), ...(poolB ?? [])]
			: (playerLegacy ?? legacyArr.filter((c) => c.placement === "feed"));
	return [...clubs, ...players];
}

/** Filter the social snapshot to the requested teams + the allowed placements
 *  (Home wants "home", Feed wants "feed"). */
export function socialFor(
	cards: unknown[],
	teams: string[],
	placements: Set<string>,
	extraPlayers: Set<string> = new Set(),
): unknown[] {
	if (teams.length === 0 && extraPlayers.size === 0) return [];
	const wanted = new Set(teams);
	return (
		cards as Array<{ teamAbbreviation?: string; placement?: string; handle?: string; sourceType?: string }>
	).filter((c) => {
		if (!c.placement || !placements.has(c.placement)) return false;
		// A followed-team card…
		if (c.teamAbbreviation && wanted.has(c.teamAbbreviation)) return true;
		// …or a player the user follows across team lines (card `handle` is "@<ig>",
		// matched against the followed player-id set, Phase 3).
		if (extraPlayers.size > 0 && c.sourceType === "player" && c.handle) {
			return extraPlayers.has(c.handle.replace(/^@/, "").toLowerCase());
		}
		return false;
	});
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
	// sv2→sv3 (2026-08-16): player-centric international rule — bump orphans week-old verdicts
	// judged under the old "USWNT-only" policy so the new rule applies immediately.
	const vkey = (id: string) => `sv3-${id}`;

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
		const playerMap = featuredPlayerMapBlock(await loadPlayerSocial(env));
		for (let i = 0; i < uncached.length; i += HAIKU_BATCH) {
			const batch = uncached.slice(i, i + HAIKU_BATCH);
			let out: SocialVerdict[] | null;
			try {
				out = await haikuClassifySocialBatch(batch, env.ANTHROPIC_API_KEY, playerMap);
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
async function haikuClassifySocialBatch(cards: FeedCard[], apiKey: string, playerMap: string): Promise<SocialVerdict[]> {
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
					content: `${SOCIAL_POLICY}\n\n${playerMap}\n\nClassify each post. Echo its id exactly.\n\n${list}`,
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
	//    versioned (`nv3-`) so a policy/schema change rolls by bumping the version rather
	//    than waiting out every cached verdict's TTL. (nv1→nv2: dropped the USWNT/NT
	//    allowance. nv2→nv3, 2026-08-16: that exclusion is REVERSED into the unified
	//    player-centric international rule — an NWSL player as primary subject matches.)
	const vkey = (id: string) => `nv3-${id}`;
	const cached = await Promise.all(cards.map((c) => env.FEED_TAGS.get(vkey(c.id), "json")));
	const uncached: NewsCard[] = [];
	cards.forEach((c, i) => {
		const v = cached[i] as NewsVerdict | null;
		if (v) verdicts.set(c.id, v);
		else uncached.push(c);
	});

	// 2. Tag the misses via Haiku, batched. No key → skip (everything fails open).
	if (uncached.length > 0 && env.ANTHROPIC_API_KEY) {
		const playerMap = featuredPlayerMapBlock(await loadPlayerSocial(env));
		for (let i = 0; i < uncached.length; i += HAIKU_BATCH) {
			const batch = uncached.slice(i, i + HAIKU_BATCH);
			let out: NewsVerdict[] | null;
			try {
				out = await haikuTagNewsBatch(batch, env.ANTHROPIC_API_KEY, playerMap);
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
async function haikuTagNewsBatch(cards: NewsCard[], apiKey: string, playerMap: string): Promise<NewsVerdict[]> {
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
					content: `${NEWS_POLICY}\n\n${playerMap}\n\nTag each article. Echo its id exactly.\n\n${list}`,
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
const TRIVIA_BRIDGE_TTL = 300; // 5m — a BRIDGE slice (no grouped pool yet) is transitional; short-cache it so a
// publish becomes visible within minutes instead of being masked by a stale bridge entry for the full 6h.
const TRIVIA_POOL_KEY = "trivia-pool-v1"; // KV key for the owner-loaded question pool

/** NWSL Trivia's question serving. Two shapes for a clean rollout:
 *   • `GET /trivia?round=<editionKey>` (current app) — returns THAT round's pre-grouped 10 questions from the
 *     v2 doc (routine-generated, no in-year repeats). Missing/future rounds WRAP to the stored season (a
 *     missed annual refresh degrades to cross-year repeats, never empty) + emit a throttled stale diag.
 *   • `GET /trivia` with NO round (legacy app builds) — the flat v1 pool the app slices client-side; kept so
 *     builds in the wild keep working. Retire after the min-build gate clears. */
async function handleTrivia(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const round = url.searchParams.get("round");
	if (!round) return handleTriviaLegacyFlat(url, env, ctx);

	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.search = "";
	cacheUrl.searchParams.set("cv", "3"); // v2 = the round-grouped doc; bump to abandon stale edge entries
	cacheUrl.searchParams.set("round", round);
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let doc: TriviaPoolDoc | null = null;
	try {
		doc = (await env.FEED_TAGS.get(TRIVIA_POOL_V2_KEY, "json")) as TriviaPoolDoc | null;
	} catch {
		return (await serveStale(cache, cacheKey)) ?? upstreamError();
	}

	const resolved = resolveRound(doc, round);
	let questions: TriviaQuestion[];
	let isBridge = false;
	if (resolved) {
		questions = resolved.questions;
		if (resolved.wrapped && doc) {
			// The requested round isn't in the stored season → a missed annual refresh; we serve a prior year
			// (cross-year repeat, acceptable) but say so LOUDLY server-side, throttled 1/day (KHG stale pattern).
			ctx.waitUntil((async () => {
				const THROTTLE_KEY = "trivia:stale-diag-at";
				const last = Number(await env.FEED_TAGS.get(THROTTLE_KEY)) || 0;
				if (Date.now() - last > 24 * 3600 * 1000) {
					await env.FEED_TAGS.put(THROTTLE_KEY, String(Date.now()), { expirationTtl: 7 * 24 * 3600 });
					emitDiag(env, ctx, "triviaStaleServe", `requested ${round}, wrapped to stored season ${doc.season} — annual refresh missed`);
				}
			})());
		}
	} else {
		// BRIDGE (no v2 doc published yet — the Phase-1→Phase-2 content gap): serve a deterministic round
		// sliced from the legacy flat pool so a round-aware build isn't empty. Falls away the moment the
		// grouped v2 doc lands.
		isBridge = true;
		const parsed = parseEditionKey(round);
		const flat = ((await env.FEED_TAGS.get(TRIVIA_POOL_KEY, "json")) as TriviaQuestion[] | null) ?? [];
		questions = parsed ? sliceFlatPool(flat, parsed.round, DEFAULT_GROUP_CONFIG.perRound) : [];
	}

	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	// Never long-cache an empty round (pre-load / never-published) — the app shows an honest error and
	// re-checks each launch. A real GROUPED round is frozen for the season → full 6h TTL. A BRIDGE slice is
	// transitional → short TTL so the first publish (or an annual re-group) isn't masked by a stale bridge.
	const ttl = questions.length === 0 ? 0 : isBridge ? TRIVIA_BRIDGE_TTL : TRIVIA_TTL;
	headers.set("Cache-Control", ttl > 0 ? `public, max-age=${ttl}` : "no-store");
	const body = new Response(JSON.stringify(questions), { status: 200, headers });
	if (ttl > 0) ctx.waitUntil(cache.put(cacheKey, body.clone()));
	return withCacheStatus(body, "MISS");
}

/** LEGACY flat pool (no `round` param): the owner-loaded `[TriviaQuestion]` array straight from KV. Kept for
 *  old app builds that slice client-side; safe to serve `[]` before the pool exists. */
async function handleTriviaLegacyFlat(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
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
	// Staleness telemetry (BIWEEKLY-automation watchdog): a KHG edition is live for 2 ISO weeks, so a
	// pool stamped the current OR the immediately-previous ISO week is healthy. Only a pool ≥2 weeks
	// behind means a biweekly generation run was missed — the app keeps serving the old players
	// (deliberate graceful degradation), but that must be LOUD server-side. Throttled to one diag/day.
	const currentWeek = isoWeekKey();
	const prevWeek = isoWeekKey(new Date(Date.now() - 7 * 86_400_000));
	if (pool && pool.weekKey !== currentWeek && pool.weekKey !== prevWeek) {
		const month = new Date().getUTCMonth() + 1;
		if (month >= 3 && month <= 11) {
			ctx.waitUntil((async () => {
				const THROTTLE_KEY = "knowher:stale-diag-at";
				const last = Number(await env.FEED_TAGS.get(THROTTLE_KEY)) || 0;
				if (Date.now() - last > 24 * 3600 * 1000) {
					await env.FEED_TAGS.put(THROTTLE_KEY, String(Date.now()), { expirationTtl: 7 * 24 * 3600 });
					emitDiag(env, ctx, "knowherStaleWeek", `serving ${pool.weekKey}, current ${currentWeek} (biweekly: prev ${prevWeek} also ok)`);
				}
			})());
		}
	}
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

/** `POST /knowher/ingest` — the automated weekly publish (the scheduled Claude routine's target).
 *  Auth = the dedicated `x-ingest-key` (KNOWHER_INGEST_KEY secret; unset → always 401, same
 *  fail-closed rule as adminAuthed). Body = the generated pool JSON, either raw or wrapped as
 *  `{ pool }` (the generator emits the raw document; the wrapper matches the admin op's shape).
 *  Delegates to the ONE publish path (validate → KV → markFeatured). Diags: every accept AND
 *  every rejection — the weekly pipeline has no human watching the POST. */
async function handleKnowHerIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed. Use POST.", { status: 405, headers: { Allow: "POST" } });
	}
	const key = (env as unknown as KnowHerEnv).KNOWHER_INGEST_KEY;
	if (!key || request.headers.get("x-ingest-key") !== key) {
		emitDiag(env, ctx, "knowherIngestAuth", key ? "bad x-ingest-key" : "KNOWHER_INGEST_KEY unset");
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401, headers: { "Content-Type": "application/json" },
		});
	}
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		emitDiag(env, ctx, "knowherIngestReject", "body is not JSON");
		return new Response(JSON.stringify({ error: "body must be JSON" }), {
			status: 400, headers: { "Content-Type": "application/json" },
		});
	}
	// requireSource: the ingest path is now the VERIFIER's publish — it only ever posts a gate-passed pool,
	// and every human question must carry the `source` the verifier re-confirmed it from.
	const result = await publishKnowHerPool(env as unknown as KnowHerEnv, body.pool ?? body, { requireSource: true });
	if ("error" in result) {
		emitDiag(env, ctx, "knowherIngestReject", result.error.slice(0, 70));
		return new Response(JSON.stringify(result), { status: 400, headers: { "Content-Type": "application/json" } });
	}
	emitDiag(env, ctx, "knowherIngestOk", `${result.weekKey} players=${result.playerCount}`);
	return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** `POST /knowher/candidate` — the GENERATOR routine stages its pool here (auth: the weaker
 *  x-candidate-key). Validates shape + club-completeness + per-fact source, but does NOT go live and does
 *  NOT touch the featured ledger. `GET /knowher/candidate` — the VERIFIER routine reads it back (auth: the
 *  stronger x-ingest-key, since only the verifier should see/act on it). This is the split that stops the
 *  generator from being judge of its own work: it can stage, only the verifier can publish. */
async function handleKnowHerCandidate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const kenv = env as unknown as KnowHerEnv;
	const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
	if (request.method === "GET") {
		// Verifier read — gated by the publish key (only the verifier reads candidates).
		const key = kenv.KNOWHER_INGEST_KEY;
		if (!key || request.headers.get("x-ingest-key") !== key) {
			emitDiag(env, ctx, "knowherCandidateAuth", key ? "bad x-ingest-key (GET)" : "KNOWHER_INGEST_KEY unset");
			return json({ error: "unauthorized" }, 401);
		}
		const cand = await readKnowHerCandidate(kenv);
		if (!cand) return json({ error: "no candidate staged" }, 404);
		return json(cand);
	}
	if (request.method === "POST") {
		// Generator stage — gated by the WEAKER candidate key (can stage, never publish).
		const key = kenv.KNOWHER_CANDIDATE_KEY_SECRET;
		if (!key || request.headers.get("x-candidate-key") !== key) {
			emitDiag(env, ctx, "knowherCandidateAuth", key ? "bad x-candidate-key" : "KNOWHER_CANDIDATE_KEY_SECRET unset");
			return json({ error: "unauthorized" }, 401);
		}
		let body: Record<string, unknown>;
		try { body = (await request.json()) as Record<string, unknown>; }
		catch { emitDiag(env, ctx, "knowherCandidateReject", "body is not JSON"); return json({ error: "body must be JSON" }, 400); }
		const result = await stageKnowHerCandidate(kenv, body.pool ?? body);
		if ("error" in result) {
			emitDiag(env, ctx, "knowherCandidateReject", result.error.slice(0, 70));
			return json(result, 400);
		}
		emitDiag(env, ctx, "knowherCandidateStaged", `${result.weekKey} players=${result.playerCount} human=${result.humanQuestions}`);
		return json({ ...result, note: "Staged for the verify gate — NOT live. The verifier re-confirms each fact, then publishes." });
	}
	return new Response("Method not allowed. Use GET (verifier) or POST (generator).", { status: 405, headers: { Allow: "GET, POST" } });
}

/** `POST /trivia/ingest` — the VERIFIER routine (or the owner, supervised) publishes the yearly Trivia pool.
 *  Auth = x-ingest-key (TRIVIA_INGEST_KEY; unset → 401). Body = the flat verified `[TriviaQuestion]` (or
 *  `{ questions }`). `?season=YYYY` (required) is the season to group for; `?dryRun=1` groups+validates
 *  without writing; `?force=1` overrides the "don't rewrite an already-published season" guard. Delegates to
 *  the ONE publish path (validate → group → KV). Diags every accept AND rejection (no human watches the POST). */
async function handleTriviaIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") return new Response("Method not allowed. Use POST.", { status: 405, headers: { Allow: "POST" } });
	const tenv = env as unknown as TriviaEnv;
	const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
	const key = tenv.TRIVIA_INGEST_KEY;
	if (!key || request.headers.get("x-ingest-key") !== key) {
		emitDiag(env, ctx, "triviaIngestAuth", key ? "bad x-ingest-key" : "TRIVIA_INGEST_KEY unset");
		return json({ error: "unauthorized" }, 401);
	}
	const url = new URL(request.url);
	const season = parseInt(url.searchParams.get("season") ?? "", 10);
	if (!Number.isInteger(season)) return json({ error: "missing/invalid ?season=YYYY" }, 400);
	const dryRun = url.searchParams.get("dryRun") === "1";
	const force = url.searchParams.get("force") === "1";
	let body: unknown;
	try { body = await request.json(); }
	catch { emitDiag(env, ctx, "triviaIngestReject", "body is not JSON"); return json({ error: "body must be JSON" }, 400); }
	const result = await publishTriviaPool(tenv, body, { season, dryRun, force });
	if ("error" in result) {
		// Group-infeasibility is the loud, pageable failure (the pool couldn't satisfy the round constraints);
		// everything else is a plain reject.
		const kind = /infeasible|^round \d+/.test(result.error) ? "triviaGroupInfeasible" : "triviaIngestReject";
		emitDiag(env, ctx, kind, result.error.slice(0, 90));
		return json(result, 400);
	}
	emitDiag(env, ctx, "triviaIngestOk", `season ${result.season} ${result.roundCount}×${result.perRound} lib=${result.library}${result.dryRun ? " (dryRun)" : ""}`);
	return json(result);
}

/** `POST /trivia/candidate` — the GENERATOR routine stages a category-BATCH (auth: weak x-candidate-key),
 *  MERGED into the accumulating yearly library. `GET /trivia/candidate` — the VERIFIER reads the whole staged
 *  library back (auth: strong x-ingest-key). Same generator-can't-judge-itself split as KHG; staging is never
 *  live. */
async function handleTriviaCandidate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const tenv = env as unknown as TriviaEnv;
	const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
	if (request.method === "GET") {
		const key = tenv.TRIVIA_INGEST_KEY;
		if (!key || request.headers.get("x-ingest-key") !== key) {
			emitDiag(env, ctx, "triviaCandidateAuth", key ? "bad x-ingest-key (GET)" : "TRIVIA_INGEST_KEY unset");
			return json({ error: "unauthorized" }, 401);
		}
		const cand = await readTriviaCandidate(tenv);
		if (!cand) return json({ error: "no candidate staged" }, 404);
		return json(cand);
	}
	if (request.method === "POST") {
		const key = tenv.TRIVIA_CANDIDATE_KEY;
		if (!key || request.headers.get("x-candidate-key") !== key) {
			emitDiag(env, ctx, "triviaCandidateAuth", key ? "bad x-candidate-key" : "TRIVIA_CANDIDATE_KEY unset");
			return json({ error: "unauthorized" }, 401);
		}
		let body: unknown;
		try { body = await request.json(); }
		catch { emitDiag(env, ctx, "triviaCandidateReject", "body is not JSON"); return json({ error: "body must be JSON" }, 400); }
		const result = await stageTriviaCandidate(tenv, body);
		if ("error" in result) { emitDiag(env, ctx, "triviaCandidateReject", result.error.slice(0, 90)); return json(result, 400); }
		emitDiag(env, ctx, "triviaCandidateStaged", `+${result.added} → ${result.total} staged`);
		return json({ ...result, note: "Staged into the yearly library — NOT live. The verifier re-confirms, then publishes." });
	}
	return new Response("Method not allowed. Use GET (verifier) or POST (generator).", { status: 405, headers: { Allow: "GET, POST" } });
}

/** `POST /knowher/candidate/verified` — the VERIFIER stages its cleaned, HUMAN-ONLY pool here (auth: the
 *  publish key, since only the verifier reaches this). This is NOT live: the Monday publish-verified pass
 *  injects fresh stats + Lever 1 and publishes. A short-of-5-human player is rejected (400) so the hold
 *  surfaces at the verifier, on the weekend, when the owner can still hand-fix. (2026-08-12 split.) */
async function handleKnowHerVerifiedCandidate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed. Use POST.", { status: 405, headers: { Allow: "POST" } });
	}
	const kenv = env as unknown as KnowHerEnv;
	const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
	const key = kenv.KNOWHER_INGEST_KEY;
	if (!key || request.headers.get("x-ingest-key") !== key) {
		emitDiag(env, ctx, "knowherVerifiedAuth", key ? "bad x-ingest-key" : "KNOWHER_INGEST_KEY unset");
		return json({ error: "unauthorized" }, 401);
	}
	let body: Record<string, unknown>;
	try { body = (await request.json()) as Record<string, unknown>; }
	catch { emitDiag(env, ctx, "knowherVerifiedReject", "body is not JSON"); return json({ error: "body must be JSON" }, 400); }
	const result = await stageVerifiedCandidate(kenv, body.pool ?? body);
	if ("error" in result) {
		emitDiag(env, ctx, "knowherVerifiedReject", result.error.slice(0, 70));
		return json(result, 400);
	}
	emitDiag(env, ctx, "knowherVerifiedStaged", `${result.weekKey} players=${result.playerCount}`);
	return json({ ...result, note: "Verified human-only pool staged — NOT live. Monday's publish-verified pass injects fresh stats + publishes." });
}

/** `POST /knowher/publish-verified` — the MONDAY half of the split (2026-08-12). The watcher's Monday
 *  10:00-UTC pass calls this (via the service binding, holding the publish key); the owner also curls it for
 *  the supervised first run. Reads the weekend-verified pool, injects FRESH ESPN stats (so Sunday-night
 *  games count) + Lever 1, and publishes. Every outcome diags: an unattended 3am publish must be loud. */
async function handleKnowHerPublishVerified(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed. Use POST.", { status: 405, headers: { Allow: "POST" } });
	}
	const kenv = env as unknown as KnowHerEnv;
	const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
	const key = kenv.KNOWHER_INGEST_KEY;
	if (!key || request.headers.get("x-ingest-key") !== key) {
		emitDiag(env, ctx, "knowherPublishVerifiedAuth", key ? "bad x-ingest-key" : "KNOWHER_INGEST_KEY unset");
		return json({ error: "unauthorized" }, 401);
	}
	// ?dryRun=1 — the supervised first run: assemble + validate the Monday pool but write NOTHING live.
	const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
	let result;
	try {
		result = await publishVerifiedPool(kenv, { dryRun });
	} catch (e) {
		// A thrown error here (e.g. ESPN unreachable for the stat fetch) means we could NOT build the pool —
		// so nothing publishes and the last edition stays live. Loud, never a silent non-publish.
		const msg = `${(e as Error).message ?? e}`;
		emitDiag(env, ctx, "knowherPublishVerifiedError", msg.slice(0, 70));
		return json({ error: msg }, 500);
	}
	if ("error" in result) {
		// A held run (a player below the floor even with stat top-up, or no candidate staged) — report every
		// held player + reason so the owner sees exactly what fell short.
		emitDiag(env, ctx, "knowherPublishVerifiedHeld", `${result.error.slice(0, 60)}${result.held ? ` [${result.held.length}]` : ""}`);
		return json(result, result.held ? 409 : 404);
	}
	if (result.lever1.length > 0) {
		// Lever 1 fired for ≥1 player — loud but not fatal (the run still published on time). Names them so
		// the owner can improve those players' human facts next cycle.
		emitDiag(env, ctx, "knowherLever1", result.lever1.map((f) => `${f.team}:${f.human}h+${f.stat}s`).join(" "));
	}
	emitDiag(env, ctx, "knowherPublishVerifiedOk", `${result.dryRun ? "DRYRUN " : ""}${result.weekKey} players=${result.playerCount} lever1=${result.lever1.length}`);
	return json(result);
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
	let featuredCount = 0;
	try {
		const featured = await readFeaturedIds(env as unknown as KnowHerEnv, year);
		featuredCount = featured.size;
		players = await computeEligiblePlayers(env as unknown as KnowHerEnv, team, year, featured);
	} catch {
		return upstreamError();
	}
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", `public, max-age=${KNOWHER_ELIGIBLE_TTL}`);
	const body = new Response(JSON.stringify({ team, year, count: players.length, featuredThisSeason: featuredCount, players }), { status: 200, headers });
	if (players.length > 0) {
		// Note: no ctx here (admin/debug endpoint) — cache synchronously via the returned clone.
		await cache.put(cacheKey, body.clone());
	}
	return withCacheStatus(body, "MISS");
}

/** `GET /team-stats?team={id}` — every rostered athlete of a club with their FULL flattened season stats
 *  (`"category.statName" → value`, the exact shape the app's PlayerSeasonStats.all consumes), in ONE
 *  edge-cached call. Replaces the app's old ~27-per-athlete device→ESPN burst on every team-page open
 *  (docs/stress-testing.md §6). Reuses `fetchTeamSeasonStats` (resilient roster + batched stat fetch,
 *  ~29 subrequests, under the free 50/invocation cap). On any failure the app falls back to its own
 *  per-athlete fetch, so a proxy miss DEGRADES (per-device fan-out), never blanks. */
async function handleTeamStats(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const id = (url.searchParams.get("team") ?? "").replace(/[^0-9]/g, "");
	if (!id) return new Response("missing ?team", { status: 400 });
	const year = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
	const cache = caches.default;
	const cacheKey = new Request(url.toString(), { method: "GET" });
	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let players: Awaited<ReturnType<typeof fetchTeamSeasonStats>>;
	try {
		players = await fetchTeamSeasonStats(env as unknown as BracketEnv, id, year);
	} catch (e) {
		emitDiag(env, ctx, "teamStatsError", `${id}: ${(e as Error).message.slice(0, 50)}`);
		return upstreamError();
	}
	if (players.length === 0) {
		// No roster resolved (bad id, or an ESPN roster outage with no last-known-good). Don't cache an
		// empty — return an error so the app falls back to its per-athlete path. Loud (no silent empty).
		emitDiag(env, ctx, "teamStatsEmpty", `${id}: 0 players`);
		return upstreamError();
	}
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", `public, max-age=${TEAM_STATS_TTL}`);
	const body = new Response(JSON.stringify({ team: id, year, players }), { status: 200, headers });
	ctx.waitUntil(cache.put(cacheKey, body.clone()));
	return withCacheStatus(body, "MISS");
}

/** `GET /knowher/todo?team=WAS` — the weekly generation feed (docs §5b): THIS week's featured pick for one
 *  team, WITH verified ESPN stats attached, so the (later-automated) Claude routine never fetches stats —
 *  only fun facts. Per-team by design: one team ≈ 28 ESPN subrequests (safe under the free 50/invocation
 *  cap); the routine loops 16 quick calls. Excludes already-featured players (once-per-season ledger); a
 *  null player in-season is a loud diag (nobody left to feature = a real signal, not a silent empty). */
async function handleKnowHerTodo(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const team = (url.searchParams.get("team") ?? "").toUpperCase();
	if (!team) return new Response(`Missing ?team=`, { status: 400 });
	const year = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
	const cache = caches.default;
	const cacheKey = new Request(url.toString(), { method: "GET" });
	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let player;
	try {
		const featured = await readFeaturedIds(env as unknown as KnowHerEnv, year);
		const eligible = await computeEligiblePlayers(env as unknown as KnowHerEnv, team, year, featured);
		player = pickWeeklyFeatured(eligible);
	} catch (e) {
		// NO SILENT FAILURES: a bare upstreamError() here mislabeled a UA/403 bug in fetchTeamAbbrs as
		// "ESPN down" for two days and sent the KHG cloud routine chasing a non-existent ESPN outage.
		// Record the REAL error so the next incident is diagnosable from the sdiag: KV, not guessed.
		emitDiag(env, ctx, "knowherTodoError", `team=${team}: ${e instanceof Error ? e.message : String(e)}`);
		return upstreamError();
	}
	// No one left to feature. In-season (Mar–Nov) that's worth a loud signal; offseason it's expected.
	if (!player) {
		const month = new Date().getUTCMonth() + 1;
		if (month >= 3 && month <= 11) emitDiag(env, ctx, "knowherTodoEmpty", `team=${team} season=${year}`);
	}
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", `public, max-age=${KNOWHER_ELIGIBLE_TTL}`);
	const body = new Response(JSON.stringify({ team, year, season: year, player }), { status: 200, headers });
	if (player) ctx.waitUntil(cache.put(cacheKey, body.clone()));
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
	// Confederation championships + WC/Olympic qualifying — close the blind spot so a followed NT's
	// COMPETITIVE fixtures (not just friendlies) surface in the schedule + fire alerts.
	"uefa.w.nations", "fifa.wworldq.uefa", "afc.w.asian.cup", "caf.w.nations",
	"conmebol.america.femenina", "fifa.wwcq.ply", "fifa.w.concacaf.olympicsq", "global.pinatar_cup",
	"global.w.finalissima",
];
const NATIONAL_TEAMS_TTL = 24 * 3600;

const NATIONAL_TEAMS_CV = "4"; // bump to drop the stale edge-cached directory after a feed change (4: +finalissima)
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
					{ headers: { "User-Agent": ESPN_UA } },
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
/** Per-IP throttle for the two UNAUTHENTICATED ingest endpoints (/telemetry, /analytics) via the
 *  native rate-limit binding (free, no KV cost). Returns true when the caller is OVER the limit and
 *  should be 429'd. Keyed per bucket+IP so the two endpoints keep independent budgets. Fails OPEN if
 *  the binding is absent (e.g. not yet deployed) — a config gap must never drop legit telemetry. */
async function overIngestLimit(request: Request, env: Env, bucket: string): Promise<boolean> {
	const limiter = env.INGEST_LIMITER;
	if (!limiter) return false; // binding not configured → fail open (never block legit clients)
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	const { success } = await limiter.limit({ key: `${bucket}:${ip}` });
	return !success;
}

async function handleTelemetryIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") return new Response("POST only", { status: 405 });
	// Anonymous endpoint + one KV write per POST → cap per-IP so a flood can't exhaust the
	// account-wide KV daily write budget (pre-launch security pass).
	if (await overIngestLimit(request, env, "telemetry")) return new Response(null, { status: 429 });
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

// The whitelisted anonymous counter names — anything else is dropped, so a buggy or hostile
// client can never grow the table with junk event names. Keep in sync with the app's
// Analytics.Event mapping (NWSLApp/Services/Analytics.swift).
const ANALYTICS_EVENTS = new Set([
	"session_start",
	"session_os",
	"tab_opened",
	"fanzone_game_opened",
	"feed_item_tapped",
	"feed_chip_tapped",
	// Phase 3 reporter discovery (2026-08-17): param "TEAM|handle" — which club FANBASE added
	// which Bluesky handle, never which fan (anonymous Level-3 law). The reporter-audit
	// endpoint aggregates these into addSignals; threshold judgment lives in the routine.
	"reporter_added",
	"reporter_add_session", // denominator: sessions that added ANY reporter
	// Engagement counters (2026-08-22): all coarse buckets, self-deduped per window on-device, no identity.
	"active_week",       // param new/returning — once per ISO week per device → sum = WAU
	"days_active_week",  // param 1/2/3to4/5to7 — prior week's distinct-day count
	"session_length",    // param lt1m/1to5m/5to15m/15to30m/gt30m — this launch's foreground length
]);

/** Anonymous Level-3 usage counters: `POST /analytics` with a pre-summed per-session batch
 *  `{ events: [{ event, param?, n }] }` → one atomic Supabase RPC (`increment_counters`,
 *  SECURITY DEFINER, service_role-only) that ADDS each count into the daily rollup table
 *  `analytics_counters` (app repo: supabase/migration_analytics_counters.sql). Mirrors
 *  /telemetry's privacy posture exactly: NO identifiers, NO client IP, every field whitelisted +
 *  capped; what's stored is only (day, event, param, count) — App Store "Usage Data, not linked
 *  to identity". Best-effort: the app always gets a 204 (a dropped batch is a dropped count,
 *  never a user-facing failure); an RPC failure emits a proxy diag so a persistent gap surfaces
 *  in /telemetry/recent instead of silently zeroing the dashboard. */
async function handleAnalyticsIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") return new Response("POST only", { status: 405 });
	if (await overIngestLimit(request, env, "analytics")) return new Response(null, { status: 429 });
	let body: { events?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return new Response("bad json", { status: 400 });
	}
	const raw = Array.isArray(body.events) ? body.events.slice(0, 64) : [];
	const events = raw
		.map((e) => {
			const ev = e as { event?: unknown; param?: unknown; n?: unknown };
			const n = typeof ev.n === "number" && Number.isFinite(ev.n) ? Math.floor(ev.n) : 0;
			const event = String(ev.event ?? "");
			// reporter_added carries "TEAM|handle" — bsky handles alone run past 32 ("GFC|" +
			// girlssoccernetwork.bsky.social = 34), so this event gets 64; everything else keeps 32.
			return {
				event,
				param: String(ev.param ?? "").slice(0, event === "reporter_added" ? 64 : 32),
				n: Math.min(Math.max(n, 0), 10_000),
			};
		})
		.filter((e) => ANALYTICS_EVENTS.has(e.event) && e.n > 0);
	if (events.length === 0) return new Response(null, { status: 204 });

	const sb = env as unknown as { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };
	if (!sb.SUPABASE_URL || !sb.SUPABASE_SERVICE_ROLE_KEY) {
		// Unconfigured environment (e.g. local dev without .dev.vars) → quiet no-op, not a 5xx.
		return new Response(null, { status: 204 });
	}
	const base = sb.SUPABASE_URL.replace(/\/$/, "");
	const key = sb.SUPABASE_SERVICE_ROLE_KEY;
	ctx.waitUntil(
		(async () => {
			try {
				const r = await fetch(`${base}/rest/v1/rpc/increment_counters`, {
					method: "POST",
					headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body: JSON.stringify({ p_events: events }),
				});
				if (!r.ok) emitDiag(env, ctx, "analyticsRpcFail", `increment_counters ${r.status}`);
			} catch (err) {
				emitDiag(env, ctx, "analyticsRpcFail", String(err).slice(0, 80));
			}
		})(),
	);
	return new Response(null, { status: 204 });
}

// ── Error-spike email alerting (2026-07-16) ──────────────────────────────────────────────────
// Every telemetry channel is PULL (in-app Diagnostics, /telemetry/recent, dashboards) — nobody
// watches a dashboard mid-incident; the 2026-07-15 exceededCpu burst surfaced a day late. This is
// the PUSH half: the 5-min cron scans the recent `diag:` records and emails the owner (Resend)
// when error-class events spike. Alert volume scales with INCIDENTS, not users → flat $0.
// Unconfigured (no RESEND_API_KEY / ALERT_EMAIL secret) → silent no-op.

/** Error-CLASS kinds only — traces and success breadcrumbs must never page the owner. */
const ALERT_ERROR_KINDS = new Set([
	"apiFailure", "parseError", "unexpectedEmpty", "staleServe",
	"analyticsRpcFail", "metricKitDiagnostic", "tier2SignedOutDesync",
	// Roster integrity. `rosterContinuityRefused` = a plausibly-sized ESPN payload that shares
	// almost no players with the trusted copy (contamination-class). `knowherTodoEmpty` fired for
	// real at 2026-W31 when ESPN briefly returned an empty Orlando roster and the edition shipped
	// 15 teams — it was diagnosable only after the fact because nothing paged on it.
	"rosterContinuityRefused", "knowherTodoEmpty",
	// Nightly verification. A gate failure is one event per failing club-gate, all in ONE batched
	// record — so a single club blip stays under ALERT_THRESHOLD and is report-only, while a
	// contamination or a deleted club fails many gates at once and pages. Severity scales with
	// blast radius for free. Per-player diffs (positions, erasures) deliberately do NOT page.
	"rosterTruthGateFail", "rosterTruthRunFail",
	// Trivia content pipeline (roadmap #2). `triviaGroupInfeasible` = an ingest whose pool couldn't satisfy
	// the round constraints (a bad generation) → the prior season stays live. `triviaStaleServe` = the app
	// requested a round past the published season (a missed annual refresh); throttled 1/day, so it's really
	// report-only visibility — health_check_trivia.mjs is the true "wrong-season pool" gate.
	"triviaGroupInfeasible", "triviaStaleServe",
]);
const ALERT_WINDOW_MS = 15 * 60 * 1000;
const ALERT_THRESHOLD = 8; // error events in the window ⇒ email (2-user baseline is ~0-2/day; a real incident bursts)
const ALERT_THROTTLE_MS = 60 * 60 * 1000; // at most 1 email/hour — an incident can't flood the inbox
const ALERT_SENT_KEY = "alert:last-email";

/** The write-time of a reverse-time `diag:` key (see handleTelemetryIngest) — lets the spike scan
 *  filter by age from the KEY alone, so a quiet tick costs one KV list and ZERO record reads. */
function diagKeyTime(name: string): number {
	const inv = Number(name.split(":")[1]);
	return Number.isFinite(inv) ? 1e15 - inv : 0;
}

async function checkErrorSpike(env: Env, ctx: ExecutionContext): Promise<void> {
	const cfg = env as unknown as { RESEND_API_KEY?: string; ALERT_EMAIL?: string };
	if (!cfg.RESEND_API_KEY || !cfg.ALERT_EMAIL) return; // not set up yet → no-op
	// Config sanity (NO SILENT FAILURES): a common setup slip is pasting the API key into
	// ALERT_EMAIL (→ Resend 422 "invalid to field"). Catch a non-email value here and surface it
	// as a clear diag instead of a cryptic per-incident 422 — and never leak the value.
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.ALERT_EMAIL.trim())) {
		emitDiag(env, ctx, "alertEmailMisconfig", "ALERT_EMAIL is not an email address — check the secret");
		return;
	}
	const last = await env.FEED_TAGS.get(ALERT_SENT_KEY);
	if (last && Date.now() - Number(last) < ALERT_THROTTLE_MS) return;

	const cutoff = Date.now() - ALERT_WINDOW_MS;
	// Scan ONLY server-origin diagnostics (`sdiag:`), never the shared client `diag:` stream — otherwise a
	// fleet-scale /telemetry flood fills the newest-60 window and buries the very server errors this pager
	// exists to catch (per-IP rate-limiting can't cap a real multi-IP fleet). 60 is ample for server-only.
	const list = await env.FEED_TAGS.list({ prefix: "sdiag:", limit: 60 }); // reverse-time → newest first
	const recent = list.keys.filter((k) => diagKeyTime(k.name) >= cutoff);
	if (recent.length === 0) return;

	let count = 0;
	const samples: string[] = [];
	for (const k of recent) {
		const raw = await env.FEED_TAGS.get(k.name);
		if (!raw) continue;
		let rec: { app?: string; origin?: string; events?: { kind?: string; detail?: string }[] };
		try {
			rec = JSON.parse(raw) as typeof rec;
		} catch {
			continue;
		}
		// Only PROXY-emitted diagnostics page the owner. Client POST /telemetry is unauthenticated and
		// spoofable, and never carries the server-set `origin`, so counting it would let anyone trip the
		// alert email. Client telemetry still lands in KV + the /telemetry/recent pull view — just no page.
		if (rec.origin !== "server") continue;
		for (const e of rec.events ?? []) {
			if (!e.kind || !ALERT_ERROR_KINDS.has(e.kind)) continue;
			// Expected third-party image flakiness (Instagram CDN URLs expire/rotate, YouTube & club
			// thumbnails 404/hotlink-block) is an honest placeholder fallback, NOT an incident — but it
			// rides `apiFailure`, so a batch of it could trip the spike alone and cry wolf. Exclude it
			// from the PAGING count only; it stays in telemetry + the in-app Diagnostics screen.
			if (e.kind === "apiFailure" && (e.detail ?? "").startsWith("image fetch ")) continue;
			count++;
			if (samples.length < 6) samples.push(`${rec.app ?? "?"}: ${e.kind} — ${e.detail ?? ""}`);
		}
	}
	if (count < ALERT_THRESHOLD) return;

	// Mark BEFORE sending (a Resend hiccup shouldn't re-fire every 5 min for the same incident).
	await env.FEED_TAGS.put(ALERT_SENT_KEY, String(Date.now()), { expirationTtl: 24 * 3600 });
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			from: "NWSL App Alerts <onboarding@resend.dev>",
			to: [cfg.ALERT_EMAIL.trim()],
			subject: `NWSLApp: ${count} error events in the last 15 min`,
			text:
				`Telemetry error spike (threshold ${ALERT_THRESHOLD} in ${ALERT_WINDOW_MS / 60000} min).\n\n` +
				`Recent samples:\n${samples.map((s) => `  • ${s}`).join("\n")}\n\n` +
				`Where to look: GET /telemetry/recent (x-admin-key) · the in-app Diagnostics screen · ` +
				`the Cloudflare dashboards (proxy + watcher).\n` +
				`Throttled to at most one email per hour.`,
		}),
	});
	if (res.ok) {
		console.log(`[alert] error-spike email sent (${count} events)`);
	} else {
		// Capture Resend's reason, not just the code — a bare status is useless mid-incident.
		console.log(`[alert] resend send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
	}
}

/** Owner view of recent telemetry: `GET /telemetry/recent` (newest first), gated by the same
 *  `x-admin-key`/`BRACKET_ADMIN_KEY` secret as the other admin routes. */
async function handleTelemetryRecent(request: Request, env: Env): Promise<Response> {
	const key = (env as unknown as { BRACKET_ADMIN_KEY?: string }).BRACKET_ADMIN_KEY;
	if (!key || request.headers.get("x-admin-key") !== key) {
		return new Response("forbidden", { status: 403 });
	}
	// Merge BOTH streams newest-first: server diagnostics (`sdiag:`) + client telemetry (`diag:`). They
	// live under separate prefixes so the pager can scan server errors without client burial; the owner
	// view still shows everything. (`diag:` prefix does NOT match `sdiag:` — no double-count.)
	const [server, client] = await Promise.all([
		env.FEED_TAGS.list({ prefix: "sdiag:", limit: 100 }),
		env.FEED_TAGS.list({ prefix: "diag:", limit: 100 }),
	]);
	const names = [...server.keys, ...client.keys]
		.sort((a, b) => diagKeyTime(b.name) - diagKeyTime(a.name)) // newest first
		.slice(0, 100)
		.map((k) => k.name);
	const records = await Promise.all(names.map((n) => env.FEED_TAGS.get(n)));
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
// ROSTER_GOOD_MIN is imported from bracket-engine.ts — one definition, so this route and the
// engine's resilient fetch can never disagree about what counts as an implausible squad.
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

/** Minimum share of the CACHED squad that must still appear in a new live payload before that
 *  payload is allowed to replace the last-known-good copy. Measured 2026-07-30 across all 16
 *  clubs: normal ESPN↔ESPN week-to-week churn keeps ≥90% of names, while a wholesale
 *  contamination (another league's/sport's players, the failure that hit a sibling provider's
 *  Bay FC entry) scores ~0%. 50% sits in the empty middle of that gap — far below real churn,
 *  far above any substitution event. */
export const ROSTER_CONTINUITY_MIN = 0.5;

/** Normalized athlete display names from an ESPN roster body. Uses the headshot module's
 *  `normalizeName` so accent/punctuation drift between two fetches ("Sveindís" vs "Sveindis")
 *  can never masquerade as squad churn. */
export function rosterNames(body: unknown): string[] {
	const athletes = (body as { athletes?: { displayName?: string }[] })?.athletes;
	if (!Array.isArray(athletes)) return [];
	return athletes
		.map((a) => normalizeName(a?.displayName ?? ""))
		.filter((n) => n.length > 0);
}

/** Pure decision: may a plausibly-sized live payload REPLACE the last-known-good cache?
 *
 *  This exists because the size floor alone can't tell a real squad from a well-formed wrong
 *  one. A contaminated roster of ~25 players passes `ROSTER_GOOD_MIN`, so before this guard the
 *  very first request would overwrite the good copy with garbage — the fallback destroying
 *  itself at exactly the moment it's needed. Continuity asks the question size can't: are these
 *  still broadly the same people?
 *
 *  Note this gates the WRITE only. The live payload is still served (honestly) either way —
 *  refusing to serve on a heuristic would risk hiding a real roster. */
export function rosterCacheRefreshDecision(
	liveBody: unknown,
	cachedBody: unknown | null,
): { refresh: boolean; overlap: number } {
	const cached = rosterNames(cachedBody);
	// Nothing to compare against (first fetch, expired cache) → accept and bootstrap.
	if (cached.length === 0) return { refresh: true, overlap: 1 };
	const live = new Set(rosterNames(liveBody));
	const kept = cached.filter((n) => live.has(n)).length;
	const overlap = kept / cached.length;
	return { refresh: overlap >= ROSTER_CONTINUITY_MIN, overlap };
}

/** Pure serve/refresh plan for the GOOD path (live payload ≥ ROSTER_GOOD_MIN) — tweak 2,
 *  owner-approved 2026-07-31. Two signals can demote a plausibly-SIZED payload:
 *
 *  - `continuityOk=false` — the live payload shares <50% of its players with the trusted copy.
 *    This is the real-time contamination shield: before this, a wrong-humans roster was refused
 *    the CACHE but still SERVED (paged, yet on screen). Now users keep the trusted copy.
 *  - `verdictOk=false` — the nightly ESPN×NWSL verification failed this club (contamination the
 *    50% bar can't see, keeper-count disagreement, …). Held on last-known-good until it passes;
 *    up to ~24h stale for THAT club only, which the owner accepted over serving wrong data.
 *
 *  Fail-open by construction: no cache to fall back on, or no/expired verdict ⇒ exactly the old
 *  behavior. The cache is never refreshed from a payload either signal distrusts. */
export function goodPathPlan(opts: {
	continuityOk: boolean;
	verdictOk: boolean;
	hasCached: boolean;
}): { serve: "live" | "cached"; refreshCache: boolean } {
	const { continuityOk, verdictOk, hasCached } = opts;
	if (hasCached && (!continuityOk || !verdictOk)) return { serve: "cached", refreshCache: false };
	// No cached copy: live is all there is — serve it, but only ARCHIVE it if nothing distrusts it
	// (seeding the fallback with suspect data would poison the very net we fall back on).
	return { serve: "live", refreshCache: continuityOk && verdictOk };
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
			headers: { "User-Agent": ESPN_UA, Accept: "application/json" },
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

	// Read the last-known-good once, up front: step 2 needs it to decide whether the live
	// payload may REPLACE it, and step 3 needs it as the fallback body.
	let cached: RosterCacheRecord | null = null;
	try {
		cached = (await env.FEED_TAGS.get(kvKey, "json")) as RosterCacheRecord | null;
	} catch {
		/* KV read failure → treat as no cache (fails open: step 2 bootstraps, step 3 serves live) */
	}

	// Owner rulings outrank both feeds. Applied to whatever we end up serving (live OR cached), and
	// applied AFTER the cache write below, so the stored last-known-good stays raw ESPN — an override
	// is a presentation-time correction, never something baked into the archive.
	let overrides: OverrideMap = {};
	try {
		overrides = await readOverrides(env);
	} catch {
		/* fail open: no overrides is exactly today's behaviour */
	}
	const serve = (body: unknown, asOf: string | null): Response => {
		const { body: patched, applied } = applyOverrides(body, overrides, Date.now());
		if (applied.length > 0) {
			emitDiag(env, ctx, "rosterOverrideApplied", `${id} n=${applied.length} ${applied.slice(0, 3).join(",")}`);
		}
		return rosterResponse(patched, asOf);
	};

	// 2. Plausible squad → decide what to SERVE and whether the payload may become the new
	//    last-known-good. Two distrust signals (see goodPathPlan): the real-time continuity check,
	//    and the nightly ESPN×NWSL verification verdict. Either one holds users on the trusted
	//    cached copy (honest marker) instead of showing suspect data.
	if (liveCount >= ROSTER_GOOD_MIN) {
		const { refresh: continuityOk, overlap } = rosterCacheRefreshDecision(live, cached?.body ?? null);

		let verdictOk = true;
		try {
			const verdicts = await readVerdicts(env);
			const v = verdicts?.clubs?.[id];
			if (v && !v.ok) verdictOk = false;
		} catch {
			/* fail open — no verdict is not a verdict against */
		}

		const plan = goodPathPlan({ continuityOk, verdictOk, hasCached: cached != null });
		if (!continuityOk) {
			// Loud: contamination-class, not routine churn. If the CACHED copy is ever the bad one,
			// it self-expires at ROSTER_CACHE_TTL — or delete the key (see docs/backend.md).
			emitDiag(env, ctx, "rosterContinuityRefused", `${id} overlap=${Math.round(overlap * 100)}% live=${liveCount}`);
		} else if (!verdictOk && plan.serve === "cached") {
			// Quiet-ish: the nightly gate failure already paged; this just records each hold.
			emitDiag(env, ctx, "rosterVerdictHold", `${id} live=${liveCount} held on cached`);
		}
		if (plan.refreshCache) {
			const record: RosterCacheRecord = { fetchedAt: new Date().toISOString(), body: live };
			ctx.waitUntil(env.FEED_TAGS.put(kvKey, JSON.stringify(record), { expirationTtl: ROSTER_CACHE_TTL }));
		}
		if (plan.serve === "cached" && cached) return serve(cached.body, cached.fetchedAt);
		return serve(live, null);
	}

	// 3. Implausibly small (or upstream failed) → fall back to last-known-good if it's fuller.
	const cachedCount = cached ? athleteCount(cached.body) : -1;
	const decision = chooseRosterServe({
		hasLive: live != null,
		liveCount,
		hasCached: cached != null,
		cachedCount,
	});
	if (decision === "cached" && cached) {
		emitDiag(env, ctx, "rosterStaleServe", `${id} live=${liveCount} cached=${cachedCount}`);
		return serve(cached.body, cached.fetchedAt);
	}
	if (decision === "live-small") {
		// Nothing better than the live (small) payload — serve it honestly (diag flags it).
		emitDiag(env, ctx, "rosterImplausibleNoCache", `${id} live=${liveCount}`);
		return serve(live, null);
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
		headers: { "User-Agent": ESPN_UA, Accept: "application/json" },
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
	const r = await fetch(`${ESPN_SUMMARY}?event=${eventId}`, { headers: { "User-Agent": ESPN_UA, Accept: "application/json" } });
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
			headers: { "User-Agent": ESPN_UA, Accept: "application/json" },
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
		const r = await fetch(`${ESPN_CORE}/athletes/${id}`, { headers: { "User-Agent": ESPN_UA, Accept: "application/json" } });
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
