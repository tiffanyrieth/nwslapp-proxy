// Watcher batch summaries (2026-10-13). Pure helpers for `GET /watch/summaries` — the watcher's ONE call per
// poll for every ESPN /summary it needs (live goal cross-checks + pre-kickoff lineup checks).
//
// WHY: Worker→Worker service-binding calls COUNT toward the Free plan's 50 subrequests per invocation
// (live-tested 2026-10-13: call 51 throws, also inside a Durable Object). The watcher used to spend one binding
// call per match per poll, × 2 polls per run — ~38 of its 50 at a 17-match FIFA-window peak. This route lets it
// spend ONE; the fan-out runs here, in the proxy's own invocation, each entry through SELF to the normal
// /summary route (cache, breaker, shared fetcher, last-good ladder, attendance enrich all unchanged). ESPN sees
// exactly the same requests as before.
//
// CPU: the envelope is built from raw bytes, never JSON.parse'd (an NT summary is ~275 KB and the free plan
// allows ~10 ms CPU per invocation). The watcher parses it — it runs in a Durable Object with a far larger budget.

/** Max entries per batch: one SELF subrequest each, plus headroom for a diag write, under the 50 cap. */
export const WATCH_SUMMARIES_MAX = 40;

/** The service-binding host the watcher calls (`https://proxy/...`). Public traffic always arrives on the
 *  workers.dev hostname, so this host check keeps the route internal — a public caller can't use it as a
 *  40× ESPN amplifier. */
export const WATCH_INTERNAL_HOST = "proxy";

export interface WatchSummaryEntry {
	id: string;
	league: string;
	/** Cache-bust this entry (`_lc`), exactly as the watcher's old per-match fetch did. */
	bust: boolean;
	/** League not on the allowlist → never fetched, answered status 400 (exactly what /summary itself would
	 *  say), so one bad entry can't sink the rest of the batch. */
	unknownLeague: boolean;
}

/** Parse `e=<event>:<league>[:1],…`. Only a missing/empty/oversized list rejects the whole request. A malformed
 *  entry (non-numeric id, bad flag, bad shape) is SKIPPED and reported in `skipped` — the watcher reads a missing
 *  id as "no summary", exactly like a failed per-match fetch — so one bad entry (e.g. a fake-match id) can never
 *  cost the real matches in the same batch their summaries. An unknown league is answered per entry (see
 *  `unknownLeague`). */
export function parseWatchSummaryEntries(
	raw: string | null,
	allowedLeagues: ReadonlySet<string>,
): { entries: WatchSummaryEntry[]; skipped: string[] } | { error: string } {
	if (!raw) return { error: "missing e=" };
	const parts = raw.split(",").filter((p) => p.length > 0);
	if (parts.length === 0) return { error: "empty e=" };
	if (parts.length > WATCH_SUMMARIES_MAX) return { error: `too many entries (${parts.length} > ${WATCH_SUMMARIES_MAX})` };
	const entries: WatchSummaryEntry[] = [];
	const skipped: string[] = [];
	const seen = new Set<string>();
	for (const p of parts) {
		const [id, league, flag, ...rest] = p.split(":");
		if (rest.length > 0 || !id || !/^\d{1,12}$/.test(id) || !league || (flag !== undefined && flag !== "1")) {
			skipped.push(p.slice(0, 40));
			continue;
		}
		if (seen.has(id)) continue; // a duplicate id is harmless — serve it once
		seen.add(id);
		entries.push({ id, league, bust: flag === "1", unknownLeague: !allowedLeagues.has(league) });
	}
	return { entries, skipped };
}

/** The exact /summary URL the watcher used to fetch for this entry (same param order, same NWSL default with
 *  no `league`, same `_lc` cache-bust) — so the proxy cache keys and recovery ladder behave identically. */
export function summaryUrlFor(e: WatchSummaryEntry, now: number): string {
	const leagueParam = e.league === "usa.nwsl" ? "" : `&league=${encodeURIComponent(e.league)}`;
	const lc = e.bust ? `&_lc=${now}` : "";
	return `https://${WATCH_INTERNAL_HOST}/summary?event=${e.id}${leagueParam}${lc}`;
}

const isWs = (b: number): boolean => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

/** Cheap structural check (no parse): first/last non-whitespace bytes are `{` / `}`. Catches an HTML error
 *  page or an empty body; a body that passes is inlined raw into the envelope. */
export function looksLikeJsonObject(bytes: Uint8Array): boolean {
	let i = 0;
	let j = bytes.length - 1;
	while (i <= j && isWs(bytes[i])) i++;
	while (j >= i && isWs(bytes[j])) j--;
	return i < j && bytes[i] === 0x7b && bytes[j] === 0x7d;
}

export interface WatchSummaryResult {
	id: string;
	/** Upstream HTTP status from /summary; 0 = the SELF call threw. */
	status: number;
	body: Uint8Array | null;
}

/** `[{"id":"…","status":200,"body":<raw summary>},{"id":"…","status":404},…]` built by byte concatenation.
 *  An entry whose body is missing, non-200 or fails `looksLikeJsonObject` is emitted status-only (a 200 with
 *  a bad body is reported as status 502 so the watcher treats it as a failed fetch). Ids are digits-only
 *  (validated on parse), so they need no JSON escaping. */
export function buildWatchSummariesEnvelope(results: readonly WatchSummaryResult[]): Uint8Array {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [enc.encode("[")];
	results.forEach((r, i) => {
		const ok = r.status === 200 && r.body !== null && looksLikeJsonObject(r.body);
		const status = ok ? 200 : r.status === 200 ? 502 : r.status;
		chunks.push(enc.encode(`${i > 0 ? "," : ""}{"id":"${r.id}","status":${status}${ok ? ',"body":' : "}"}`));
		if (ok) {
			chunks.push(r.body as Uint8Array);
			chunks.push(enc.encode("}"));
		}
	});
	chunks.push(enc.encode("]"));
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}
