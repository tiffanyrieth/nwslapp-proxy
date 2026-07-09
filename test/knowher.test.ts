// Pure-logic tests for Know Her Game eligibility (docs §4). Run with the Node test runner
// (vitest-pool-workers can't boot workerd on Node 26 — see CLAUDE.md):
//   node --test test/knowher.test.ts
//
// No network: rankEligible / pickWeeklyFeatured are pure. The KV ledger + the network path
// (computeEligiblePlayers, /knowher/todo) are exercised live via wrangler dev + curl and the
// health check, not mocked here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rankEligible, pickWeeklyFeatured, type EligiblePlayer } from "../src/knowher.ts";

// Terse builder — only the fields the ranking reads matter; the rest are filler.
function p(athleteId: string, starts: number, minutes: number, over: Partial<EligiblePlayer> = {}): EligiblePlayer {
	return {
		athleteId, name: `P${athleteId}`, jersey: 1, position: "F", team: "WAS",
		starts, minutes, appearances: Math.max(starts, minutes > 0 ? 1 : 0),
		goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, ...over,
	};
}

test("gate: keeps anyone who played (starts ≥ 1 OR minutes > 0), drops the unplayed", () => {
	const out = rankEligible([
		p("starter", 5, 400),
		p("supersub", 0, 120), // 0 starts but has minutes → kept (season-tail tier)
		p("unplayed", 0, 0), // never played → dropped
	]);
	assert.deepEqual(out.map((x) => x.athleteId), ["starter", "supersub"]);
});

test("ranking: starters (starts desc, then minutes desc) rank above supersubs", () => {
	const out = rankEligible([
		p("sub-hi", 0, 300),
		p("start-lo", 3, 900),
		p("start-hi", 8, 700),
		p("start-mid-lowmin", 8, 500), // same starts as start-hi, fewer minutes → below it
	]);
	assert.deepEqual(out.map((x) => x.athleteId), ["start-hi", "start-mid-lowmin", "start-lo", "sub-hi"]);
});

test("featured exclusion: excludeIds removes players from the pool", () => {
	const out = rankEligible(
		[p("a", 10, 900), p("b", 8, 800), p("c", 6, 700)],
		new Set(["a", "c"]),
	);
	assert.deepEqual(out.map((x) => x.athleteId), ["b"]);
});

test("season-tail fallback emerges: once all starters are featured, the top pick is the highest-minutes supersub", () => {
	const roster = [p("s1", 10, 900), p("s2", 7, 700), p("sub-hi", 0, 250), p("sub-lo", 0, 90)];
	// Both starters featured → only supersubs remain, ranked by minutes.
	const out = rankEligible(roster, new Set(["s1", "s2"]));
	assert.deepEqual(out.map((x) => x.athleteId), ["sub-hi", "sub-lo"]);
	assert.equal(pickWeeklyFeatured(out)?.athleteId, "sub-hi");
});

test("tiebreak is athleteId (NOT name/A–Z) and is stable run-to-run", () => {
	// Identical starts+minutes → deterministic id order regardless of input order.
	const a = rankEligible([p("zeta", 5, 500), p("alpha", 5, 500), p("mid", 5, 500)]);
	const b = rankEligible([p("mid", 5, 500), p("zeta", 5, 500), p("alpha", 5, 500)]);
	assert.deepEqual(a.map((x) => x.athleteId), b.map((x) => x.athleteId));
	assert.deepEqual(a.map((x) => x.athleteId), ["alpha", "mid", "zeta"]);
});

test("pickWeeklyFeatured: top of the ranked pool, or null when nobody is left", () => {
	assert.equal(pickWeeklyFeatured(rankEligible([p("a", 3, 300), p("b", 9, 800)]))?.athleteId, "b");
	assert.equal(pickWeeklyFeatured(rankEligible([p("x", 0, 0)])), null); // unplayed → empty → null
});
