// Image-safety backstop for player IG feed thumbnails (decoupled snapshot-batch design, 2026-09-20).
// Guards moderateSnapshotBatch: drop UNSAFE (remove from the array), keep+mark SAFE (mod:"ok"), skip
// already-judged/approved without an AI call, respect the per-pass batch size, and — the safety-critical
// part — FAIL OPEN (leave a card unjudged, still served) on no-AI / fetch-fail / AI-error / ambiguity.
// Plus carryForwardVerdicts. All deps injected (no Workers AI, no network). Pure test. Run:
//   node --test test/social-image-moderation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { moderateSnapshotBatch, carryForwardVerdicts, type ModDeps } from "../src/social-moderation.ts";

// ── Mock deps ───────────────────────────────────────────────────────────────────────
function makeAI(reply: () => string | Error) {
	const state = { calls: 0 };
	const ai: ModDeps["ai"] = {
		run: async () => {
			state.calls++;
			const v = reply();
			if (v instanceof Error) throw v;
			return { response: v };
		},
	};
	return { ai, state };
}
const okBytes = async () => new Uint8Array(1000);
const failBytes = async () => null;

const deps = (over: Partial<ModDeps>): ModDeps => ({ ai: undefined, fetchImageBytes: okBytes, ...over });

const card = (id: string) => ({
	id: `ig-${id}`,
	url: `https://www.instagram.com/p/${id}/`,
	thumbnailURL: `https://scontent.cdninstagram.com/${id}.jpg`,
	handle: `@${id}`,
	authorName: id.toUpperCase(),
});
const ids = (cards: unknown[]) => cards.map((c) => (c as { id: string }).id);
const modOf = (c: unknown) => (c as { mod?: string }).mod;

// ── Tests ─────────────────────────────────────────────────────────────────────────

test("UNSAFE image is dropped from the array + onDrop fires with the parsed reason", async () => {
	const { ai } = makeAI(() => "UNSAFE nudity");
	const rows: Array<{ reason: string; postUrl: string; handle: string }> = [];
	const res = await moderateSnapshotBatch([card("a")], new Set(), 5, deps({ ai, onDrop: (r) => rows.push(r) }));
	assert.deepEqual(ids(res.cards), [], "unsafe card removed from the snapshot");
	assert.equal(res.dropped, 1);
	assert.equal(rows[0].reason, "nudity", "reason parsed from the model reply");
	assert.equal(rows[0].postUrl, "https://www.instagram.com/p/a/");
});

test("SAFE image is kept and marked mod:ok", async () => {
	const { ai } = makeAI(() => "SAFE");
	const res = await moderateSnapshotBatch([card("b")], new Set(), 5, deps({ ai }));
	assert.deepEqual(ids(res.cards), ["ig-b"]);
	assert.equal(modOf(res.cards[0]), "ok");
	assert.equal(res.dropped, 0);
	assert.ok(res.changed);
});

test("already-judged (mod:ok) cards are skipped without an AI call", async () => {
	const { ai, state } = makeAI(() => { throw new Error("should not be called"); });
	const c = { ...card("c"), mod: "ok" };
	const res = await moderateSnapshotBatch([c], new Set(), 5, deps({ ai }));
	assert.deepEqual(ids(res.cards), ["ig-c"]);
	assert.equal(state.calls, 0);
});

test("FAIL OPEN: no AI binding leaves every card unjudged (kept, still served)", async () => {
	const res = await moderateSnapshotBatch([card("a"), card("b")], new Set(), 5, deps({ ai: undefined }));
	assert.deepEqual(ids(res.cards), ["ig-a", "ig-b"], "kept unjudged");
	assert.equal(res.remaining, 2);
	assert.equal(res.dropped, 0);
});

test("FAIL OPEN: an AI error leaves the card unjudged (not marked ok, not dropped)", async () => {
	const { ai } = makeAI(() => new Error("AI down"));
	const res = await moderateSnapshotBatch([card("a")], new Set(), 5, deps({ ai }));
	assert.deepEqual(ids(res.cards), ["ig-a"]);
	assert.notEqual(modOf(res.cards[0]), "ok");
	assert.equal(res.remaining, 1);
});

test("FAIL OPEN: an ambiguous reply leaves the card unjudged", async () => {
	const { ai } = makeAI(() => "hmm not sure");
	const res = await moderateSnapshotBatch([card("a")], new Set(), 5, deps({ ai }));
	assert.deepEqual(ids(res.cards), ["ig-a"]);
	assert.notEqual(modOf(res.cards[0]), "ok");
});

test("FAIL OPEN: a fetch failure leaves the card unjudged without classifying", async () => {
	const { ai, state } = makeAI(() => "UNSAFE");
	const res = await moderateSnapshotBatch([card("a")], new Set(), 5, deps({ ai, fetchImageBytes: failBytes }));
	assert.deepEqual(ids(res.cards), ["ig-a"], "fetch fail → kept unjudged");
	assert.equal(state.calls, 0, "no classify without bytes");
	assert.equal(res.remaining, 1);
});

test("a card with no thumbnail is marked ok (nothing to judge) and never scanned", async () => {
	const { ai, state } = makeAI(() => "UNSAFE");
	const noImg = { id: "ig-x", url: "https://www.instagram.com/p/x/", handle: "@x" };
	const res = await moderateSnapshotBatch([noImg], new Set(), 5, deps({ ai }));
	assert.deepEqual(ids(res.cards), ["ig-x"]);
	assert.equal(modOf(res.cards[0]), "ok");
	assert.equal(state.calls, 0);
});

test("an approved post URL is kept + marked ok without an AI call, even if it would be unsafe", async () => {
	const { ai, state } = makeAI(() => "UNSAFE nudity");
	const res = await moderateSnapshotBatch([card("a")], new Set(["https://www.instagram.com/p/a/"]), 5, deps({ ai }));
	assert.deepEqual(ids(res.cards), ["ig-a"], "approved → kept");
	assert.equal(modOf(res.cards[0]), "ok");
	assert.equal(state.calls, 0, "approved → never classified");
});

test("batch size caps how many NEW images are classified per pass; the rest stay unjudged", async () => {
	const { ai, state } = makeAI(() => "SAFE");
	const res = await moderateSnapshotBatch([card("a"), card("b"), card("c")], new Set(), 2, deps({ ai }));
	assert.equal(state.calls, 2, "only batchSize classified");
	assert.equal(res.processed, 2);
	assert.equal(res.remaining, 1, "one left for a later pass");
	assert.equal(res.cards.filter((c) => modOf(c) === "ok").length, 2, "two marked ok");
});

test("carryForwardVerdicts: prior-ok and approved fresh cards are marked ok; new ones stay unjudged", () => {
	const fresh = [card("a"), card("b"), card("new")];
	const prior = [{ ...card("a"), mod: "ok" }];
	carryForwardVerdicts(fresh, prior, new Set(["https://www.instagram.com/p/b/"]));
	assert.equal(modOf(fresh[0]), "ok", "carried from prior snapshot");
	assert.equal(modOf(fresh[1]), "ok", "on the approve allowlist");
	assert.equal(modOf(fresh[2]), undefined, "genuinely-new post stays unjudged");
});
