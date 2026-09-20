// Low-grade image-moderation backstop for player IG feed thumbnails (2026-09-20). Guards the
// decision logic in moderateFeedImages: drop on UNSAFE, keep on SAFE, cache once, and — the
// safety-critical part — FAIL OPEN (keep the card) on every error path so a hiccup never blanks
// the Feed. All platform deps are injected (no Workers AI, no KV, no network). Pure test. Run:
//   node --test test/social-image-moderation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { moderateFeedImages, type ImageModDeps } from "../src/social-moderation.ts";

// ── Mock deps ───────────────────────────────────────────────────────────────────────
function makeKV(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		kvGet: async (k: string) => (store.has(k) ? store.get(k)! : null),
		kvPut: async (k: string, v: string) => { store.set(k, v); },
	};
}

// env.AI stub whose reply is decided per-call; counts invocations. Pass an Error to throw.
function makeAI(reply: () => string | Error) {
	const state = { calls: 0 };
	const ai: ImageModDeps["ai"] = {
		run: async () => {
			state.calls++;
			const v = reply();
			if (v instanceof Error) throw v;
			return { response: v };
		},
	};
	return { ai, state };
}

// Default: every image fetch succeeds (1KB of bytes). `ok:false` case = returns null.
const okBytes = async () => new Uint8Array(1000);
const failBytes = async () => null;

const deps = (over: Partial<ImageModDeps>): ImageModDeps => ({
	ai: undefined,
	kvGet: async () => null,
	kvPut: async () => {},
	fetchImageBytes: okBytes,
	...over,
});

const card = (id: string) => ({
	id: `ig-${id}`,
	url: `https://www.instagram.com/p/${id}/`,
	thumbnailURL: `https://scontent.cdninstagram.com/${id}.jpg`,
	handle: `@${id}`,
});
const ids = (cards: unknown[]) => cards.map((c) => (c as { id: string }).id);

// ── Tests ─────────────────────────────────────────────────────────────────────────

test("UNSAFE image is dropped and the verdict is cached", async () => {
	const kv = makeKV();
	const { ai } = makeAI(() => "UNSAFE");
	const out = await moderateFeedImages([card("a")], deps({ ai, kvGet: kv.kvGet, kvPut: kv.kvPut }));
	assert.deepEqual(ids(out), [], "unsafe card must be dropped");
	assert.equal(kv.store.get("imgmod:https://www.instagram.com/p/a/"), "unsafe", "verdict cached");
});

test("SAFE image is kept and the verdict is cached", async () => {
	const kv = makeKV();
	const { ai } = makeAI(() => "SAFE");
	const out = await moderateFeedImages([card("b")], deps({ ai, kvGet: kv.kvGet, kvPut: kv.kvPut }));
	assert.deepEqual(ids(out), ["ig-b"], "safe card must be kept");
	assert.equal(kv.store.get("imgmod:https://www.instagram.com/p/b/"), "safe");
});

test("cached verdicts are honored WITHOUT re-calling the model", async () => {
	const kv = makeKV({
		"imgmod:https://www.instagram.com/p/safe/": "safe",
		"imgmod:https://www.instagram.com/p/bad/": "unsafe",
	});
	const { ai, state } = makeAI(() => { throw new Error("should not be called"); });
	const out = await moderateFeedImages([card("safe"), card("bad")], deps({ ai, kvGet: kv.kvGet, kvPut: kv.kvPut }));
	assert.deepEqual(ids(out), ["ig-safe"], "cached-safe kept, cached-unsafe dropped");
	assert.equal(state.calls, 0, "no AI calls when both are cached");
});

test("FAIL OPEN: missing AI binding keeps every card and never fetches", async () => {
	let fetched = false;
	const out = await moderateFeedImages([card("a"), card("b")], deps({
		ai: undefined,
		fetchImageBytes: async () => { fetched = true; return new Uint8Array(0); },
	}));
	assert.deepEqual(ids(out), ["ig-a", "ig-b"], "no binding → keep all");
	assert.equal(fetched, false, "no binding → skip image fetches entirely");
});

test("FAIL OPEN: an AI error keeps the card and does NOT cache a verdict", async () => {
	const kv = makeKV();
	const { ai } = makeAI(() => new Error("AI down"));
	const out = await moderateFeedImages([card("a")], deps({ ai, kvGet: kv.kvGet, kvPut: kv.kvPut }));
	assert.deepEqual(ids(out), ["ig-a"], "AI error → keep (fail open)");
	assert.equal(kv.store.size, 0, "no verdict cached on error (retried next run)");
});

test("FAIL OPEN: an ambiguous model reply keeps the card and is not cached", async () => {
	const kv = makeKV();
	const { ai } = makeAI(() => "I am not sure about this one");
	const out = await moderateFeedImages([card("a")], deps({ ai, kvGet: kv.kvGet, kvPut: kv.kvPut }));
	assert.deepEqual(ids(out), ["ig-a"], "ambiguous → keep (fail open)");
	assert.equal(kv.store.size, 0, "ambiguous reply is not cached");
});

test("FAIL OPEN: an image-fetch failure keeps the card without classifying", async () => {
	const kv = makeKV();
	const { ai, state } = makeAI(() => "UNSAFE");
	const out = await moderateFeedImages([card("a")], deps({ ai, kvGet: kv.kvGet, kvPut: kv.kvPut, fetchImageBytes: failBytes }));
	assert.deepEqual(ids(out), ["ig-a"], "fetch fail → keep (fail open)");
	assert.equal(state.calls, 0, "no classification attempted when bytes can't be fetched");
});

test("a card without a thumbnail is kept and never scanned", async () => {
	const { ai, state } = makeAI(() => "UNSAFE");
	const noImg = { id: "ig-x", url: "https://www.instagram.com/p/x/", handle: "@x" };
	const out = await moderateFeedImages([noImg], deps({ ai }));
	assert.deepEqual(ids(out), ["ig-x"], "no thumbnail → nothing to check → keep");
	assert.equal(state.calls, 0);
});

test("mixed batch: only the UNSAFE card is removed, order preserved", async () => {
	// Live-classify every uncached image as SAFE; pre-seed card "b" as unsafe in the cache.
	const kv = makeKV({ "imgmod:https://www.instagram.com/p/b/": "unsafe" });
	const { ai } = makeAI(() => "SAFE");
	const out = await moderateFeedImages([card("a"), card("b"), card("c")], deps({ ai, kvGet: kv.kvGet, kvPut: kv.kvPut }));
	assert.deepEqual(ids(out), ["ig-a", "ig-c"], "drop only b, keep order of the rest");
});

test("diag is emitted with a run summary (drop + run kinds)", async () => {
	const kv = makeKV();
	const { ai } = makeAI(() => "UNSAFE");
	const kinds: string[] = [];
	await moderateFeedImages([card("a")], deps({ ai, kvGet: kv.kvGet, kvPut: kv.kvPut, diag: (k) => kinds.push(k) }));
	assert.ok(kinds.includes("imageModerationDrop"), "a drop emits imageModerationDrop");
	assert.ok(kinds.includes("imageModerationRun"), "every run emits a summary");
});
