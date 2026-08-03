// Pure-logic tests for the matchday jersey source. Run with the Node test runner
// (vitest-pool-workers can't boot workerd on Node 26 — see CLAUDE.md):
//   node --test test/matchday-jersey.test.ts
//
// The two fixtures are REAL payload shapes from the specimens that motivated the feature
// (2026-08-03): Khyah Harper #34 on Houston's bench, and the San Diego pair where the league feed
// had proposed Courtnall #22 — a number that actually belongs to Lia Godfrey.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	jerseysFromSummary,
	pickMatchdayEvents,
	mergeMatchdayJerseys,
	matchdayRulings,
	resolveJerseysFromMatchday,
	type ScoreboardEvent,
	type MatchdayJersey,
} from "../src/roster-truth.ts";

/** GFC @ HOU, 2026-08-02 — the match that settles Harper. */
const HOU_SUMMARY = {
	rosters: [
		{
			team: { abbreviation: "HOU" },
			roster: [
				{ jersey: "1", starter: true, athlete: { id: "1001", displayName: "Jane Campbell" } },
				{ jersey: "34", starter: false, athlete: { id: "348028", displayName: "Khyah Harper" } },
				{ jersey: "40", starter: false, athlete: { id: "1002", displayName: "Caroline DeLisle" } },
			],
		},
		{ team: { abbreviation: "GFC" }, roster: [
			{ jersey: "7", starter: true, athlete: { id: "2001", displayName: "Someone Else" } },
		] },
	],
};

/** SD @ WAS, 2026-08-02 — Godfrey #22 (started), Courtnall #6 (bench). */
const SD_SUMMARY = {
	rosters: [
		{
			team: { abbreviation: "SD" },
			roster: [
				{ jersey: "22", starter: true, athlete: { id: "307433", displayName: "Lia Godfrey" } },
				{ jersey: "6", starter: false, athlete: { id: "368728", displayName: "Brooklyn Courtnall" } },
			],
		},
	],
};

test("reads a jersey for a SUBSTITUTE, not just the starting XI", () => {
	const m = jerseysFromSummary(HOU_SUMMARY, "401853959", "2026-08-02T00:00Z");
	// Harper was an unused sub; that is exactly the case a roster feed misses.
	assert.equal(m.get("348028")?.jersey, 34);
	assert.equal(m.get("348028")?.teamAbbr, "HOU");
});

test("cites the match it read from, and the citation passes the source-URL rule", () => {
	const m = jerseysFromSummary(HOU_SUMMARY, "401853959", "2026-08-02T00:00Z");
	const src = m.get("348028")!.source;
	assert.match(src, /^https?:\/\//);
	assert.match(src, /event=401853959/);
});

test("reads BOTH sides — a jersey is a fact about the player, not about who we asked for", () => {
	const m = jerseysFromSummary(HOU_SUMMARY, "401853959", "2026-08-02T00:00Z");
	assert.equal(m.get("2001")?.jersey, 7);
});

test("skips blank and non-numeric jerseys rather than guessing", () => {
	const m = jerseysFromSummary({ rosters: [{ team: { abbreviation: "X" }, roster: [
		{ jersey: null, athlete: { id: "a", displayName: "Blank" } },
		{ jersey: "", athlete: { id: "b", displayName: "Empty" } },
		{ jersey: "-", athlete: { id: "c", displayName: "Dash" } },
		{ jersey: "9", athlete: { id: "d", displayName: "Real" } },
	] }] }, "e", "2026-08-02T00:00Z");
	assert.deepEqual([...m.keys()], ["d"]);
});

test("survives a malformed / empty payload", () => {
	assert.equal(jerseysFromSummary(null, "e", "d").size, 0);
	assert.equal(jerseysFromSummary({}, "e", "d").size, 0);
	assert.equal(jerseysFromSummary({ rosters: [{}] }, "e", "d").size, 0);
});

test("picks only matches involving a club we have a question about, newest first", () => {
	const events: ScoreboardEvent[] = [
		{ id: "old", date: "2026-07-20T00:00Z", competitions: [{ competitors: [{ team: { abbreviation: "HOU" } }, { team: { abbreviation: "KC" } }] }] },
		{ id: "other", date: "2026-08-01T00:00Z", competitions: [{ competitors: [{ team: { abbreviation: "POR" } }, { team: { abbreviation: "UTA" } }] }] },
		{ id: "new", date: "2026-08-02T00:00Z", competitions: [{ competitors: [{ team: { abbreviation: "GFC" } }, { team: { abbreviation: "HOU" } }] }] },
	];
	assert.deepEqual(pickMatchdayEvents(events, new Set(["HOU"])).map((e) => e.id), ["new", "old"]);
});

test("respects the fetch cap — it is the subrequest BUDGET, not a preference", () => {
	const events: ScoreboardEvent[] = Array.from({ length: 30 }, (_, i) => ({
		id: `e${i}`, date: `2026-07-${String(i + 1).padStart(2, "0")}T00:00Z`,
		competitions: [{ competitors: [{ team: { abbreviation: "HOU" } }] }],
	}));
	// 6, because the verification run already spends ~39 of the free plan's 50 per-invocation
	// subrequests and the scoreboard costs 1. Raising it without redoing that arithmetic starts
	// failing whole nightly runs.
	assert.equal(pickMatchdayEvents(events, new Set(["HOU"])).length, 6);
	assert.equal(pickMatchdayEvents(events, new Set(["HOU"]), 3).length, 3);
});

test("newest match wins when a number changed mid-season", () => {
	const older = new Map<string, MatchdayJersey>([["p", { jersey: 7, teamAbbr: "HOU", date: "2026-07-01T00:00Z", source: "https://x/1" }]]);
	const newer = new Map<string, MatchdayJersey>([["p", { jersey: 9, teamAbbr: "HOU", date: "2026-08-01T00:00Z", source: "https://x/2" }]]);
	assert.equal(mergeMatchdayJerseys(new Map(older), newer).get("p")?.jersey, 9);
	// ...and the older one does NOT clobber the newer, whichever order they arrive in.
	assert.equal(mergeMatchdayJerseys(new Map(newer), older).get("p")?.jersey, 9);
});

test("rules on the jersey ONLY — never the position", () => {
	const { rulings } = matchdayRulings(
		[{ espnAthleteId: "348028", name: "Khyah Harper", teamAbbr: "HOU" }],
		jerseysFromSummary(HOU_SUMMARY, "401853959", "2026-08-02T00:00Z"),
	);
	assert.equal(rulings.length, 1);
	assert.equal(rulings[0].jersey, 34);
	assert.equal(rulings[0].position, undefined, "a teamsheet says nothing about whether she's a forward");
});

test("a player who has never dressed is left UNRESOLVED, not guessed", () => {
	const { rulings, unresolved } = matchdayRulings(
		[{ espnAthleteId: "999999", name: "Never Dressed", teamAbbr: "HOU" }],
		jerseysFromSummary(HOU_SUMMARY, "401853959", "2026-08-02T00:00Z"),
	);
	assert.equal(rulings.length, 0);
	assert.deepEqual(unresolved, ["999999"]);
});

test("SPECIMEN: Courtnall is #6, and #22 is Godfrey's — the league feed's proposal was wrong", () => {
	const m = jerseysFromSummary(SD_SUMMARY, "401853961", "2026-08-02T20:00Z");
	assert.equal(m.get("368728")?.jersey, 6, "Courtnall");
	assert.equal(m.get("307433")?.jersey, 22, "Godfrey holds the number SDP proposed for Courtnall");
});

test("costs ZERO fetches when nothing is pending", async () => {
	let calls = 0;
	const spy = async <T,>(): Promise<T | null> => { calls++; return null; };
	const r = await resolveJerseysFromMatchday([], Date.now(), spy);
	assert.equal(calls, 0);
	assert.deepEqual(r, { rulings: [], unresolved: [], matchesRead: 0 });
});

test("STOPS fetching as soon as every question is answered", async () => {
	const events: ScoreboardEvent[] = [
		{ id: "newest", date: "2026-08-02T00:00Z", competitions: [{ competitors: [{ team: { abbreviation: "HOU" } }] }] },
		{ id: "older", date: "2026-07-25T00:00Z", competitions: [{ competitors: [{ team: { abbreviation: "HOU" } }] }] },
	];
	const seen: string[] = [];
	const fake = async <T,>(url: string): Promise<T | null> => {
		seen.push(url);
		if (url.includes("scoreboard")) return { events } as T;
		return HOU_SUMMARY as T;
	};
	const r = await resolveJerseysFromMatchday(
		[{ espnAthleteId: "348028", name: "Khyah Harper", teamAbbr: "HOU" }], Date.now(), fake);
	assert.equal(r.matchesRead, 1, "answered by the newest match — no reason to read the older one");
	assert.equal(r.rulings[0].jersey, 34);
	assert.equal(seen.filter((u) => u.includes("summary")).length, 1);
});

test("keeps looking back when the newest match doesn't carry the player", async () => {
	const events: ScoreboardEvent[] = [
		{ id: "newest", date: "2026-08-02T00:00Z", competitions: [{ competitors: [{ team: { abbreviation: "SD" } }] }] },
		{ id: "older", date: "2026-07-25T00:00Z", competitions: [{ competitors: [{ team: { abbreviation: "SD" } }] }] },
	];
	const fake = async <T,>(url: string): Promise<T | null> => {
		if (url.includes("scoreboard")) return { events } as T;
		// The newest match didn't dress her; the older one did.
		return (url.includes("event=older") ? SD_SUMMARY : { rosters: [] }) as T;
	};
	const r = await resolveJerseysFromMatchday(
		[{ espnAthleteId: "368728", name: "Brooklyn Courtnall", teamAbbr: "SD" }], Date.now(), fake);
	assert.equal(r.matchesRead, 2);
	assert.equal(r.rulings[0].jersey, 6);
});

test("a dead scoreboard fetch degrades to unresolved, never throws", async () => {
	const dead = async <T,>(): Promise<T | null> => null;
	const r = await resolveJerseysFromMatchday(
		[{ espnAthleteId: "348028", name: "Khyah Harper", teamAbbr: "HOU" }], Date.now(), dead);
	assert.deepEqual(r.rulings, []);
	assert.deepEqual(r.unresolved, ["348028"]);
});
