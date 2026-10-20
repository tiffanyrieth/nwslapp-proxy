// Polite feed fetching (2026-10-20, src/feed-polite.ts): every 4h, "only if changed" requests, per-feed
// backoff, dead-source flag. Locks the fix for Utah Royals Buzz (429 every hourly run) and the Orlando
// Sentinel (403 every hourly run) — both were retried forever because a failed feed stayed "stalest".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	FEED_BACKOFF_MS,
	FEED_DEAD_AFTER_MS,
	FEED_REFRESH_MS,
	FeedHttpError,
	conditionalHeaders,
	healthAfterFailure,
	healthAfterSuccess,
	isDeadFeed,
	isFeedDue,
	parseRetryAfter,
	validatorsOf,
} from "../src/feed-polite.ts";

const H = 3600 * 1000;
const now = Date.parse("2026-10-20T12:00:00Z");

test("the cadence is 4 hours", () => {
	assert.equal(FEED_REFRESH_MS, 4 * H);
});

test("a feed we've fetched before is asked 'only if changed'", () => {
	assert.deepEqual(conditionalHeaders({ etag: 'W/"f2eec-1jV"', lastModified: "Mon, 19 Oct 2026 12:00:00 GMT" }), {
		"If-None-Match": 'W/"f2eec-1jV"',
		"If-Modified-Since": "Mon, 19 Oct 2026 12:00:00 GMT",
	});
	assert.deepEqual(conditionalHeaders(undefined), {});
	assert.deepEqual(validatorsOf(new Headers({ etag: '"abc"' })), { etag: '"abc"' });
});

test("Retry-After: seconds or an HTTP date, capped at 48h", () => {
	assert.equal(parseRetryAfter("120", now), 120_000);
	assert.equal(parseRetryAfter(new Date(now + 2 * H).toUTCString(), now), 2 * H);
	assert.equal(parseRetryAfter("999999", now), 48 * H);
	assert.equal(parseRetryAfter("soon", now), null);
	assert.equal(parseRetryAfter(null, now), null);
});

test("failures back off 4h → 8h → 24h → 48h (the last step repeats), and success resets", () => {
	let h = healthAfterFailure(undefined, new Error("x"), now);
	assert.equal(h.failStreak, 1);
	assert.equal(h.nextAttemptAt, now + FEED_BACKOFF_MS[0]);
	assert.equal(h.failingSince, now);
	h = healthAfterFailure(h, new Error("x"), now + 4 * H);
	assert.equal(h.nextAttemptAt, now + 4 * H + 8 * H);
	h = healthAfterFailure(h, new Error("x"), now + 12 * H);
	assert.equal(h.nextAttemptAt, now + 12 * H + 24 * H);
	h = healthAfterFailure(h, new Error("x"), now + 36 * H);
	assert.equal(h.nextAttemptAt, now + 36 * H + 48 * H);
	h = healthAfterFailure(h, new Error("x"), now + 84 * H);
	assert.equal(h.nextAttemptAt, now + 84 * H + 48 * H); // stays at 48h
	assert.equal(h.failingSince, now); // the dead-source clock keeps the FIRST failure
	const ok = healthAfterSuccess(h, { etag: '"new"' });
	assert.equal(ok.failStreak, undefined);
	assert.equal(ok.nextAttemptAt, undefined);
	assert.equal(ok.etag, '"new"');
});

test("a 429 with Retry-After waits what the site asked (never sooner than the normal cadence)", () => {
	const long = healthAfterFailure(undefined, new FeedHttpError("HTTP 429", 429, 10 * H), now);
	assert.equal(long.nextAttemptAt, now + 10 * H);
	const short = healthAfterFailure(undefined, new FeedHttpError("HTTP 429", 429, 60_000), now);
	assert.equal(short.nextAttemptAt, now + FEED_REFRESH_MS);
});

test("a backed-off feed isn't due until its window ends; a healthy one always is", () => {
	const h = healthAfterFailure(undefined, new Error("x"), now);
	assert.equal(isFeedDue(h, now + 1 * H), false);
	assert.equal(isFeedDue(h, now + 4 * H), true);
	assert.equal(isFeedDue(undefined, now), true);
	assert.equal(isFeedDue({}, now), true);
});

test("a 304 keeps the stored validators (no re-download, still healthy)", () => {
	const kept = healthAfterSuccess({ etag: '"e1"', lastModified: "x", failStreak: 2, nextAttemptAt: now }, null);
	assert.deepEqual(kept, { etag: '"e1"', lastModified: "x" });
});

test("failing 7+ days straight → flagged for the owner; a recovered feed isn't", () => {
	const h = { failStreak: 5, failingSince: now - FEED_DEAD_AFTER_MS, nextAttemptAt: now };
	assert.equal(isDeadFeed(h, now), true);
	assert.equal(isDeadFeed({ ...h, failingSince: now - FEED_DEAD_AFTER_MS + 1 }, now), false);
	assert.equal(isDeadFeed(healthAfterSuccess(h, null), now), false);
});
