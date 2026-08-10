// The proxyAndCache RECOVERY LADDER (2026-08-10), proven end-to-end with mocked ESPN outbound
// fetches. Why this file breaks the "route guards only" convention of index.spec.ts: the ladder
// only executes during a real ESPN failure, which live curl verification can't produce on demand —
// fetchMock is the ONLY way to prove the 502→retry→snapshot chain deterministically.
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	fetchMock,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ESPN = "https://site.api.espn.com";
const SB_PATH = "/apis/site/v2/sports/soccer/usa.nwsl/scoreboard";

const scoreboardBody = JSON.stringify({ events: [] });

/** Drive the worker with waitUntil completion (the snapshot write rides ctx.waitUntil). */
async function get(url: string): Promise<Response> {
	const request = new IncomingRequest(url);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe("proxyAndCache recovery ladder", () => {
	it("step 1: a failed _cb recompute recovers via one un-busted retry", async () => {
		// The busted fetch (what ESPN chokes on under live load) 502s…
		fetchMock
			.get(ESPN)
			.intercept({ path: (p) => p.startsWith(SB_PATH) && p.includes("_cb=") })
			.reply(502, "espn recompute failed");
		// …the un-busted retry answers from ESPN's own cache.
		fetchMock
			.get(ESPN)
			.intercept({ path: (p) => p.startsWith(SB_PATH) && !p.includes("_cb=") })
			.reply(200, scoreboardBody, { headers: { "Content-Type": "application/json" } });

		const res = await get("https://proxy.test/scoreboard?dates=20260810&limit=500");
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Proxy-Cache")).toBe("MISS");
		expect(await res.text()).toBe(scoreboardBody);
	});

	it("steps 3-4: a hard ESPN outage serves the last-known-good snapshot, and only 502s bare", async () => {
		// No snapshot yet + total outage (busted AND retry fail) → the caller sees the 502.
		fetchMock
			.get(ESPN)
			.intercept({ path: (p) => p.startsWith(SB_PATH) })
			.reply(502, "down")
			.times(2); // busted attempt + un-busted retry
		const bare = await get("https://proxy.test/scoreboard?dates=20260810&limit=500&_cb=1");
		expect(bare.status).toBe(502);

		// One successful (busted) fetch writes the snapshot under the normalized key…
		fetchMock
			.get(ESPN)
			.intercept({ path: (p) => p.startsWith(SB_PATH) })
			.reply(200, scoreboardBody, { headers: { "Content-Type": "application/json" } });
		const warm = await get("https://proxy.test/scoreboard?dates=20260810&limit=500&_cb=2");
		expect(warm.status).toBe(200);

		// …then a total outage on a NEW busted URL (unique edge key → no HIT, no stale copy)
		// still returns data: the snapshot, marked STALE, with the short 30s client TTL.
		fetchMock
			.get(ESPN)
			.intercept({ path: (p) => p.startsWith(SB_PATH) })
			.reply(502, "down")
			.times(2);
		const snap = await get("https://proxy.test/scoreboard?dates=20260810&limit=500&_cb=3");
		expect(snap.status).toBe(200);
		expect(snap.headers.get("X-Proxy-Cache")).toBe("STALE");
		expect(snap.headers.get("Cache-Control")).toBe("public, max-age=30");
		expect(await snap.text()).toBe(scoreboardBody);
	});
});
