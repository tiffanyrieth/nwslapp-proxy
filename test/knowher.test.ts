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
		age: null, country: null,
		starts, minutes, appearances: Math.max(starts, minutes > 0 ? 1 : 0),
		goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, cleanSheets: 0, saves: 0, ...over,
	};
}

test("gate: starters always eligible; non-starters need ≥100 min; unplayed & sub-threshold drop", () => {
	const out = rankEligible([
		p("starter", 5, 400),
		p("starter-lowmin", 1, 80), // STARTED a match but <100 total min → still eligible (starters always in)
		p("supersub", 0, 120), // 0 starts but ≥100 min → kept (season-tail tier)
		p("filler", 0, 45), // 0 starts, <100 min → dropped (roster filler)
		p("unplayed", 0, 0), // never played → dropped
	]);
	assert.deepEqual(out.map((x) => x.athleteId), ["starter", "starter-lowmin", "supersub"]);
});

test("100-minute threshold: exactly 100 stays, 99 drops (non-starters), a low-min starter stays", () => {
	const out = rankEligible([
		p("start-80", 2, 80), // started 2 → eligible despite <100 min
		p("sub-99", 0, 99), // never started, just under the floor → dropped
		p("sub-100", 0, 100), // never started, exactly 100 → kept
	]);
	assert.deepEqual(out.map((x) => x.athleteId), ["start-80", "sub-100"]);
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
	const roster = [p("s1", 10, 900), p("s2", 7, 700), p("sub-hi", 0, 250), p("sub-lo", 0, 150)];
	// Both starters featured → only the (≥100-min) supersubs remain, ranked by minutes.
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

// ── isoWeekKey: the weekKey convention (Mon-start ISO week, "YYYY-Www") ─────────────────────────
// TWO implementations exist on purpose (the Worker's staleness check in src/knowher.ts and the
// assembler's in scripts/assemble_knowher_prompt.mjs — a Node script can't import Worker code paths
// at runtime). This suite runs BOTH against the same cases so they can never drift apart.

import { isoWeekKey as tsWeek } from "../src/knowher.ts";
import { isoWeekKey as mjsWeek } from "../scripts/assemble_knowher_prompt.mjs";

const WEEK_CASES = [
	["2026-07-13", "2026-W29"], // a Monday mid-season (this build's live-verified assembly run)
	["2026-07-19", "2026-W29"], // the Sunday of the same ISO week — same key all week
	["2026-07-20", "2026-W30"], // next Monday rolls the key
	["2026-01-01", "2026-W01"], // 2026-01-01 is a Thursday → W01
	["2026-12-28", "2026-W53"], // a Monday; 2026 has 53 ISO weeks
	["2027-01-01", "2026-W53"], // Friday of that same week → still the PRIOR iso-year's W53
	["2024-12-30", "2025-W01"], // a Monday belonging to the NEXT iso-year's W01
	["2025-01-05", "2025-W01"], // …and its Sunday
];

for (const [iso, want] of WEEK_CASES) {
	test(`isoWeekKey(${iso}) = ${want} in both implementations`, () => {
		const d = new Date(`${iso}T12:00:00Z`);
		assert.equal(tsWeek(d), want, "src/knowher.ts");
		assert.equal(mjsWeek(d), want, "scripts/assemble_knowher_prompt.mjs");
	});
}

// ── Biweekly cadence gate (assembler self-gate) ─────────────────────────────────
import { isKnowHerWeek, SEASON_ANCHOR } from "../scripts/assemble_knowher_prompt.mjs";

test("SEASON_ANCHOR: the committed anchor puts Week 1 (season opener week) on Know Her Game", () => {
	// 2026 opener = Fri 2026-03-13 → Week 1 is the week of Mon 2026-03-09.
	assert.equal(SEASON_ANCHOR, "2026-03-09");
	assert.equal(isKnowHerWeek(new Date(Date.UTC(2026, 2, 9)), SEASON_ANCHOR), true, "Week 1 (Mar 9) = KHG");
	assert.equal(isKnowHerWeek(new Date(Date.UTC(2026, 2, 13)), SEASON_ANCHOR), true, "opener day (Mar 13) is in Week 1");
	assert.equal(isKnowHerWeek(new Date(Date.UTC(2026, 2, 16)), SEASON_ANCHOR), false, "Week 2 (Mar 16) = Trivia");
});

test("isKnowHerWeek: alternates from the season anchor — Week 1 KHG, Week 2 Trivia, …", () => {
	const anchor = "2026-03-23"; // Monday of regular-season Week 1
	const mon = (n: number) => new Date(Date.UTC(2026, 2, 23) + n * 7 * 86_400_000);
	assert.equal(isKnowHerWeek(mon(0), anchor), true, "Week 1 = KHG");
	assert.equal(isKnowHerWeek(mon(1), anchor), false, "Week 2 = Trivia");
	assert.equal(isKnowHerWeek(mon(2), anchor), true, "Week 3 = KHG");
	assert.equal(isKnowHerWeek(mon(5), anchor), false, "Week 6 = Trivia");
	assert.equal(isKnowHerWeek(new Date(Date.UTC(2026, 2, 26)), anchor), true, "any day within Week 1 is a KHG week");
});

test("isKnowHerWeek: pre-anchor weeks are off; unset/invalid anchor fails open to weekly", () => {
	assert.equal(isKnowHerWeek(new Date(Date.UTC(2026, 2, 16)), "2026-03-23"), false, "the week before Week 1");
	assert.equal(isKnowHerWeek(new Date(Date.UTC(2026, 5, 1)), undefined), true, "no anchor → generate (fail-open)");
	assert.equal(isKnowHerWeek(new Date(Date.UTC(2026, 5, 1)), "not-a-date"), true, "bad anchor → generate (fail-open)");
});
