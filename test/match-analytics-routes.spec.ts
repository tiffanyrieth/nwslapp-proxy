// Match analytics read routes (2026-10-20): served from the saved ContentStore copies ONLY — fetchMock with
// disableNetConnect makes any ESPN/ASA call fail the test.
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import worker, { contentPut } from "../src/index";
import { buildMatchAnalytics, emptySeason, foldMatchIntoSeason } from "../src/match-analytics";
import summary from "./fixtures/summary-401854021-shots.json";
import asa from "./fixtures/asa-2026-10-17.json";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
async function get(url: string): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new IncomingRequest(url), env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("match analytics routes", () => {
	it("/match-analytics serves the saved copy (shots + ASA xG) with no upstream call", async () => {
		const m = buildMatchAnalytics({ summary: summary as never, asa: asa as never, now: Date.now() })!;
		const ctx = createExecutionContext();
		await contentPut(env, ctx, [{ key: `analytics:match:${m.eventId}`, value: JSON.stringify(m) }]);
		await waitOnExecutionContext(ctx);
		const r = await get("https://a.test/match-analytics?event=401854021");
		expect(r.status).toBe(200);
		const body = (await r.json()) as { shots: unknown[]; xg: { source: string; home: number } };
		expect(body.shots.length).toBe(18);
		expect(body.xg).toMatchObject({ source: "asa", home: 1.12 });
	});

	it("a match not built yet answers 404 'pending' (the app shows its unavailable state)", async () => {
		const r = await get("https://a.test/match-analytics?event=999999");
		expect(r.status).toBe(404);
		expect(await r.json()).toMatchObject({ status: "pending" });
	});

	it("/team-analytics serves the season rollup with the club's shots for and against", async () => {
		const m = buildMatchAnalytics({ summary: summary as never, asa: asa as never, now: Date.now() })!;
		const season = foldMatchIntoSeason(emptySeason("15365", 2026), m, Date.now());
		const ctx = createExecutionContext();
		await contentPut(env, ctx, [{ key: "analytics:team:15365:2026", value: JSON.stringify(season) }]);
		await waitOnExecutionContext(ctx);
		const r = await get("https://a.test/team-analytics?team=15365&year=2026");
		expect(r.status).toBe(200);
		const body = (await r.json()) as { matches: number; shotsFor: unknown[]; shotsAgainst: unknown[]; xgFor: number };
		expect(body).toMatchObject({ matches: 1, xgFor: 1.12 });
		expect(body.shotsFor.length).toBe(13);
		expect(body.shotsAgainst.length).toBe(5);
	});
});
