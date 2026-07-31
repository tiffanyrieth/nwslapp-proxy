import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, {
	athleteCount,
	chooseRosterServe,
	rosterResponse,
	rosterNames,
	rosterCacheRefreshDecision,
	ROSTER_CONTINUITY_MIN,
} from "../src/index";

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

// The continuity guard protects the last-known-good copy from being overwritten by a
// well-formed WRONG roster — the failure the size floor structurally cannot see, since a
// substituted squad is plausibly sized. Fixtures mirror real shapes: normal week-to-week
// churn (a signing + a departure) vs a wholesale substitution.
const squad = (names: string[]) => ({ athletes: names.map((displayName, i) => ({ id: String(i), displayName })) });

const TRUSTED = squad([
	"Aubrey Kingsbury", "Sandy MacIver", "Gabrielle Carle", "Casey Krueger", "Rebeca Bernal",
	"Tara Rudd", "Esme Morgan", "Kate Wiesner", "Andi Sullivan", "Leicy Santos",
	"Hal Hershfelt", "Deborah Abiodun", "Paige Metayer", "Ashley Hatch", "Trinity Rodman",
	"Sofia Cantore", "Gift Monday", "Rosemonde Kouassi", "Claudia Martínez", "Tamara Bolt",
]);

describe("rosterNames", () => {
	it("normalizes so accent drift between fetches is not read as churn", () => {
		expect(rosterNames(squad(["Claudia Martínez"]))).toEqual(rosterNames(squad(["Claudia Martinez"])));
		expect(rosterNames(squad(["Lo'eau LaBonta"]))).toEqual(["lo eau labonta"]);
	});
	it("returns an empty list for a malformed body and skips nameless athletes", () => {
		expect(rosterNames(null)).toEqual([]);
		expect(rosterNames({ athletes: "nope" })).toEqual([]);
		expect(rosterNames({ athletes: [{ id: "1" }] })).toEqual([]);
	});
});

describe("rosterCacheRefreshDecision", () => {
	it("bootstraps when there is no cached copy to compare against", () => {
		expect(rosterCacheRefreshDecision(TRUSTED, null).refresh).toBe(true);
		expect(rosterCacheRefreshDecision(TRUSTED, { athletes: [] }).refresh).toBe(true);
	});

	it("accepts normal churn - a departure and two new signings", () => {
		const names = TRUSTED.athletes.map((a) => a.displayName).slice(0, 19);
		const next = squad([...names, "Monique Ngock", "Mélissa Bethi"]);
		const { refresh, overlap } = rosterCacheRefreshDecision(next, TRUSTED);
		expect(refresh).toBe(true);
		expect(overlap).toBeGreaterThan(0.9);
	});

	it("REFUSES a plausibly-sized roster that shares no players with the trusted copy", () => {
		// The contamination case: right shape, right size, entirely wrong humans.
		const contaminated = squad([
			"Aaron Judge", "Gunnar Henderson", "Adley Rutschman", "Anthony Santander", "Cedric Mullins",
			"Ryan Mountcastle", "Jordan Westburg", "Colton Cowser", "Austin Hays", "Ramón Urías",
			"Grayson Rodriguez", "Kyle Bradish", "Dean Kremer", "Félix Bautista", "Yennier Cano",
			"Craig Kimbrel", "Danny Coulombe", "Cole Irvin", "Jacob Webb", "Keegan Akin",
		]);
		const { refresh, overlap } = rosterCacheRefreshDecision(contaminated, TRUSTED);
		expect(refresh).toBe(false);
		expect(overlap).toBe(0);
	});

	it("refuses a half-substituted squad but accepts one at the threshold", () => {
		const kept = TRUSTED.athletes.map((a) => a.displayName);
		const atThreshold = squad([...kept.slice(0, 10), "X A", "X B", "X C", "X D", "X E", "X F", "X G", "X H", "X I", "X J"]);
		expect(rosterCacheRefreshDecision(atThreshold, TRUSTED).overlap).toBe(ROSTER_CONTINUITY_MIN);
		expect(rosterCacheRefreshDecision(atThreshold, TRUSTED).refresh).toBe(true); // inclusive: >= not >

		const belowThreshold = squad([...kept.slice(0, 9), "X A", "X B", "X C", "X D", "X E", "X F", "X G", "X H", "X I", "X J", "X K"]);
		expect(rosterCacheRefreshDecision(belowThreshold, TRUSTED).refresh).toBe(false);
	});

	it("refuses an empty live payload against a full cache (overlap 0, not a divide-by-zero)", () => {
		const { refresh, overlap } = rosterCacheRefreshDecision({ athletes: [] }, TRUSTED);
		expect(refresh).toBe(false);
		expect(overlap).toBe(0);
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
