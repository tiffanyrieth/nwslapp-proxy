/**
 * Bright Data player-IG pipeline — the pure/near-pure core of the 2026-07-05 load-balance
 * split (clubs stay on Apify, players move to Bright Data's free 5k-records/mo tier).
 *
 * Covers mapBrightDataInstagram (BD dataset item → ContentCard, same shape as the Apify
 * mapper) and handleBrightDataWebhook (auth gate, handle matching, player-key write,
 * empty-payload keeps last-good). Run with `node --test test/brightdata.test.ts` —
 * deliberately NOT vitest (vitest-pool-workers can't boot workerd on Node 26 here);
 * KV/ctx are tiny stubs, no Workers runtime needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBrightDataWebhook, mapBrightDataInstagram } from "../src/index.ts";

type Card = {
	id: string;
	placement: string;
	sourceType: string;
	teamAbbreviation: string;
	authorName: string;
	handle: string;
	bodyText?: string;
	thumbnailURL?: string;
	likes?: number;
	timestamp: string;
	url: string;
};

const rodman = { handle: "trinity_rodman", platform: "instagram", kind: "player", abbr: "WAS", name: "Trinity Rodman" } as never;

/** A representative BD Instagram Posts dataset item (documented field names). */
const bdItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	url: "https://www.instagram.com/p/DEF456/",
	shortcode: "DEF456",
	description: "great win today",
	date_posted: "2026-07-04T21:15:00.000Z",
	photos: ["https://cdn.example/img1.jpg", "https://cdn.example/img2.jpg"],
	user_posted: "trinity_rodman",
	likes: 41230,
	...over,
});

test("mapBrightDataInstagram: full item → player feed card, Apify-shape-compatible", () => {
	const card = mapBrightDataInstagram(bdItem(), rodman) as Card;
	assert.equal(card.id, "ig-DEF456");
	assert.equal(card.placement, "feed");
	assert.equal(card.sourceType, "player");
	assert.equal(card.teamAbbreviation, "WAS");
	assert.equal(card.authorName, "Trinity Rodman");
	assert.equal(card.handle, "@trinity_rodman");
	assert.equal(card.bodyText, "great win today");
	assert.equal(card.thumbnailURL, "https://cdn.example/img1.jpg");
	assert.equal(card.likes, 41230);
	assert.equal(card.timestamp, "2026-07-04T21:15:00Z"); // isoFromAny strips fractional seconds
	assert.equal(card.url, "https://www.instagram.com/p/DEF456/");
});

test("mapBrightDataInstagram: unusable items → null (no url/shortcode; no date)", () => {
	assert.equal(mapBrightDataInstagram(bdItem({ url: undefined, shortcode: undefined, post_id: undefined }), rodman), null);
	assert.equal(mapBrightDataInstagram(bdItem({ date_posted: undefined, timestamp: undefined }), rodman), null);
});

test("mapBrightDataInstagram: falls back to display_url when photos is absent", () => {
	const card = mapBrightDataInstagram(bdItem({ photos: undefined, display_url: "https://cdn.example/dp.jpg" }), rodman) as Card;
	assert.equal(card.thumbnailURL, "https://cdn.example/dp.jpg");
});

// ── webhook handler, against stub KV/ctx ──────────────────────────────────────

function stubEnv(secret: string | undefined, seed: Record<string, string> = {}) {
	const store = new Map(Object.entries(seed));
	const env = {
		BD_WEBHOOK_SECRET: secret,
		FEED_TAGS: {
			get: async (key: string, _type?: string) => {
				const v = store.get(key);
				return v ? JSON.parse(v) : null;
			},
			put: async (key: string, value: string) => {
				store.set(key, value);
			},
		},
	};
	return { env: env as never, store };
}
const ctx = { waitUntil(_p: Promise<unknown>) {} } as never;

const webhook = (body: unknown, auth?: string) =>
	new Request("https://proxy.example/brightdata-webhook", {
		method: "POST",
		headers: auth ? { Authorization: auth, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

test("webhook: wrong/missing auth or unset secret → 403, nothing written", async () => {
	const { env, store } = stubEnv("s3cret");
	assert.equal((await handleBrightDataWebhook(webhook([bdItem()], "wrong"), env, ctx)).status, 403);
	assert.equal((await handleBrightDataWebhook(webhook([bdItem()]), env, ctx)).status, 403);
	const unset = stubEnv(undefined);
	assert.equal((await handleBrightDataWebhook(webhook([bdItem()], "s3cret"), unset.env, ctx)).status, 403);
	assert.equal([...store.keys()].some((k) => k.startsWith("social-cards")), false);
});

test("webhook: valid delivery → maps known handles, writes the player key", async () => {
	const { env, store } = stubEnv("s3cret");
	const items = [bdItem(), bdItem({ user_posted: "not_a_tracked_account", shortcode: "XYZ" })];
	const resp = await handleBrightDataWebhook(webhook(items, "s3cret"), env, ctx);
	assert.equal(resp.status, 200);
	const summary = (await resp.json()) as { received: number; cards: number; kept: number };
	assert.equal(summary.received, 2);
	assert.equal(summary.cards, 1); // the untracked account is dropped
	const written = JSON.parse(store.get("social-cards-player-v1")!) as Card[];
	assert.equal(written.length, 1);
	assert.equal(written[0].handle, "@trinity_rodman");
});

test("webhook: empty delivery keeps the last-good player snapshot (re-put, not blanked)", async () => {
	const lastGood = [{ id: "ig-OLD", placement: "feed", handle: "@trinity_rodman" }];
	const { env, store } = stubEnv("s3cret", { "social-cards-player-v1": JSON.stringify(lastGood) });
	const resp = await handleBrightDataWebhook(webhook([], "s3cret"), env, ctx);
	assert.equal(resp.status, 200);
	const summary = (await resp.json()) as { kept: number };
	assert.equal(summary.kept, 1);
	assert.deepEqual(JSON.parse(store.get("social-cards-player-v1")!), lastGood);
});

test("webhook: empty delivery with no prior player key falls back to the LEGACY combined key", async () => {
	const legacy = [
		{ id: "ig-CLUB", placement: "home" },
		{ id: "ig-PLAYER", placement: "feed" },
	];
	const { env, store } = stubEnv("s3cret", { "social-cards-v1": JSON.stringify(legacy) });
	await handleBrightDataWebhook(webhook([], "s3cret"), env, ctx);
	const written = JSON.parse(store.get("social-cards-player-v1")!) as Array<{ id: string }>;
	assert.deepEqual(written.map((c) => c.id), ["ig-PLAYER"]); // only the feed side seeds the player key
});
