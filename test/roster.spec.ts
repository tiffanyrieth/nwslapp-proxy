import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { athleteCount, chooseRosterServe, rosterResponse } from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// athleteCount + chooseRosterServe + rosterResponse are pure: they drive the
// /roster last-known-good fallback without any network. The live ESPN fetch +
// KV write/read + edge cache are verified end-to-end with curl (see
// scripts/health_check_roster.mjs) — the same split as the other routes.

describe("athleteCount", () => {
	it("counts a real athletes array", () => {
		expect(athleteCount({ athletes: [{ id: "1" }, { id: "2" }] })).toBe(2);
	});
	it("returns -1 when athletes is missing or not an array", () => {
		expect(athleteCount({})).toBe(-1);
		expect(athleteCount({ athletes: "nope" })).toBe(-1);
		expect(athleteCount(null)).toBe(-1);
	});
});

describe("chooseRosterServe", () => {
	const big = 27;
	it("serves live when ESPN returns a plausible squad", () => {
		expect(chooseRosterServe({ hasLive: true, liveCount: big, hasCached: true, cachedCount: 25 })).toBe("live");
	});
	it("falls back to a fuller cache when ESPN comes back implausibly small (the ACFC case)", () => {
		expect(chooseRosterServe({ hasLive: true, liveCount: 1, hasCached: true, cachedCount: 25 })).toBe("cached");
	});
	it("serves the small live payload honestly when there is no fuller cache", () => {
		expect(chooseRosterServe({ hasLive: true, liveCount: 1, hasCached: false, cachedCount: -1 })).toBe("live-small");
	});
	it("does not prefer a cache that is no fuller than live", () => {
		expect(chooseRosterServe({ hasLive: true, liveCount: 3, hasCached: true, cachedCount: 3 })).toBe("live-small");
	});
	it("serves cache when ESPN is down entirely", () => {
		expect(chooseRosterServe({ hasLive: false, liveCount: -1, hasCached: true, cachedCount: 25 })).toBe("cached");
	});
	it("reports none when there is neither live nor cache", () => {
		expect(chooseRosterServe({ hasLive: false, liveCount: -1, hasCached: false, cachedCount: -1 })).toBe("none");
	});
});

describe("rosterResponse marker injection", () => {
	it("injects proxyCachedAsOf when serving from cache", async () => {
		const body = await rosterResponse({ athletes: [{ id: "1" }], team: { color: "fff" } }, "2026-06-29T00:00:00.000Z").json();
		expect((body as { proxyCachedAsOf?: string }).proxyCachedAsOf).toBe("2026-06-29T00:00:00.000Z");
		expect((body as { team?: unknown }).team).toEqual({ color: "fff" });
	});
	it("omits the marker when serving live data", async () => {
		const body = await rosterResponse({ athletes: [{ id: "1" }] }, null).json();
		expect((body as { proxyCachedAsOf?: string }).proxyCachedAsOf).toBeUndefined();
	});
});

describe("/roster route guard", () => {
	it("400s when ?team is missing", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(new IncomingRequest("https://proxy.test/roster"), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
	});
});
