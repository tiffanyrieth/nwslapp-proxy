// ESPN Core fetch chain (2026-10-21): relay first → Cloudflare direct. Core refuses Cloudflare Workers, so the
// relay (nwslapp-espn-relay on Deno Deploy) carries it; direct stays as the second link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coreFetch } from "../src/espn-core.ts";
import { fetchStatsReport, resetStatsBackoff } from "../src/bracket-engine.ts";

const CORE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/usa.nwsl/seasons/2026/types/1/athletes/7/statistics";
const RELAY = { ESPN_RELAY_URL: "https://relay.example/", ESPN_RELAY_KEY: "k" };
const statsBody = JSON.stringify({ splits: { categories: [{ name: "general", stats: [{ name: "starts", value: 4 }] }] } });

type Seen = { url: string; key: string | null };
function withFetch<T>(handler: (url: string) => Response | Promise<Response>, fn: (seen: Seen[]) => Promise<T>): Promise<T> {
	const real = globalThis.fetch;
	const seen: Seen[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		seen.push({ url, key: new Headers(init?.headers).get("x-relay-key") });
		return handler(url);
	}) as typeof fetch;
	return fn(seen).finally(() => { globalThis.fetch = real; });
}
const isRelay = (u: string) => u.startsWith("https://relay.example/");

test("relay configured + ESPN answers through it → relay only, key sent, target URL encoded", async () => {
	await withFetch(() => new Response(statsBody, { headers: { "x-relay-upstream": "200" } }), async (seen) => {
		const r = await coreFetch(RELAY, CORE);
		assert.equal(r.link, "relay");
		assert.equal(r.relayFailure, undefined);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].url, `https://relay.example/?url=${encodeURIComponent(CORE)}`);
		assert.equal(seen[0].key, "k");
	});
});

test("a 404 through the relay is ESPN's 'no stats' answer — kept, no fallback", async () => {
	await withFetch(() => new Response("{}", { status: 404, headers: { "x-relay-upstream": "404" } }), async (seen) => {
		const r = await coreFetch(RELAY, CORE);
		assert.equal(r.link, "relay");
		assert.equal(r.res.status, 404);
		assert.equal(seen.length, 1);
	});
});

test("ESPN refusing the relay too → falls to direct, and says why", async () => {
	await withFetch((u) => (isRelay(u) ? new Response("no", { status: 403, headers: { "x-relay-upstream": "403" } }) : new Response(statsBody)), async (seen) => {
		const r = await coreFetch(RELAY, CORE);
		assert.equal(r.link, "direct");
		assert.equal(r.res.status, 200);
		assert.equal(r.relayFailure, "ESPN 403 via relay");
		assert.equal(seen.length, 2);
		assert.equal(seen[1].url, CORE);
	});
});

test("the relay itself failing (bad key / down / network) → direct, with the relay's own status", async () => {
	await withFetch((u) => (isRelay(u) ? new Response("unauthorized", { status: 401 }) : new Response(statsBody)), async () => {
		const r = await coreFetch(RELAY, CORE);
		assert.equal(r.link, "direct");
		assert.equal(r.relayFailure, "relay HTTP 401");
	});
	await withFetch((u) => { if (isRelay(u)) throw new Error("connection refused"); return new Response(statsBody); }, async () => {
		const r = await coreFetch(RELAY, CORE);
		assert.equal(r.link, "direct");
		assert.match(r.relayFailure ?? "", /relay connection refused/);
	});
});

test("no relay configured → direct only, no relay attempt", async () => {
	await withFetch(() => new Response(statsBody), async (seen) => {
		for (const env of [undefined, {}, { ESPN_RELAY_URL: "https://relay.example/" }]) {
			const r = await coreFetch(env, CORE);
			assert.equal(r.link, "direct");
		}
		assert.ok(seen.every((s) => !isRelay(s.url)));
	});
});

test("stats report through the relay: canary + the rest all via relay", async () => {
	resetStatsBackoff();
	await withFetch(() => new Response(statsBody, { headers: { "x-relay-upstream": "200" } }), async (seen) => {
		const r = await fetchStatsReport(["1", "2", "3", "4"], 2026, RELAY);
		assert.equal(r.failed, 0);
		assert.deepEqual(r.via, { relay: 4 });
		assert.deepEqual(r.probe, { link: "relay", result: "ok" });
		assert.equal(seen.length, 4);
	});
});

test("relay AND direct both refused → one canary pair, then back off (nothing else sent)", async () => {
	resetStatsBackoff();
	await withFetch((u) => new Response("no", { status: 403, headers: isRelay(u) ? { "x-relay-upstream": "403" } : {} }), async (seen) => {
		const r = await fetchStatsReport(Array.from({ length: 20 }, (_, i) => String(i)), 2026, RELAY);
		assert.equal(seen.length, 2); // relay + direct for the canary only
		assert.deepEqual(r.probe, { link: "direct", result: "HTTP 403" });
		assert.deepEqual(r.relayFailures, { "ESPN 403 via relay": 1 });
		assert.equal(r.failed, 20);
	});
	resetStatsBackoff();
});
