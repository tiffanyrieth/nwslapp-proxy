// ESPN SHARED FETCHER (Option A, owner-approved 2026-10-08) — ONE copy of each ESPN pass-through
// response for EVERY Cloudflare data center.
//
// Why: the proxy's edge cache (`caches.default`) is PER DATA CENTER, so each colo serving the app kept
// its own copy and re-downloaded from ESPN when it expired — ~1/hour per colo for the static schedule
// and ~every 30s per colo during live windows. That scales with colo count (~15–20 at launch) on
// Cloudflare's SHARED egress addresses, against the owner's hourly-max policy for unofficial sources
// (docs/decisions.md 2026-10-08) and the good-indie-neighbour stance. This singleton Durable Object sits
// behind every colo's edge MISS: ESPN now sees ~one request per cache period in TOTAL.
//
// Contract (do not drift):
//   • Freshness is decided by the SAME TTL choosers the edge has always used (chooseScoreboardTTL /
//     chooseSummaryTTL, imported — never copied). The edge then caches only for the time the shared copy
//     has LEFT (edgeTtlFor), so live data is never older than the 30s live TTL — same as before.
//   • A failure is NEVER cached: a non-OK ESPN answer goes back to the edge, whose recovery ladder runs
//     exactly as before. Any problem reaching this object → the edge falls back to its direct ESPN path.
//   • The match watcher NEVER comes through here (the edge bypasses host `proxy` and `_lc` requests) —
//     its forced-fresh live polls are a sanctioned, device-proven exception and stay byte-for-byte.
//   • ESPN circuit breaker + kill switch stay at the edge (they gate BEFORE this object is called).
//
// Storage: L1 in-memory map (no size cap per value) + L2 SQLite row so a restart doesn't cost a re-fetch.
// Bodies are stored GZIPPED — mandatory, not an optimization: the NWSL full-season body is 2.62 MB raw
// (measured 2026-10-08, 240 events), OVER DO storage's 2 MB per-value cap; gzip makes it 0.188 MB (14×).
// A compressed body over FETCHER_MAX_STORED_GZIP stays memory-only (diag `espnFetcherOversize`).

import { DurableObject } from "cloudflare:workers";
import { ESPN_UA } from "./espn-ua.ts";
import { chooseScoreboardTTL, chooseSummaryTTL, TEAM_STATS_TTL, KNOWHER_ELIGIBLE_TTL } from "./index.ts";
import { fetchTeamSeasonStats, type BracketEnv } from "./bracket-engine.ts";
import { computeEligiblePlayers, readFeaturedIds, type KnowHerEnv } from "./knowher.ts";

export type FetcherKind = "scoreboard" | "summary";
export type FetcherSource = "fresh" | "memory" | "stored";

export interface FetcherResult {
	ok: boolean;
	status: number;
	body?: ArrayBuffer;
	contentType?: string;
	/** ms epoch the shared copy was fetched from ESPN. */
	fetchedAt: number;
	/** The shared copy's TTL (seconds), from the edge's own TTL choosers. */
	ttlSec: number;
	source: FetcherSource;
	/** True only for the ONE caller whose request actually reached ESPN (feeds the edge breaker once). */
	calledUpstream: boolean;
	/** The busted fetch failed but the un-busted retry recovered (edge emits `espnRetryRecovered`). */
	retryRecovered?: string;
	/** On failure: ESPN's rejection signals, so the edge's `espnUpstreamBody` diag is unchanged. */
	failInfo?: { server: string; retryAfter: string; cfRay: string; snippet: string };
	/** Diagnostics for the edge to emit (this object can't reach the diag spine without a circular call). */
	notes: { kind: string; detail: string }[];
}

/** A SHARED COMPUTED result (phase 2, 2026-10-08): a per-team aggregate built from ~29 ESPN calls, computed
 *  ONCE here for every data center instead of once per data center per hour. `json` is the producer's
 *  serialized output; `ok:false` carries the producer's error (never cached). */
export interface SharedJsonResult {
	ok: boolean;
	json?: string;
	fetchedAt: number;
	ttlSec: number;
	source: FetcherSource;
	error?: string;
	notes: { kind: string; detail: string }[];
}

/** A producer's answer: the JSON to return, and whether it may be shared (an empty roster isn't). */
type Produced = { json: string; cache: boolean };

/** Compressed bodies above this stay in memory only (DO storage caps a value at 2 MB). */
export const FETCHER_MAX_STORED_GZIP = 1_500_000;
/** In-memory budget across entries (DO isolate memory is 128 MB); least-recently-used evicted first. */
export const FETCHER_MEMORY_BUDGET = 48_000_000;
/** Stored rows older than this are pruned (settled summaries carry 1-year TTLs; no need to keep them). */
export const FETCHER_ROW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The shared-copy key: the ESPN URL minus the per-fetch `_cb` buster, params sorted. `w` (the app's
 *  lineup-window bucket — edge-key-only, never sent to ESPN) is folded in so entering the 2h pre-kickoff
 *  window still forces a fresh copy instead of reusing one fetched hours earlier. */
export function fetcherKey(upstreamUrl: string, windowBucket?: string | null): string {
	const u = new URL(upstreamUrl);
	u.searchParams.delete("_cb");
	u.searchParams.sort();
	return windowBucket ? `${u.toString()}#w=${windowBucket}` : u.toString();
}

export function isFresh(fetchedAt: number, ttlSec: number, now: number): boolean {
	return now - fetchedAt < ttlSec * 1000;
}

/** Edge TTL for a copy served by the fetcher: never longer than what the edge would choose, and never
 *  longer than the shared copy has left — so an edge copy can't outlive it (live stays ≤30s). Min 1s. */
export function edgeTtlFor(edgeTtl: number, fetchedAt: number, fetcherTtlSec: number, now: number): number {
	const left = Math.floor((fetchedAt + fetcherTtlSec * 1000 - now) / 1000);
	return Math.max(1, Math.min(edgeTtl, left));
}

export async function gzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
	return new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

export async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
	return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

type Entry = { body: ArrayBuffer; contentType: string; fetchedAt: number; ttlSec: number };

export class EspnFetcher extends DurableObject<Env> {
	private mem = new Map<string, Entry>();
	private memBytes = 0;
	private inflight = new Map<string, Promise<FetcherResult>>();
	private computing = new Map<string, Promise<SharedJsonResult>>();
	private writes = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, ttl_sec INTEGER NOT NULL, content_type TEXT, body BLOB NOT NULL)",
		);
	}

	/** One ESPN pass-through read, shared by every data center. `bust` mirrors the edge's bustUpstream. */
	async fetchShared(upstreamUrl: string, kind: FetcherKind, bust: boolean, windowBucket?: string | null): Promise<FetcherResult> {
		const key = fetcherKey(upstreamUrl, windowBucket);
		const now = Date.now();

		const m = this.mem.get(key);
		if (m && isFresh(m.fetchedAt, m.ttlSec, now)) {
			this.touch(key, m);
			return this.hit(m, "memory");
		}
		if (!m) {
			const stored = await this.readStored(key);
			if (stored && isFresh(stored.fetchedAt, stored.ttlSec, now)) {
				this.remember(key, stored);
				return this.hit(stored, "stored");
			}
		}

		// Coalesce: simultaneous misses for the same key share ONE ESPN call. Joiners must not feed the
		// edge breaker a second time, and read the copy the leader just stored.
		const pending = this.inflight.get(key);
		if (pending) {
			const r = await pending;
			return { ...r, calledUpstream: false, source: r.ok ? "memory" : r.source, notes: [] };
		}
		const p = this.fetchUpstream(key, upstreamUrl, kind, bust).finally(() => this.inflight.delete(key));
		this.inflight.set(key, p);
		return p;
	}

	/** `/team-stats`: one club's rostered athletes with full flattened season stats (`fetchTeamSeasonStats`,
	 *  ~29 ESPN calls). Shared for TEAM_STATS_TTL. An empty roster is returned but never shared (the edge
	 *  turns it into the same error + diag as before, so the app falls back to its own path). */
	async teamStats(teamId: string, year: number): Promise<SharedJsonResult> {
		return this.computeShared(`team-stats:${teamId}:${year}`, TEAM_STATS_TTL, async () => {
			const players = await fetchTeamSeasonStats(this.env as unknown as BracketEnv, teamId, year);
			return { json: JSON.stringify(players), cache: players.length > 0 };
		});
	}

	/** `/knowher/eligible` AND `/knowher/todo`: one team's eligible players (`computeEligiblePlayers`, ~29
	 *  ESPN calls) with this season's already-featured players excluded — one copy now serves BOTH routes
	 *  (they each re-fetched before). Shared for KNOWHER_ELIGIBLE_TTL, the same window the edge cached it. */
	async knowherEligible(team: string, year: number): Promise<SharedJsonResult> {
		return this.computeShared(`knowher-eligible:${team}:${year}`, KNOWHER_ELIGIBLE_TTL, async () => {
			const env = this.env as unknown as KnowHerEnv;
			const featured = await readFeaturedIds(env, year);
			const players = await computeEligiblePlayers(env, team, year, featured);
			return { json: JSON.stringify({ players, featuredCount: featured.size }), cache: players.length > 0 };
		});
	}

	/** Compute-once-share-everywhere for a JSON aggregate: same memory → storage → coalesced-producer path
	 *  as fetchShared. A producer error is returned (never cached); a non-shareable answer is returned once. */
	private async computeShared(key: string, ttlSec: number, produce: () => Promise<Produced>): Promise<SharedJsonResult> {
		const now = Date.now();
		const asJson = (e: Entry, source: FetcherSource): SharedJsonResult => ({
			ok: true, json: new TextDecoder().decode(e.body), fetchedAt: e.fetchedAt, ttlSec: e.ttlSec, source, notes: [],
		});
		const m = this.mem.get(key);
		if (m && isFresh(m.fetchedAt, m.ttlSec, now)) {
			this.touch(key, m);
			return asJson(m, "memory");
		}
		if (!m) {
			const stored = await this.readStored(key);
			if (stored && isFresh(stored.fetchedAt, stored.ttlSec, now)) {
				this.remember(key, stored);
				return asJson(stored, "stored");
			}
		}
		const pending = this.computing.get(key);
		if (pending) {
			const r = await pending;
			return { ...r, source: r.ok ? "memory" : r.source, notes: [] };
		}
		const p = (async (): Promise<SharedJsonResult> => {
			let out: Produced;
			try {
				out = await produce();
			} catch (e) {
				return { ok: false, fetchedAt: Date.now(), ttlSec: 0, source: "fresh", error: String((e as Error)?.message ?? e).slice(0, 160), notes: [] };
			}
			const entry: Entry = {
				body: new TextEncoder().encode(out.json).buffer as ArrayBuffer,
				contentType: "application/json",
				fetchedAt: Date.now(),
				ttlSec,
			};
			const notes: SharedJsonResult["notes"] = [];
			if (out.cache) {
				this.remember(key, entry);
				const oversize = await this.persist(key, entry);
				if (oversize) notes.push({ kind: "espnFetcherOversize", detail: `${key} gzip=${oversize}B (memory only)` });
			}
			return { ...asJson(entry, "fresh"), ttlSec: out.cache ? ttlSec : 0, notes };
		})().finally(() => this.computing.delete(key));
		this.computing.set(key, p);
		return p;
	}

	private hit(e: Entry, source: FetcherSource): FetcherResult {
		return {
			ok: true, status: 200, body: e.body, contentType: e.contentType,
			fetchedAt: e.fetchedAt, ttlSec: e.ttlSec, source, calledUpstream: false, notes: [],
		};
	}

	private async fetchUpstream(key: string, upstreamUrl: string, kind: FetcherKind, bust: boolean): Promise<FetcherResult> {
		// Identical to the edge's former fetchUpstream: `_cb` forces ESPN to recompute instead of serving
		// its own stale copy; on failure, ONE un-busted retry (recovery-ladder step 1).
		const go = (b: boolean): Promise<Response> => {
			const u = new URL(upstreamUrl);
			if (b) u.searchParams.set("_cb", String(Date.now()));
			return fetch(u.toString(), { headers: { "User-Agent": ESPN_UA, Accept: "application/json" } });
		};
		let res: Response | null = null;
		try {
			res = await go(bust);
		} catch {
			res = null;
		}
		let retryRecovered: string | undefined;
		if (!res?.ok && bust) {
			const firstFail = res ? String(res.status) : "threw";
			try {
				const retry = await go(false);
				if (retry.ok) {
					res = retry;
					retryRecovered = firstFail;
				}
			} catch {
				/* the edge ladder takes it from here */
			}
		}

		if (!res?.ok) {
			let failInfo: FetcherResult["failInfo"];
			if (res) {
				const h = (k: string) => res!.headers.get(k) ?? "";
				let snippet = "";
				try {
					snippet = (await res.text()).slice(0, 160).replace(/\s+/g, " ").trim();
				} catch {
					/* best-effort */
				}
				failInfo = { server: h("server"), retryAfter: h("retry-after"), cfRay: h("cf-ray"), snippet };
			}
			return { ok: false, status: res?.status ?? 0, fetchedAt: Date.now(), ttlSec: 0, source: "fresh", calledUpstream: true, failInfo, notes: [] };
		}

		const body = await res.arrayBuffer();
		const contentType = res.headers.get("Content-Type") ?? "application/json";
		const ttlSec = kind === "summary" ? chooseSummaryTTL(body) : chooseScoreboardTTL(body);
		const entry: Entry = { body, contentType, fetchedAt: Date.now(), ttlSec };
		this.remember(key, entry);
		const notes: FetcherResult["notes"] = [];
		// Persist BEFORE returning so a note about an oversize body reaches the edge with this result.
		const oversize = await this.persist(key, entry);
		if (oversize) notes.push({ kind: "espnFetcherOversize", detail: `${key.slice(0, 90)} gzip=${oversize}B (memory only)` });
		return { ...this.hit(entry, "fresh"), calledUpstream: true, retryRecovered, notes };
	}

	private remember(key: string, e: Entry): void {
		const prev = this.mem.get(key);
		if (prev) this.memBytes -= prev.body.byteLength;
		this.mem.delete(key);
		this.mem.set(key, e); // Map order = recency (oldest first)
		this.memBytes += e.body.byteLength;
		for (const [k, v] of this.mem) {
			if (this.memBytes <= FETCHER_MEMORY_BUDGET || k === key) break;
			this.mem.delete(k);
			this.memBytes -= v.body.byteLength;
		}
	}

	private touch(key: string, e: Entry): void {
		this.mem.delete(key);
		this.mem.set(key, e);
	}

	private async readStored(key: string): Promise<Entry | null> {
		try {
			const row = this.ctx.storage.sql
				.exec<{ fetched_at: number; ttl_sec: number; content_type: string | null; body: ArrayBuffer }>(
					"SELECT fetched_at, ttl_sec, content_type, body FROM entries WHERE key = ?", key)
				.toArray()[0];
			if (!row) return null;
			return {
				body: await gunzip(row.body),
				contentType: row.content_type ?? "application/json",
				fetchedAt: row.fetched_at,
				ttlSec: row.ttl_sec,
			};
		} catch {
			return null; // a bad row is just a miss — the next fetch overwrites it
		}
	}

	/** Store the gzipped body. Returns the compressed size when it was too big to store (memory-only). */
	private async persist(key: string, e: Entry): Promise<number | null> {
		try {
			const gz = await gzip(e.body);
			if (gz.byteLength > FETCHER_MAX_STORED_GZIP) return gz.byteLength;
			this.ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO entries (key, fetched_at, ttl_sec, content_type, body) VALUES (?, ?, ?, ?, ?)",
				key, e.fetchedAt, e.ttlSec, e.contentType, gz);
			if (++this.writes % 50 === 0) {
				this.ctx.storage.sql.exec("DELETE FROM entries WHERE fetched_at < ?", Date.now() - FETCHER_ROW_MAX_AGE_MS);
			}
		} catch {
			/* storage is the L2 convenience — memory still serves; never fail the read on it */
		}
		return null;
	}
}
