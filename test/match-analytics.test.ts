// Match analytics (2026-10-20, src/match-analytics.ts): shot maps from the ESPN summary we already download,
// xG from American Soccer Analysis with our own estimate as the second source, season rollups, heat grids.
// Fixtures are REAL: GFC @ WAS 2026-10-17 (ESPN 401854021, trimmed) + that day's ASA rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	shotsFromSummary, shotOutcome, estimateXg, buildMatchAnalytics, asaTeamIdFor, asaGameFor, matchTeams,
	emptySeason, foldMatchIntoSeason, heatGrids, HEAT_COLS, HEAT_ROWS, PENALTY_XG,
} from "../src/match-analytics.ts";

const summary = JSON.parse(readFileSync(new URL("./fixtures/summary-401854021-shots.json", import.meta.url), "utf8"));
const asa = JSON.parse(readFileSync(new URL("./fixtures/asa-2026-10-17.json", import.meta.url), "utf8"));

test("every shot comes out of the summary we already download — 18, matching the box score (WAS 13, GFC 5)", () => {
	const shots = shotsFromSummary(summary);
	assert.equal(shots.length, 18);
	assert.equal(shots.filter((s) => s.teamId === "15365").length, 13);
	assert.equal(shots.filter((s) => s.teamId === "15364").length, 5);
	assert.equal(shots.filter((s) => s.outcome === "goal").length, 1);
});

test("coordinates are already oriented: both teams attack x = 100 (never flipped)", () => {
	for (const s of shotsFromSummary(summary)) assert.ok(s.x >= 60, `${s.teamId} shot at x=${s.x}`);
});

test("every shooter resolves to an ESPN athlete id through the summary's own rosters", () => {
	const shots = shotsFromSummary(summary);
	assert.equal(shots.filter((s) => !s.athleteId).length, 0);
	const goal = shots.find((s) => s.outcome === "goal")!;
	assert.equal(goal.minute, "70'");
});

test("goal types include headers/volleys; own goals are not shots", () => {
	assert.equal(shotOutcome("Goal - Header"), "goal");
	assert.equal(shotOutcome("Goal - Volley"), "goal");
	assert.equal(shotOutcome("Penalty - Saved"), "onTarget");
	assert.equal(shotOutcome("Own Goal"), null);
	assert.equal(shotOutcome("Foul"), null);
});

test("the estimate: close range beats long range, headers lower, penalties fixed", () => {
	const near = estimateXg({ x: 94, y: 50, penalty: false, bodyPart: "right" });
	const far = estimateXg({ x: 72, y: 50, penalty: false, bodyPart: "right" });
	const head = estimateXg({ x: 94, y: 50, penalty: false, bodyPart: "head" });
	assert.ok(near > far && near > head);
	assert.equal(estimateXg({ x: 88.6, y: 50, penalty: true, bodyPart: "right" }), PENALTY_XG);
});

test("ASA team + game matching: Gotham is NJY at ASA; old BOS/KC clubs don't confuse it", () => {
	const m = matchTeams(summary)!;
	assert.ok(asaTeamIdFor(m.home, asa.teams));
	assert.ok(asaTeamIdFor(m.away, asa.teams));
	assert.equal(asaGameFor(m, asa.games, asa.teams)?.game_id, "Oa5wPGp9q1");
});

test("with ASA: team xG is ASA's (WAS 1.12 – GFC 0.41) and player lines carry ASA xG/xA/key passes", () => {
	const a = buildMatchAnalytics({ summary, asa, now: 1 })!;
	assert.equal(a.xg.source, "asa");
	assert.equal(a.xg.home, 1.12);
	assert.equal(a.xg.away, 0.41);
	assert.equal(a.asaRetryAfter, null);
	const asaLines = a.players.filter((p) => p.source === "asa");
	assert.ok(asaLines.length >= 10, `${asaLines.length} ASA-matched players`);
	assert.ok(asaLines.some((p) => (p.keyPasses ?? 0) > 0));
});

test("without ASA (down / not posted yet): our estimate fills in, labelled, with a retry scheduled", () => {
	const a = buildMatchAnalytics({ summary, asa: null, now: 1000 })!;
	assert.equal(a.xg.source, "estimate");
	assert.ok(a.xg.home > a.xg.away); // WAS out-shot GFC 13-5
	assert.ok(a.xg.home > 0.5 && a.xg.home < 2.5, `est ${a.xg.home}`);
	assert.ok(a.asaRetryAfter! > 1000);
	assert.ok(a.players.every((p) => p.source === "estimate"));
	// xA (est.): 13 of the 18 shots name the passer who set them up → credited to her.
	const kp = a.players.reduce((n, p) => n + (p.keyPasses ?? 0), 0);
	assert.equal(kp, 13);
	assert.ok(a.players.some((p) => p.shots === 0 && (p.xa ?? 0) > 0), "a creator who never shot still gets a line");
	assert.equal(a.heatStatus, "pending");
});

test("season rollup: folding is idempotent, and ASA replacing an estimate a day later never double-counts", () => {
	const est = buildMatchAnalytics({ summary, asa: null, now: 1 })!;
	const real = buildMatchAnalytics({ summary, asa, now: 2 })!;
	let was = foldMatchIntoSeason(emptySeason("15365", 2026), est, 1);
	was = foldMatchIntoSeason(was, est, 1);
	assert.equal(was.matches, 1);
	assert.equal(was.contributions[0].shotsFor.length, 13);
	assert.equal(was.contributions[0].shotsAgainst.length, 5);
	was = foldMatchIntoSeason(was, real, 2);
	assert.equal(was.matches, 1);
	assert.equal(was.xgFor, 1.12);
	assert.deepEqual(was.xgSources, { asa: 1, estimate: 0 });
	const other = foldMatchIntoSeason(emptySeason("99999", 2026), real, 2);
	assert.equal(other.matches, 0); // not that club's match
});

test("heat grids: one cell count per located touch, credited to the acting player", () => {
	const g = heatGrids([
		{ fieldPositionX: 5, fieldPositionY: 5, participants: [{ athlete: { $ref: "http://x/athletes/42?lang=en" } }] },
		{ fieldPositionX: 99, fieldPositionY: 99, participants: [{ athlete: { $ref: "http://x/athletes/42" } }] },
		{ fieldPositionX: null, fieldPositionY: null, participants: [{ athlete: { $ref: "http://x/athletes/42" } }] },
		{ fieldPositionX: 50, fieldPositionY: 50, participants: [] },
	]);
	assert.deepEqual(Object.keys(g), ["42"]);
	assert.equal(g["42"].length, HEAT_COLS * HEAT_ROWS);
	assert.equal(g["42"].reduce((a, b) => a + b, 0), 2);
	assert.equal(g["42"][0], 1);
	assert.equal(g["42"][HEAT_COLS * HEAT_ROWS - 1], 1);
});

test("season heat: each club gets only its own players' grids, summed across matches", () => {
	const rosters = summary.rosters as { team: { id: string }; roster: { athlete: { id: string } }[] }[];
	const wasPlayer = rosters.find((r) => r.team.id === "15365")!.roster[0].athlete.id;
	const gfcPlayer = rosters.find((r) => r.team.id === "15364")!.roster[0].athlete.id;
	const grid = (n: number) => { const g = new Array(HEAT_COLS * HEAT_ROWS).fill(0); g[0] = n; return g; };
	const m = buildMatchAnalytics({ summary, asa, heat: { [wasPlayer]: grid(3), [gfcPlayer]: grid(5) }, now: 1 })!;
	assert.equal(m.heatStatus, "ok");
	const was = foldMatchIntoSeason(emptySeason("15365", 2026), m, 1);
	assert.deepEqual(Object.keys(was.heat), [wasPlayer]);
	assert.equal(was.heat[wasPlayer][0], 3);
	assert.equal(was.heatMatches, 1);
	const gfc = foldMatchIntoSeason(emptySeason("15364", 2026), m, 1);
	assert.deepEqual(Object.keys(gfc.heat), [gfcPlayer]);
});

test("scheduling: new matches first (newest first, capped), ONE ASA retry, heat only while Core accepts us", async () => {
	const { planAnalyticsBuilds } = await import("../src/match-analytics.ts");
	const H = 3600_000, now = 1_000 * H;
	const finals = [
		{ eventId: "old", kickoffMs: now - 50 * H },
		{ eventId: "new", kickoffMs: now - 5 * H },
		{ eventId: "tooSoon", kickoffMs: now - 2 * H },
		{ eventId: "asaDue", kickoffMs: now - 30 * H },
		{ eventId: "asaRetried", kickoffMs: now - 31 * H },
		{ eventId: "heatDue", kickoffMs: now - 40 * H },
	];
	const index = {
		asaDue: { source: "estimate" as const, asaRetryAfter: now - 1, heat: "ok" as const, builtAt: 0 },
		asaRetried: { source: "estimate" as const, asaRetryAfter: now - 1, asaRetried: true, heat: "ok" as const, builtAt: 0 },
		heatDue: { source: "asa" as const, asaRetryAfter: null, heat: "unavailable" as const, heatRetryAfter: now - 1, builtAt: 0 },
	};
	const plan = (coreBlocked: boolean, max = 10) => planAnalyticsBuilds({ finals, index, now, coreBlocked, afterKickoffMs: 4 * H, max });
	assert.deepEqual(plan(false), ["new", "asaDue", "heatDue", "old"]);
	assert.deepEqual(plan(true), ["new", "asaDue", "old"]); // Core refusing → no heat-only rebuilds
	assert.deepEqual(plan(false, 2), ["new", "asaDue"]);
});
