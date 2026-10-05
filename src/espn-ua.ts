// ⚠️ ESPN bot rule (observed 2026-08-04): ESPN's API endpoints return 403 to requests with NO
// User-Agent OR a browser-style UA, while accepting honest HTTP-client UAs. Cloudflare Workers
// attach no UA to fetch() sub-requests unless you set one — so EVERY ESPN fetch, in EVERY module,
// must send this header. `okhttp/4.9.0` (a real Android HTTP-client UA) returned 200 in testing
// where empty/browser/CFNetwork-spoof UAs got 403. If ESPN later blocks this too, rotate it HERE.
//
// This lives in its own module (not index.ts) because the 2026-08-04 fix swept only index.ts and
// MISSED the ESPN fetches in roster-truth.ts / bracket-engine.ts / headshots.ts — the nightly
// roster verification then failed for two days ("club count 0 (ESPN) vs 16"). A single import
// point means a new module can't quietly roll its own UA-less ESPN fetch helper.
export const ESPN_UA = "okhttp/4.9.0";

/** The standard headers for any ESPN JSON fetch. */
export const ESPN_HEADERS: Record<string, string> = { "User-Agent": ESPN_UA, Accept: "application/json" };

// Every OTHER unauthenticated third-party fetch (NWSL SDP API, Open-Meteo, …) sends this honest,
// identifying UA. Workers attach NO User-Agent by default, and a UA-less request is the classic
// bot signal publishers block or rate-limit first (the ESPN lesson above). Authenticated APIs
// (Supabase, Anthropic, Apify, Resend, Apple) don't need it. Article/RSS scrapes deliberately use
// index.ts BROWSER_UA instead (they need the full SSR'd page, not a stripped bot page).
export const PROXY_UA = "nwslapp-proxy/0.3 (+https://nwslapp-proxy.tiffany-rieth.workers.dev)";
