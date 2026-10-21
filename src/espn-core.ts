// ESPN CORE FETCH CHAIN (2026-10-21) — every request to ESPN's Core service (`sports.core.api.espn.com`:
// per-athlete season stats, the event stream behind heat maps) goes through here.
//
// WHY: since ~2026-10-17 Core answers 403 to EVERY Cloudflare Worker (our UA and a browser UA alike), while the
// identical request is 200 from a home IP and from Deno Deploy. ESPN's player-stats data is refused across hosts
// (the `site.web` athlete overview too), while the site API (scores, schedule, /summary, live) still accepts
// Cloudflare. So Core leaves from a small relay on another network (repo `nwslapp-espn-relay`, Deno Deploy).
//
// ORDER (owner rule 2026-10-20: every feature names a second source):
//   1. relay — when ESPN_RELAY_URL + ESPN_RELAY_KEY are set
//   2. Cloudflare direct — in case ESPN lifts the block, or the relay host is down / refused
//   3. (callers) the saved copies: the NWSL league-feed stats copy, or an honest "heat unavailable"
// The callers keep deciding WHEN to fetch (after matches only, one canary first, back off on refusal); this file
// only decides WHERE a request leaves from. Planned later: a home Raspberry Pi as link 1 (docs/backend.md).

import { ESPN_HEADERS } from "./espn-ua.ts";

export interface CoreRelayEnv {
	ESPN_RELAY_URL?: string;
	ESPN_RELAY_KEY?: string;
}

export type CoreLink = "relay" | "direct";

export interface CoreFetchResult {
	res: Response;
	/** Which link produced `res`. */
	link: CoreLink;
	/** Set when the relay was tried and did not give a usable ESPN answer (why), so callers can log it. */
	relayFailure?: string;
}

const RELAY_TIMEOUT_MS = 20_000;

/** An ESPN answer worth keeping: success, or 404 (ESPN's "no stats for this player"). Anything else — a refusal,
 *  a rate limit, a 5xx, or a relay-side error — moves on to the next link. */
const usable = (status: number) => (status >= 200 && status < 300) || status === 404;

export async function coreFetch(env: CoreRelayEnv | undefined, url: string): Promise<CoreFetchResult> {
	let relayFailure: string | undefined;
	const relay = env?.ESPN_RELAY_URL?.trim();
	const key = env?.ESPN_RELAY_KEY?.trim();
	if (relay && key) {
		try {
			const r = await fetch(`${relay.replace(/\/+$/, "")}/?url=${encodeURIComponent(url)}`, {
				headers: { "x-relay-key": key },
				signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
			});
			if (usable(r.status)) return { res: r, link: "relay" };
			// `x-relay-upstream` = ESPN's own status as the relay saw it; absent = the relay itself refused/failed.
			const upstream = r.headers.get("x-relay-upstream");
			relayFailure = upstream && /^\d+$/.test(upstream) ? `ESPN ${upstream} via relay` : `relay HTTP ${r.status}`;
			await r.body?.cancel();
		} catch (e) {
			relayFailure = `relay ${String((e as Error)?.name === "TimeoutError" ? "timeout" : (e as Error)?.message ?? e).slice(0, 60)}`;
		}
	}
	const res = await fetch(url, { headers: ESPN_HEADERS });
	return { res, link: "direct", relayFailure };
}
