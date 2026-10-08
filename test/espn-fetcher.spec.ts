// The ESPN SHARED FETCHER (Option A, 2026-10-08): one ESPN copy for every data center. Proven with
// mocked ESPN outbound fetches (fetchMock), like recovery-ladder.spec.ts. Two different request HOSTS
// stand in for two data centers: the edge cache key includes the host, the shared fetcher's key doesn't —
// so a second host is an edge MISS that must be served by the fetcher without a second ESPN call.
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	fetchMock,
	runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import worker, { resetEspnFetcherSwitchMemo } from "../src/index";
import {
	fetcherKey,
	isFresh,
	edgeTtlFor,
	gzip,
	gunzip,
	FETCHER_MAX_STORED_GZIP,
	type EspnFetcher,
} from "../src/espn-fetcher";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ESPN = "https://site.api.espn.com";
const SUMMARY_PATH = "/apis/site/v2/sports/soccer/usa.nwsl/summary";
const SB_PATH = "/apis/site/v2/sports/soccer/usa.nwsl/scoreboard";
const JSON_HEADERS = { headers: { "Content-Type": "application/json" } };

async function get(url: string, e: Env = env): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new IncomingRequest(url), e, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

/** A pre-kickoff summary far in the future → a long, deterministic TTL (no live/near-kickoff path). */
function preSummary(eventId: string): string {
	return JSON.stringify({
		header: { id: eventId, competitions: [{ date: "2030-01-01T00:00Z", status: { type: { state: "pre" } } }] },
	});
}

/** An ESPN-shaped season body sized to the REAL one (2.62 MB, measured 2026-10-08). Real events carry
 *  more fields than this sketch, so it uses more events to reach the real byte size; the repetition that
 *  makes ESPN's JSON compress ~14× is the same. */
function seasonBody(events = 870): string {
	const ev = (i: number) => ({
		id: String(401850000 + i),
		date: "2026-05-01T23:00Z",
		name: `Washington Spirit at Portland Thorns FC ${i}`,
		status: { clock: 0, displayClock: "0'", period: 0, type: { id: "1", name: "STATUS_SCHEDULED", state: "pre", completed: false } },
		competitions: [{
			venue: { fullName: "Providence Park", address: { city: "Portland", state: "Oregon", country: "USA" } },
			competitors: ["home", "away"].map((ha) => ({
				homeAway: ha,
				team: {
					abbreviation: ha === "home" ? "POR" : "WAS",
					displayName: ha === "home" ? "Portland Thorns FC" : "Washington Spirit",
					logo: "https://a.espncdn.com/i/teamlogos/soccer/500/15362.png",
					links: Array.from({ length: 6 }, (_, k) => ({ rel: ["clubhouse", "desktop", "team"], href: `https://www.espn.com/soccer/team/_/id/15362/link${k}` })),
				},
				statistics: [], records: [{ summary: "8-4-6", type: "total" }],
			})),
			broadcasts: [{ market: "national", names: ["Prime Video", "ION", "CBS Sports Network"] }],
			notes: [], details: [], odds: [], tickets: [{ summary: "Tickets as low as $25", links: [{ href: "https://www.vividseats.com/x" }] }],
		}],
		links: Array.from({ length: 8 }, (_, k) => ({ rel: ["summary", "desktop", "event"], href: `https://www.espn.com/soccer/match/_/gameId/${401850000 + i}/l${k}` })),
	});
	return JSON.stringify({ leagues: [{ id: "761", name: "NWSL" }], events: Array.from({ length: events }, (_, i) => ev(i)) });
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(async () => {
	fetchMock.assertNoPendingInterceptors();
	await env.FEED_TAGS.delete("espn:fetcher:off");
	resetEspnFetcherSwitchMemo();
});

describe("shared fetcher — pure helpers", () => {
	it("keys on the ESPN URL minus the per-fetch _cb buster, params sorted; folds the lineup window bucket", () => {
		const a = fetcherKey("https://x.test/s?event=1&_cb=111&league=y");
		const b = fetcherKey("https://x.test/s?league=y&event=1&_cb=222");
		expect(a).toBe(b);
		expect(a).not.toContain("_cb");
		// `w=near` must NOT share a copy fetched before the 2h lineup window (it would mask a posted XI).
		expect(fetcherKey("https://x.test/s?event=1", "near")).not.toBe(fetcherKey("https://x.test/s?event=1"));
	});

	it("an edge copy never outlives the shared copy (live stays ≤30s), min 1s", () => {
		const now = 1_000_000;
		expect(edgeTtlFor(3600, now - 10_000, 30, now)).toBe(20); // 30s live copy, 10s old → 20s left
		expect(edgeTtlFor(30, now, 3600, now)).toBe(30); // never longer than the edge's own choice
		expect(edgeTtlFor(3600, now - 60_000, 30, now)).toBe(1); // expired → floor of 1s
		expect(isFresh(now - 29_000, 30, now)).toBe(true);
		expect(isFresh(now - 30_000, 30, now)).toBe(false);
	});

	it("the real-size 2.6 MB season compresses far under the 2 MB storage cap and round-trips byte-identical", async () => {
		const raw = new TextEncoder().encode(seasonBody()).buffer as ArrayBuffer;
		expect(raw.byteLength).toBeGreaterThan(2_000_000); // over DO storage's per-value cap uncompressed
		const gz = await gzip(raw);
		expect(gz.byteLength).toBeLessThan(FETCHER_MAX_STORED_GZIP);
		expect(gz.byteLength).toBeLessThan(raw.byteLength / 8);
		const back = new Uint8Array(await gunzip(gz));
		expect(back.byteLength).toBe(raw.byteLength);
		expect(Buffer.from(back).equals(Buffer.from(new Uint8Array(raw)))).toBe(true);
	});
});

describe("shared fetcher — through the worker", () => {
	it("two data centers share ONE ESPN fetch (the second is an edge MISS served from the shared copy)", async () => {
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SUMMARY_PATH) && p.includes("event=900001") })
			.reply(200, preSummary("900001"), JSON_HEADERS); // exactly ONE ESPN call allowed
		const a = await get("https://dc-a.test/summary?event=900001");
		const b = await get("https://dc-b.test/summary?event=900001");
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(a.headers.get("X-Proxy-Cache")).toBe("MISS");
		expect(b.headers.get("X-Proxy-Cache")).toBe("MISS"); // different edge key…
		expect(a.headers.get("X-Espn-Fetcher")).toBe("fresh");
		expect(b.headers.get("X-Espn-Fetcher")).toBe("memory"); // …same shared copy, no ESPN call
		expect(await b.text()).toBe(preSummary("900001"));
	});

	it("simultaneous misses from many data centers coalesce into ONE ESPN call", async () => {
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SUMMARY_PATH) && p.includes("event=900002") })
			.reply(200, preSummary("900002"), JSON_HEADERS);
		const all = await Promise.all(["a", "b", "c", "d"].map((dc) => get(`https://dc-${dc}.test/summary?event=900002`)));
		for (const r of all) expect(r.status).toBe(200);
	});

	it("the full-season body flows through the fetcher and is stored compressed under the cap", async () => {
		const body = seasonBody();
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SB_PATH) && p.includes("dates=2031") })
			.reply(200, body, JSON_HEADERS);
		const res = await get("https://dc-a.test/scoreboard?dates=2031&limit=1000");
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Espn-Fetcher")).toBe("fresh");
		expect((await res.text()).length).toBe(body.length);
		const stub = env.ESPN_FETCHER!.get(env.ESPN_FETCHER!.idFromName("espn"));
		await runInDurableObject(stub, async (_inst: EspnFetcher, state) => {
			const rows = state.storage.sql
				.exec<{ key: string; size: number }>("SELECT key, length(body) AS size FROM entries WHERE key LIKE '%dates=2031%'")
				.toArray();
			expect(rows.length).toBe(1);
			expect(rows[0].size).toBeLessThan(FETCHER_MAX_STORED_GZIP);
			expect(rows[0].size).toBeLessThan(body.length / 8);
		});
	});

	it("a LIVE copy is cached at the edge for no longer than the shared copy has left (≤30s)", async () => {
		const live = JSON.stringify({ events: [{ status: { type: { state: "in" } } }] });
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SB_PATH) && p.includes("dates=2032") })
			.reply(200, live, JSON_HEADERS);
		const res = await get("https://dc-a.test/scoreboard?dates=2032&limit=1000");
		const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1]);
		expect(maxAge).toBeGreaterThan(0);
		expect(maxAge).toBeLessThanOrEqual(30);
	});

	it("an ESPN failure is never cached by the fetcher — the edge recovery ladder still runs", async () => {
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SB_PATH) && p.includes("dates=2033") })
			.reply(502, "down").times(2); // busted attempt + un-busted retry, both inside the fetcher
		const res = await get("https://dc-a.test/scoreboard?dates=2033&limit=1000");
		expect(res.status).toBe(200); // scoreboard never 502s: the ladder's floor answers
		expect(res.headers.get("X-Proxy-Cache")).toBe("STALE");
		// Recovery: the next read reaches ESPN again (nothing bad was cached).
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SB_PATH) && p.includes("dates=2033") })
			.reply(200, JSON.stringify({ events: [] }), JSON_HEADERS);
		const ok = await get("https://dc-b.test/scoreboard?dates=2033&limit=1000");
		expect(ok.headers.get("X-Proxy-Cache")).toBe("MISS");
	});

	it("the match watcher (host `proxy`) and `_lc` reads bypass the fetcher — every read reaches ESPN", async () => {
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SUMMARY_PATH) && p.includes("event=900003") })
			.reply(200, preSummary("900003"), JSON_HEADERS).times(2);
		const w1 = await get("https://proxy/summary?event=900003&_lc=1");
		const w2 = await get("https://proxy/summary?event=900003&_lc=2");
		expect(w1.headers.get("X-Espn-Fetcher")).toBe("bypass");
		expect(w2.headers.get("X-Espn-Fetcher")).toBe("bypass");
		// `_lc` alone (any host) also bypasses.
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SUMMARY_PATH) && p.includes("event=900004") })
			.reply(200, preSummary("900004"), JSON_HEADERS);
		const lc = await get("https://dc-a.test/summary?event=900004&_lc=9");
		expect(lc.headers.get("X-Espn-Fetcher")).toBe("bypass");
	});

	it("the kill switch (KV espn:fetcher:off) sends app reads back to the direct path", async () => {
		await env.FEED_TAGS.put("espn:fetcher:off", "1");
		resetEspnFetcherSwitchMemo();
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SUMMARY_PATH) && p.includes("event=900005") })
			.reply(200, preSummary("900005"), JSON_HEADERS).times(2); // two data centers → two ESPN calls
		const a = await get("https://dc-a.test/summary?event=900005");
		const b = await get("https://dc-b.test/summary?event=900005");
		expect(a.headers.get("X-Espn-Fetcher")).toBe("bypass");
		expect(b.headers.get("X-Espn-Fetcher")).toBe("bypass");
	});

	it("if the fetcher is unavailable, the edge falls back to its own direct ESPN fetch", async () => {
		const broken = {
			idFromName: () => ({}),
			get: () => ({ fetchShared: async () => { throw new Error("boom"); } }),
		};
		const e = { ...env, ESPN_FETCHER: broken } as unknown as Env;
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SUMMARY_PATH) && p.includes("event=900006") })
			.reply(200, preSummary("900006"), JSON_HEADERS);
		const res = await get("https://dc-a.test/summary?event=900006", e);
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Espn-Fetcher")).toBe("fallback");
		expect(await res.text()).toBe(preSummary("900006"));
	});

	it("a body too big to store compressed is still served — memory-only, shared across data centers", async () => {
		// Random base64 barely compresses → over FETCHER_MAX_STORED_GZIP after gzip.
		const bytes = new Uint8Array(1_700_000);
		for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
		const pad = Buffer.from(bytes).toString("base64");
		const big = JSON.stringify({ events: [], pad });
		fetchMock.get(ESPN).intercept({ path: (p) => p.startsWith(SB_PATH) && p.includes("dates=2034") })
			.reply(200, big, JSON_HEADERS); // ONE ESPN call for both data centers
		const a = await get("https://dc-a.test/scoreboard?dates=2034&limit=1000");
		const b = await get("https://dc-b.test/scoreboard?dates=2034&limit=1000");
		expect(a.status).toBe(200);
		expect(b.headers.get("X-Espn-Fetcher")).toBe("memory");
		expect((await b.text()).length).toBe(big.length);
		const stub = env.ESPN_FETCHER!.get(env.ESPN_FETCHER!.idFromName("espn"));
		await runInDurableObject(stub, async (_inst: EspnFetcher, state) => {
			const n = state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM entries WHERE key LIKE '%dates=2034%'").one().n;
			expect(n).toBe(0); // memory-only
		});
	});
});
