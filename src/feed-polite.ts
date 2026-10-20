// POLITE FEED FETCHING — Club Beat, news outlets and podcasts (2026-10-20). Pure helpers, unit-tested in
// test/feed-polite.test.ts; the wiring is in index.ts (refreshSocialSources / refreshPodcastsSnapshot).
//
// WHY: every feed was re-downloaded IN FULL every hour (Utah Royals Buzz's Substack feed is ~1 MB → ~24 MB/day
// from one small blog), and a failing feed kept its old fetchedAt, so it stayed "stalest" and was retried
// EVERY hour forever: Utah Royals Buzz 429'd (server=cloudflare) and the Orlando Sentinel 403'd on every run.
// Substack hosts 4 of our feeds, and Cloudflare's outbound IPs are shared with every other Cloudflare
// customer, so our share of their rate limit should be as small as we can make it.
// NOW (owner decision 2026-10-20, replacing the 2026-10-05 hourly ruling): every 4h; an "only if changed"
// request (If-None-Match / If-Modified-Since → an unchanged feed is a tiny 304); a failing feed backs off
// 4h → 8h → 24h → 48h (or the site's own Retry-After); one that has failed for 7 days is flagged in the
// daily digest for the owner to keep or drop.

export interface FeedValidators {
	etag?: string;
	lastModified?: string;
}

/** Per-feed health carried on its snapshot slot. */
export interface FeedHealth extends FeedValidators {
	/** Consecutive failed attempts (0/absent = healthy). */
	failStreak?: number;
	/** Don't try this feed again before this (ms). */
	nextAttemptAt?: number;
	/** First failure of the current streak (ms) — the dead-source clock. */
	failingSince?: number;
}

export const FEED_REFRESH_MS = 4 * 3600 * 1000;
/** Backoff after the Nth consecutive failure (index N-1); the last step repeats. */
export const FEED_BACKOFF_MS = [4, 8, 24, 48].map((h) => h * 3600 * 1000);
export const FEED_BACKOFF_MAX_MS = 48 * 3600 * 1000;
/** A feed failing this long is flagged once a day in the digest (owner decides to keep or drop it). */
export const FEED_DEAD_AFTER_MS = 7 * 86_400_000;

/** A non-2xx feed response, with what backoff needs. */
export class FeedHttpError extends Error {
	readonly status: number;
	readonly retryAfterMs: number | null;
	// Explicit fields, not constructor parameter properties: node's type-stripping test runner rejects those.
	constructor(message: string, status: number, retryAfterMs: number | null) {
		super(message);
		this.name = "FeedHttpError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

/** The conditional-request headers for a feed we've fetched before. */
export function conditionalHeaders(v: FeedValidators | undefined): Record<string, string> {
	const h: Record<string, string> = {};
	if (v?.etag) h["If-None-Match"] = v.etag;
	if (v?.lastModified) h["If-Modified-Since"] = v.lastModified;
	return h;
}

/** The validators a 200 response offers for next time. */
export function validatorsOf(headers: Headers): FeedValidators {
	const v: FeedValidators = {};
	const etag = headers.get("etag");
	const lm = headers.get("last-modified");
	if (etag) v.etag = etag;
	if (lm) v.lastModified = lm;
	return v;
}

/** `Retry-After` (seconds or an HTTP date) → ms from now, bounded to [0, FEED_BACKOFF_MAX_MS]; null if absent/bad. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
	if (!value) return null;
	const v = value.trim();
	let ms: number;
	if (/^\d+$/.test(v)) ms = Number(v) * 1000;
	else {
		const at = Date.parse(v);
		if (Number.isNaN(at)) return null;
		ms = at - now;
	}
	return Math.min(FEED_BACKOFF_MAX_MS, Math.max(0, ms));
}

/** Is this feed due for an attempt? (Not inside a backoff window.) */
export function isFeedDue(h: FeedHealth | undefined, now: number): boolean {
	return !h?.nextAttemptAt || now >= h.nextAttemptAt;
}

/** Health after a successful fetch (200 or 304): streak cleared, validators kept/updated. */
export function healthAfterSuccess(prev: FeedHealth | undefined, v: FeedValidators | null): FeedHealth {
	const keep = v ?? { etag: prev?.etag, lastModified: prev?.lastModified };
	const out: FeedHealth = {};
	if (keep.etag) out.etag = keep.etag;
	if (keep.lastModified) out.lastModified = keep.lastModified;
	return out;
}

/** Health after a failed attempt: streak +1, next attempt after the site's Retry-After (when given, but never
 *  sooner than the normal cadence) or the exponential step; the dead-source clock starts at the first failure. */
export function healthAfterFailure(prev: FeedHealth | undefined, err: unknown, now: number): FeedHealth {
	const streak = (prev?.failStreak ?? 0) + 1;
	const step = FEED_BACKOFF_MS[Math.min(streak - 1, FEED_BACKOFF_MS.length - 1)];
	const retryAfter = err instanceof FeedHttpError ? err.retryAfterMs : null;
	const wait = Math.min(FEED_BACKOFF_MAX_MS, retryAfter != null ? Math.max(retryAfter, FEED_REFRESH_MS) : step);
	return {
		...(prev?.etag ? { etag: prev.etag } : {}),
		...(prev?.lastModified ? { lastModified: prev.lastModified } : {}),
		failStreak: streak,
		nextAttemptAt: now + wait,
		failingSince: prev?.failingSince ?? now,
	};
}

/** Failing for ≥ FEED_DEAD_AFTER_MS — surface it (once a day) so the owner can decide to keep or drop it. */
export function isDeadFeed(h: FeedHealth | undefined, now: number): boolean {
	return !!h?.failingSince && (h.failStreak ?? 0) > 0 && now - h.failingSince >= FEED_DEAD_AFTER_MS;
}
