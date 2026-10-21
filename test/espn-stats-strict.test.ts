// ESPN per-athlete stats failure handling (2026-10-20). Every Know Her Game pick vanished on 10/17 because a
// non-2xx stats response threw inside .json(), was swallowed, and read as "no stats" — so all 16 clubs looked
// exhausted. Locks: 404 = no stats (not a failure); all-failed = a thrown error WITH the reason (the strict
// variant team stats + KHG eligibility use); partial failure still passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchStatsForMany, fetchStatsForManyStrict, fetchStatsReport, resetStatsBackoff } from "../src/bracket-engine.ts";

const statsBody = JSON.stringify({ splits: { categories: [{ name: "general", stats: [{ name: "starts", value: 9 }] }] } });

function withFetch<T>(handler: (url: string) => Response, fn: () => Promise<T>): Promise<T> {
	const real = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input instanceof Request ? input.url : input))) as typeof fetch;
	return fn().finally(() => { globalThis.fetch = real; });
}

test("a 404 'No stats found' is an empty stat line, not a failure", async () => {
	await withFetch((u) => (u.includes("/athletes/2/") ? new Response('{"error":{"code":404}}', { status: 404 }) : new Response(statsBody)), async () => {
		const r = await fetchStatsReport(["1", "2"], 2026);
		assert.equal(r.failed, 0);
		assert.deepEqual(r.stats.get("1"), { "general.starts": 9 });
		assert.deepEqual(r.stats.get("2"), {});
	});
});

test("every request failing → strict THROWS with the reason; lenient returns an empty map", async () => {
	resetStatsBackoff();
	await withFetch(() => new Response("<html>blocked</html>", { status: 500 }), async () => {
		await assert.rejects(fetchStatsForManyStrict(["1", "2", "3"], 2026), /unreachable 0\/3 \(HTTP 500×3\)/);
		assert.equal((await fetchStatsForMany(["1", "2", "3"], 2026)).size, 0);
	});
	resetStatsBackoff();
});

test("a partial failure still passes strict — those players just lack stats", async () => {
	resetStatsBackoff();
	await withFetch((u) => (u.includes("/athletes/3/") ? new Response("x", { status: 429 }) : new Response(statsBody)), async () => {
		const s = await fetchStatsForManyStrict(["1", "2", "3"], 2026);
		assert.equal(s.size, 2);
	});
});

test("no ids → nothing to fetch, no throw", async () => {
	assert.equal((await fetchStatsForManyStrict([], 2026)).size, 0);
});

test("a refused canary backs off: ONE request, the rest isn't sent, and the next call fetches nothing", async () => {
	resetStatsBackoff();
	let calls = 0;
	await withFetch(() => { calls++; return new Response("blocked", { status: 403 }); }, async () => {
		const ids = Array.from({ length: 28 }, (_, i) => String(i + 1));
		await assert.rejects(fetchStatsForManyStrict(ids, 2026), /HTTP 403×1 .*backoff \(not sent\)×27/);
		assert.equal(calls, 1); // one probe after a block, never a batch (owner 2026-10-20)
		await assert.rejects(fetchStatsForManyStrict(ids, 2026), /backoff \d+m×28/);
		assert.equal(calls, 1); // nothing sent inside the window
	});
	resetStatsBackoff();
});

test("the canary is reported (link + result) so every probe is on record", async () => {
	resetStatsBackoff();
	await withFetch(() => new Response(statsBody), async () => {
		const r = await fetchStatsReport(["1", "2", "3"], 2026);
		assert.deepEqual(r.probe, { link: "direct", result: "ok" });
		assert.deepEqual(r.via, { direct: 3 });
	});
});
