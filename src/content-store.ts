// CONTENT STORE (owner ruling 2026-10-08, docs/decisions.md "KV writes are reserved for live matches") —
// the home for NON-LIVE content state: the Social snapshots, the Haiku verdict caches, link previews and the
// Home club-news cache.
//
// Why not KV: KV writes are capped at 1,000/day ACCOUNT-WIDE and shared with the match watcher's live state
// (`MATCH_STATE`). A breach fails every KV write for the rest of the UTC day — live pushes, the V2 Live Activity
// and in-app live scores stop. Content bookkeeping was 200–425 of those writes/day with only a few testers
// (owner, Cloudflare KV Metrics, 2026-10-09). This SQLite-backed Durable Object has its own free budget
// (100k rows written/day), so content can never starve a live match.
//
// Contract:
//   • KV semantics (string values, optional TTL) so call sites change minimally: `getMany` / `putMany` /
//     `writtenAt`. Callers go through index.ts `contentGet` / `contentPut` — never a stub directly.
//   • A write NEVER falls back to KV (that would re-open the exact risk this exists to close). If this object
//     is unreachable the caller emits a diag and the refresh reports failure; readers fall back to a KV READ.
//   • Values over CONTENT_GZIP_MIN are stored gzipped (snapshots compress ~10×); small ones (a verdict, a
//     preview) are stored raw — gzip would make them bigger.
//   • Expired rows are pruned in bounded batches during writes, so no alarm is needed.
import { DurableObject } from "cloudflare:workers";
import { gzip, gunzip } from "./espn-fetcher.ts";

export interface ContentPut {
	key: string;
	value: string;
	/** Seconds until the row expires; omit for no expiry. */
	ttlSec?: number;
}

/** Values at least this long (chars) are gzipped. */
export const CONTENT_GZIP_MIN = 1024;
/** DO storage caps one value at 2 MB; refuse (and report) anything larger after compression. */
export const CONTENT_MAX_STORED_BYTES = 1_900_000;
/** In-memory copy budget (DO isolate memory is 128 MB); least-recently-used evicted first. */
export const CONTENT_MEMORY_BUDGET = 32_000_000;
/** SQLite caps bound parameters per statement at 100 in Durable Objects. */
const SQL_PARAM_CHUNK = 90;
/** At most one prune pass per this interval, deleting at most PRUNE_BATCH expired rows. */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const PRUNE_BATCH = 500;

type MemEntry = { value: string; expiresAt: number; writtenAt: number };

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ContentStore extends DurableObject<Env> {
	private mem = new Map<string, MemEntry>();
	private memBytes = 0;
	private lastPrune = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, gz INTEGER NOT NULL, expires_at INTEGER NOT NULL, written_at INTEGER NOT NULL)",
		);
	}

	/** Values for these keys (null = missing or expired). */
	async getMany(keys: string[]): Promise<Record<string, string | null>> {
		const now = Date.now();
		const out: Record<string, string | null> = {};
		const missing: string[] = [];
		for (const key of new Set(keys)) {
			const m = this.mem.get(key);
			if (m && !expired(m.expiresAt, now)) {
				this.touch(key, m);
				out[key] = m.value;
			} else {
				missing.push(key);
			}
		}
		for (const chunk of chunks(missing, SQL_PARAM_CHUNK)) {
			const rows = this.ctx.storage.sql
				.exec<{ key: string; value: ArrayBuffer; gz: number; expires_at: number; written_at: number }>(
					`SELECT key, value, gz, expires_at, written_at FROM kv WHERE key IN (${chunk.map(() => "?").join(",")})`,
					...chunk,
				)
				.toArray();
			for (const r of rows) {
				if (expired(r.expires_at, now)) continue;
				const value = r.gz ? dec.decode(await gunzip(r.value)) : dec.decode(r.value);
				out[r.key] = value;
				this.remember(r.key, { value, expiresAt: r.expires_at, writtenAt: r.written_at });
			}
		}
		for (const key of keys) if (!(key in out)) out[key] = null;
		return out;
	}

	/** When each key was last written (ms epoch; null = missing/expired). Cheap: no value crosses the wire,
	 *  so a "is this snapshot due?" check doesn't ship a whole snapshot to the caller. */
	async writtenAt(keys: string[]): Promise<Record<string, number | null>> {
		const now = Date.now();
		const out: Record<string, number | null> = {};
		const missing: string[] = [];
		for (const key of new Set(keys)) {
			const m = this.mem.get(key);
			if (m && !expired(m.expiresAt, now)) out[key] = m.writtenAt;
			else missing.push(key);
		}
		for (const chunk of chunks(missing, SQL_PARAM_CHUNK)) {
			const rows = this.ctx.storage.sql
				.exec<{ key: string; expires_at: number; written_at: number }>(
					`SELECT key, expires_at, written_at FROM kv WHERE key IN (${chunk.map(() => "?").join(",")})`,
					...chunk,
				)
				.toArray();
			for (const r of rows) if (!expired(r.expires_at, now)) out[r.key] = r.written_at;
		}
		for (const key of keys) if (!(key in out)) out[key] = null;
		return out;
	}

	/** Store these values. Returns how many were stored and which keys were refused as oversize. */
	async putMany(entries: ContentPut[]): Promise<{ stored: number; oversize: string[] }> {
		const now = Date.now();
		const oversize: string[] = [];
		let stored = 0;
		for (const e of entries) {
			if (!e?.key || typeof e.value !== "string") continue;
			const raw = enc.encode(e.value);
			const gz = e.value.length >= CONTENT_GZIP_MIN;
			const body = gz ? new Uint8Array(await gzip(raw.buffer as ArrayBuffer)) : raw;
			if (body.byteLength > CONTENT_MAX_STORED_BYTES) {
				oversize.push(`${e.key} ${body.byteLength}B`);
				continue;
			}
			const expiresAt = e.ttlSec && e.ttlSec > 0 ? now + e.ttlSec * 1000 : 0;
			this.ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO kv (key, value, gz, expires_at, written_at) VALUES (?, ?, ?, ?, ?)",
				e.key,
				body,
				gz ? 1 : 0,
				expiresAt,
				now,
			);
			this.remember(e.key, { value: e.value, expiresAt, writtenAt: now });
			stored++;
		}
		this.pruneExpired(now);
		return { stored, oversize };
	}

	/** Row count + bytes, for the Status board / tests. */
	async stats(): Promise<{ rows: number; bytes: number; memEntries: number }> {
		const r = this.ctx.storage.sql
			.exec<{ n: number; b: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value)), 0) AS b FROM kv")
			.one();
		return { rows: r.n, bytes: r.b, memEntries: this.mem.size };
	}

	private pruneExpired(now: number): void {
		if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
		this.lastPrune = now;
		this.ctx.storage.sql.exec(
			"DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE expires_at > 0 AND expires_at < ? LIMIT ?)",
			now,
			PRUNE_BATCH,
		);
		for (const [k, m] of this.mem) if (expired(m.expiresAt, now)) this.forget(k);
	}

	private remember(key: string, m: MemEntry): void {
		this.forget(key);
		this.mem.set(key, m);
		this.memBytes += m.value.length * 2;
		while (this.memBytes > CONTENT_MEMORY_BUDGET && this.mem.size > 1) {
			const oldest = this.mem.keys().next().value as string;
			this.forget(oldest);
		}
	}

	private touch(key: string, m: MemEntry): void {
		this.mem.delete(key);
		this.mem.set(key, m);
	}

	private forget(key: string): void {
		const m = this.mem.get(key);
		if (!m) return;
		this.memBytes -= m.value.length * 2;
		this.mem.delete(key);
	}
}

export function expired(expiresAt: number, now: number): boolean {
	return expiresAt > 0 && expiresAt <= now;
}

function chunks<T>(xs: T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
	return out;
}
