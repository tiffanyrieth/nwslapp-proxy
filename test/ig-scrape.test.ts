/**
 * IG scrape reliability + durable image copies (2026-10-20, src/ig-scrape.ts).
 *
 * Locks the fixes for the 10/17 (Apify 524 while the cron waited) and 10/19 (cron died mid-scrape, no
 * Bright Data) misses: the one-shot 15:00 retry decision, the marker that only moves on a SAVED pool, the
 * Apify webhook end to end against stub KV / fetch / SELF, and the image-copy plan (one object per post,
 * reused forever, failed copies keep the fresh Instagram link). node:test, like brightdata.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyImageCopies,
	apifyWebhooksParam,
	imageKeyFor,
	isRetrySlot,
	isScrapeDayUTC,
	nextPool,
	parseApifyWebhook,
	planImageCopies,
	retryPlan,
	acceptableImage,
} from "../src/ig-scrape.ts";
import { handleApifyWebhook, handleIgImageCopy } from "../src/index.ts";

const utc = (s: string) => Date.parse(s);

// ── scrape-day / retry slot ───────────────────────────────────────────────────────────────────

test("scrape days are the odd days of the month (the cron's every-2-days step)", () => {
	assert.equal(isScrapeDayUTC(utc("2026-10-19T12:00:00Z")), true);
	assert.equal(isScrapeDayUTC(utc("2026-10-20T12:00:00Z")), false);
	assert.equal(isScrapeDayUTC(utc("2026-10-31T12:00:00Z")), true);
	assert.equal(isScrapeDayUTC(utc("2026-11-01T12:00:00Z")), true); // 31 → 1: two days in a row, like the cron
});

test("exactly one 5-minute tick is the retry slot: 15:00 UTC on a scrape day", () => {
	assert.equal(isRetrySlot(utc("2026-10-19T15:00:00Z")), true);
	assert.equal(isRetrySlot(utc("2026-10-19T15:05:00Z")), false);
	assert.equal(isRetrySlot(utc("2026-10-19T14:55:00Z")), false);
	assert.equal(isRetrySlot(utc("2026-10-20T15:00:00Z")), false); // not a scrape day
});

// ── retry plan ────────────────────────────────────────────────────────────────────────────────

const now = utc("2026-10-19T15:00:00Z");
const before = utc("2026-10-17T12:03:00Z");
const today = utc("2026-10-19T12:01:30Z");

test("the 10/19 miss: neither pool nor clubs saved since 12:00 → retry both, same pool the run took", () => {
	// Marker = B (last SAVED pool) → the 12:00 run took A → the retry takes A again.
	assert.deepEqual(retryPlan({ now, marker: "B", poolAAt: before, poolBAt: before, clubAt: before, bdConfigured: true }), {
		players: "A",
		clubs: true,
	});
});

test("a run that landed needs no retry", () => {
	assert.deepEqual(retryPlan({ now, marker: "A", poolAAt: today, poolBAt: before, clubAt: today, bdConfigured: true }), {
		players: null,
		clubs: false,
	});
});

test("clubs landed but players didn't → players only (and the reverse)", () => {
	assert.deepEqual(retryPlan({ now, marker: "B", poolAAt: before, poolBAt: before, clubAt: today, bdConfigured: true }), { players: "A", clubs: false });
	assert.deepEqual(retryPlan({ now, marker: "A", poolAAt: today, poolBAt: before, clubAt: 0, bdConfigured: true }), { players: null, clubs: true });
});

test("no Bright Data configured → clubs ride the Apify run, never a separate club retry", () => {
	assert.equal(retryPlan({ now, marker: "A", poolAAt: today, poolBAt: 0, clubAt: 0, bdConfigured: false }).clubs, false);
});

test("the next pool is the one NOT saved last", () => {
	assert.equal(nextPool("A"), "B");
	assert.equal(nextPool("B"), "A");
	assert.equal(nextPool(null), "A");
});

// ── Apify webhook payload ─────────────────────────────────────────────────────────────────────

test("the run-start webhooks param targets /apify-webhook with the secret header, all terminal states", () => {
	const hooks = JSON.parse(atob(apifyWebhooksParam("https://p.example", "B", "s3cret")));
	assert.equal(hooks.length, 1);
	assert.equal(hooks[0].requestUrl, "https://p.example/apify-webhook?pool=B");
	assert.deepEqual(JSON.parse(hooks[0].headersTemplate), { Authorization: "s3cret" });
	assert.ok(hooks[0].eventTypes.includes("ACTOR.RUN.SUCCEEDED"));
	assert.ok(hooks[0].eventTypes.includes("ACTOR.RUN.TIMED_OUT"));
});

test("parseApifyWebhook reads Apify's default payload and rejects junk", () => {
	assert.deepEqual(
		parseApifyWebhook({ eventType: "ACTOR.RUN.SUCCEEDED", eventData: { actorRunId: "r1" }, resource: { id: "r1", defaultDatasetId: "d1", status: "SUCCEEDED" } }),
		{ eventType: "ACTOR.RUN.SUCCEEDED", runId: "r1", datasetId: "d1", status: "SUCCEEDED" },
	);
	assert.equal(parseApifyWebhook(null), null);
	assert.equal(parseApifyWebhook({ hello: 1 }), null);
});

// ── image copy plan ───────────────────────────────────────────────────────────────────────────

const IG = "https://scontent-lga3-1.cdninstagram.com/v/t51/abc.jpg?oe=6A0B1C2D";
const OURS = (code: string) => `https://img.crestside.app/ig/${code}`;

test("one R2 object per post, keyed by the shortcode; non-IG ids get none", () => {
	assert.equal(imageKeyFor({ id: "ig-DPq_x-9" }), "ig/DPq_x-9");
	assert.equal(imageKeyFor({ id: "bsky-3my" }), null);
	assert.equal(imageKeyFor({ id: "ig-../etc" }), null);
});

test("a post copied on an earlier scrape reuses its address — no new copy job", () => {
	const fresh = [{ id: "ig-AAA", thumbnailURL: IG }, { id: "ig-BBB", thumbnailURL: IG }];
	const prior = [{ id: "ig-AAA", thumbnailURL: OURS("AAA") }];
	const jobs = planImageCopies(fresh, prior);
	assert.deepEqual(jobs.map((j) => j.key), ["ig/BBB"]);
	assert.equal(fresh[0].thumbnailURL, OURS("AAA"));
	assert.equal(fresh[1].thumbnailURL, IG); // untouched until its copy succeeds
});

test("only successful copies switch to our address; a failed one keeps the fresh Instagram link", () => {
	const fresh = [{ id: "ig-BBB", thumbnailURL: IG }, { id: "ig-CCC", thumbnailURL: IG }];
	assert.equal(applyImageCopies(fresh, new Set(["ig/BBB"])), 1);
	assert.equal(fresh[0].thumbnailURL, OURS("BBB"));
	assert.equal(fresh[1].thumbnailURL, IG);
});

test("only real images of a sane size are stored", () => {
	assert.equal(acceptableImage("image/jpeg", 120_000), true);
	assert.equal(acceptableImage("text/plain", 21), false); // Instagram's "URL signature expired" body
	assert.equal(acceptableImage("image/jpeg", 0), false);
	assert.equal(acceptableImage(null, 100), false);
});

// ── webhook end to end (stub KV / fetch / SELF) ───────────────────────────────────────────────

type Entry = { value: string; metadata?: unknown };
function stubKV(seed: Record<string, Entry> = {}) {
	const store = new Map<string, Entry>(Object.entries(seed));
	const kv = {
		get: async (key: string, type?: string) => {
			const e = store.get(key);
			if (!e) return null;
			return type === "json" ? JSON.parse(e.value) : e.value;
		},
		getWithMetadata: async (key: string, type?: string) => {
			const e = store.get(key);
			return { value: e ? (type === "json" ? JSON.parse(e.value) : e.value) : null, metadata: e?.metadata ?? null };
		},
		put: async (key: string, value: string, opts?: { metadata?: unknown }) => {
			store.set(key, { value, metadata: opts?.metadata });
		},
		list: async ({ prefix }: { prefix: string }) => ({
			keys: [...store].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })),
		}),
	};
	return { kv, store };
}

// Seed player list: Rodman in pool A (the seed list would also work, but an explicit list pins the pool).
const PLAYERS = JSON.stringify([{ name: "Trinity Rodman", abbr: "WAS", ig: "trinity_rodman", pool: "A" }]);
const apifyItem = (code: string, takenAt: number) => ({
	scraped_username: "trinity_rodman",
	code,
	post_url: `https://www.instagram.com/p/${code}/`,
	taken_at: takenAt,
	image_url: `https://scontent-lga3-1.cdninstagram.com/v/${code}.jpg?oe=6A0B1C2D`,
	caption: { text: "match day" },
	like_count: 10,
});

function webhookReq(body: unknown, auth = "hook-secret", pool = "A") {
	return new Request(`https://proxy.example/apify-webhook?pool=${pool}`, {
		method: "POST",
		headers: { Authorization: auth, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}
const succeeded = { eventType: "ACTOR.RUN.SUCCEEDED", eventData: { actorRunId: "r1" }, resource: { id: "r1", defaultDatasetId: "d1", status: "SUCCEEDED" } };
const ctx = { waitUntil(_p: Promise<unknown>) {} } as never;

function withDatasetFetch<T>(items: unknown[], fn: (urls: string[]) => Promise<T>): Promise<T> {
	const real = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		urls.push(url);
		if (url.includes("/v2/datasets/d1/items")) return new Response(JSON.stringify(items), { headers: { "content-type": "application/json" } });
		return new Response("unexpected", { status: 500 });
	}) as typeof fetch;
	return fn(urls).finally(() => { globalThis.fetch = real; });
}

function envWith(kv: unknown, extra: Record<string, unknown> = {}) {
	return { APIFY_TOKEN: "tok", APIFY_WEBHOOK_SECRET: "hook-secret", BRIGHTDATA_TOKEN: "bd", BD_WEBHOOK_SECRET: "bds", FEED_TAGS: kv, ...extra } as never;
}

test("webhook: bad auth → 403 and nothing written", async () => {
	const { kv, store } = stubKV({ "social:player-list": { value: PLAYERS } });
	const r = await handleApifyWebhook(webhookReq(succeeded, "nope"), envWith(kv), ctx);
	assert.equal(r.status, 403);
	assert.equal(store.has("social-cards-player-pool-a"), false);
});

test("webhook: a FAILED/TIMED_OUT run writes nothing and leaves the marker (so 15:00 retries it)", async () => {
	const { kv, store } = stubKV({ "social:player-list": { value: PLAYERS }, "social:pool-last-scraped": { value: "B" } });
	const r = await handleApifyWebhook(webhookReq({ ...succeeded, eventType: "ACTOR.RUN.TIMED_OUT" }), envWith(kv), ctx);
	assert.equal(r.status, 200);
	assert.equal(store.has("social-cards-player-pool-a"), false);
	assert.equal(store.get("social:pool-last-scraped")?.value, "B");
});

test("webhook: a successful run saves the pool with a fresh stamp, THEN moves the marker", async () => {
	const { kv, store } = stubKV({ "social:player-list": { value: PLAYERS }, "social:pool-last-scraped": { value: "B" } });
	const t0 = Date.now();
	await withDatasetFetch([apifyItem("AAA", 1792400000), apifyItem("BBB", 1792300000)], async (urls) => {
		const r = await handleApifyWebhook(webhookReq(succeeded), envWith(kv), ctx);
		assert.equal(r.status, 200);
		// Only the mapper's fields are requested (keeps the parse small on the Free CPU budget).
		assert.ok(urls[0].includes("fields=scraped_username,"));
	});
	const saved = store.get("social-cards-player-pool-a");
	assert.ok(saved, "pool A saved");
	assert.equal((JSON.parse(saved.value) as unknown[]).length, 2);
	assert.ok(((saved.metadata as { at: number }).at) >= t0, "fresh-write stamp for the retry check");
	assert.equal(store.get("social:pool-last-scraped")?.value, "A");
});

test("webhook: an empty successful run keeps last-good WITH its old stamp and does not move the marker", async () => {
	const lastGood = JSON.stringify([{ id: "ig-OLD", url: "https://www.instagram.com/p/OLD/" }]);
	const { kv, store } = stubKV({
		"social:player-list": { value: PLAYERS },
		"social:pool-last-scraped": { value: "B" },
		"social-cards-player-pool-a": { value: lastGood, metadata: { at: 111 } },
	});
	await withDatasetFetch([], async () => {
		await handleApifyWebhook(webhookReq(succeeded), envWith(kv), ctx);
	});
	assert.equal(store.get("social-cards-player-pool-a")?.value, lastGood);
	assert.deepEqual(store.get("social-cards-player-pool-a")?.metadata, { at: 111 });
	assert.equal(store.get("social:pool-last-scraped")?.value, "B");
});

test("webhook: new images are copied through SELF and the saved cards point at img.crestside.app", async () => {
	const { kv, store } = stubKV({ "social:player-list": { value: PLAYERS } });
	const selfCalls: { key: string; src: string }[][] = [];
	const SELF = {
		fetch: async (req: Request) => {
			const batch = (await req.json()) as { key: string; src: string }[];
			selfCalls.push(batch);
			// Pretend the first copies and the second fails.
			return new Response(JSON.stringify({ copied: [batch[0].key], failed: batch.length - 1 }));
		},
	};
	await withDatasetFetch([apifyItem("AAA", 1792400000), apifyItem("BBB", 1792300000)], async () => {
		await handleApifyWebhook(webhookReq(succeeded), envWith(kv, { IMAGES: {}, SELF, BRACKET_ADMIN_KEY: "admin" }), ctx);
	});
	assert.equal(selfCalls.length, 1);
	const cards = JSON.parse(store.get("social-cards-player-pool-a")!.value) as { id: string; thumbnailURL: string }[];
	const byId = new Map(cards.map((c) => [c.id, c.thumbnailURL]));
	assert.equal(byId.get("ig-AAA"), "https://img.crestside.app/ig/AAA");
	assert.match(byId.get("ig-BBB") ?? "", /cdninstagram\.com/); // failed copy keeps the fresh link
});

test("image copy route: admin-only, Instagram CDN sources only, stores real images with an immutable cache header", async () => {
	const puts: { key: string; opts: unknown }[] = [];
	const env = { BRACKET_ADMIN_KEY: "admin", IMAGES: { put: async (key: string, _b: unknown, opts: unknown) => { puts.push({ key, opts }); } } } as never;
	const req = (body: unknown, key = "admin") => new Request("https://proxy.example/internal/ig-images", {
		method: "POST", headers: { "x-admin-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
	});
	assert.equal((await handleIgImageCopy(req([], "wrong"), env)).status, 403);

	const real = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("good")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
		return new Response("URL signature expired", { status: 403, headers: { "content-type": "text/plain" } });
	}) as typeof fetch;
	try {
		const r = await handleIgImageCopy(req([
			{ key: "ig/GOOD", src: "https://scontent-x.cdninstagram.com/good.jpg" },
			{ key: "ig/EXP", src: "https://scontent-x.cdninstagram.com/expired.jpg" },
			{ key: "ig/EVIL", src: "https://evil.example/good.jpg" },
			{ key: "../x", src: "https://scontent-x.cdninstagram.com/good.jpg" },
		]), env);
		const out = (await r.json()) as { copied: string[]; failed: number };
		assert.deepEqual(out.copied, ["ig/GOOD"]);
		assert.equal(out.failed, 3);
		assert.deepEqual(puts.map((p) => p.key), ["ig/GOOD"]);
		assert.match(JSON.stringify(puts[0].opts), /immutable/);
	} finally {
		globalThis.fetch = real;
	}
});
