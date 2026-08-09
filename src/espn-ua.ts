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
