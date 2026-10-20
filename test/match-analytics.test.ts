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
	assert.ok(a.asaRetryAfter, "xG without the g+ depth → ASA is asked again");
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
		asaDue: { source: "estimate" as const, asaRetryAfter: now - 1, heat: "ok" as const, builtAt: 0, v: 2 },
		asaRetried: { source: "estimate" as const, asaRetryAfter: now - 1, asaRetries: 2, heat: "ok" as const, builtAt: 0, v: 2 },
		heatDue: { source: "asa" as const, asaRetryAfter: null, heat: "unavailable" as const, heatRetryAfter: now - 1, builtAt: 0, v: 2 },
	};
	const plan = (coreBlocked: boolean, max = 10) => planAnalyticsBuilds({ finals, index, now, coreBlocked, afterKickoffMs: 4 * H, max });
	assert.deepEqual(plan(false), ["new", "asaDue", "heatDue", "old"]);
	assert.deepEqual(plan(true), ["new", "asaDue", "old"]); // Core refusing → no heat-only rebuilds
	assert.deepEqual(plan(false, 2), ["new", "asaDue"]);
});


// ── Phase 2: every position (ASA depth + ESPN Core extras) ────────────────────────────────────────
const core = JSON.parse(readFileSync(new URL("./fixtures/core-plays-401854021-trim.json", import.meta.url), "utf8"));
const depth = () => ({
	shots: asa.gameShots.Oa5wPGp9q1,
	gkXg: asa.gkXg, playerGplus: asa.playerGplus, gkGplus: asa.gkGplus, xpass: asa.playerXpass,
});
const nameOf = (id: string) => (summary.rosters as { roster: { athlete: { id: string; displayName: string } }[] }[])
	.flatMap((r) => r.roster).find((p) => p.athlete.id === id)?.athlete.displayName;

test("ASA per-shot rows join ours by location: 18/18, and their xG sums to ASA's team totals", async () => {
	const { joinAsaShots } = await import("../src/match-analytics.ts");
	const joined = joinAsaShots(shotsFromSummary(summary), asa.gameShots.Oa5wPGp9q1);
	assert.equal(joined.filter((s) => s.xgAsa != null).length, 18);
	const sum = (tid: string) => Math.round(joined.filter((s) => s.teamId === tid).reduce((n, s) => n + (s.xgAsa ?? 0), 0) * 100) / 100;
	assert.equal(sum("15365"), 1.12);
	assert.equal(sum("15364"), 0.41);
	// post-shot xG only on target; situation from ASA's pattern of play
	assert.ok(joined.every((s) => (s.outcome === "goal" || s.outcome === "onTarget") ? s.psxg != null : s.psxg === null));
	assert.equal(joined.filter((s) => s.situation === "corner").length, 2);
});

test("keepers: shots faced, saves and goals prevented per match (Berger +0.14)", () => {
	const m = buildMatchAnalytics({ summary, asa, asaDepth: depth(), now: 1 })!;
	assert.equal(m.v, 2);
	assert.equal(m.keepers!.length, 2);
	const berger = m.keepers!.find((k) => nameOf(k.athleteId) === "Ann-Katrin Berger")!;
	assert.equal(berger.teamId, "15364");
	assert.equal(berger.saves, 5);
	assert.equal(berger.goalsConceded, 1);
	assert.equal(berger.goalsPrevented, 0.141);
	assert.ok(berger.gplus?.Shotstopping);
});

test("goals added (g+) for every outfield player, six actions each; passing vs expected", () => {
	const m = buildMatchAnalytics({ summary, asa, asaDepth: depth(), now: 1 })!;
	assert.ok(m.gplus!.length >= 25, `${m.gplus!.length} g+ lines`);
	assert.ok(m.gplus!.every((g) => Object.keys(g.actions).length === 6 && ["15365", "15364"].includes(g.teamId)));
	assert.ok(m.gplus!.some((g) => (g.actions.Interrupting?.count ?? 0) > 0), "defenders' tackles/clearances counted");
	assert.ok(m.xpass!.length >= 25);
	assert.ok(m.xpass!.every((x) => x.attempted > 0 && x.completionPct <= 1));
});

test("ESPN Core extras (dormant while blocked): defensive actions per player + ESPN's per-shot xG / xGOT / height", async () => {
	const { defenseFromCore, coreShots, joinCoreShots } = await import("../src/match-analytics.ts");
	const def = defenseFromCore(core.items);
	const all = Object.values(def).flat();
	const n = (k: string) => all.filter((a) => a.kind === k).length;
	assert.deepEqual([n("tackle"), n("tackleLost"), n("interception"), n("clearance"), n("block")], [35, 27, 21, 44, 20]);
	const cs = coreShots(core.items);
	const joined = joinCoreShots(shotsFromSummary(summary), cs);
	const first = joined[0]; // Luvanga 4', missed left
	assert.equal(first.xgEspn, 0.078);
	assert.equal(first.xgotEspn, 0);
	assert.equal(first.goalZ, 22.2);
	assert.ok(joined.filter((s) => s.xgEspn != null).length >= 17);
});

test("season: keepers, g+ (+ team total), passing and defense roll up and stay idempotent", async () => {
	const { defenseFromCore } = await import("../src/match-analytics.ts");
	const m = buildMatchAnalytics({ summary, asa, asaDepth: depth(), core: { defense: defenseFromCore(core.items) }, now: 1 })!;
	let gfc = foldMatchIntoSeason(emptySeason("15364", 2026), m, 1);
	gfc = foldMatchIntoSeason(gfc, m, 2);
	assert.equal(gfc.matches, 1);
	assert.equal(gfc.keepers.length, 1);
	assert.equal(gfc.keepers[0].goalsPrevented, 0.141);
	assert.ok(gfc.gplus.length >= 12 && gfc.gplusMatches === 1);
	assert.equal(gfc.teamGplus, Math.round(gfc.gplus.reduce((n, g) => n + g.raw, 0) * 1000) / 1000);
	assert.ok(gfc.xpass.length >= 12);
	assert.ok(Object.keys(gfc.defense).length >= 10 && gfc.defenseMatches === 1);
	// defense split per club: no WAS player in GFC's season
	const wasIds = new Set((summary.rosters as { team: { id: string }; roster: { athlete: { id: string } }[] }[]).find((r) => r.team.id === "15365")!.roster.map((p) => p.athlete.id));
	assert.ok(Object.keys(gfc.defense).every((id) => !wasIds.has(id)));
});

test("planner: a v1 copy is rebuilt once to v2 (keepers / g+ / per-shot ASA xG)", async () => {
	const { planAnalyticsBuilds } = await import("../src/match-analytics.ts");
	const H = 3600_000, now = 1_000 * H;
	const finals = [{ eventId: "old", kickoffMs: now - 50 * H }, { eventId: "done", kickoffMs: now - 60 * H }];
	const index = {
		old: { source: "asa" as const, asaRetryAfter: null, heat: "ok" as const, builtAt: 0 },
		done: { source: "asa" as const, asaRetryAfter: null, heat: "ok" as const, builtAt: 0, v: 2 },
	};
	assert.deepEqual(planAnalyticsBuilds({ finals, index, now, coreBlocked: true, afterKickoffMs: 4 * H, max: 10 }), ["old"]);
});


test("ASA retries: up to twice (2h–33h lag measured), then stop; a complete copy schedules none", async () => {
	const { planAnalyticsBuilds, MAX_ASA_RETRIES } = await import("../src/match-analytics.ts");
	assert.equal(MAX_ASA_RETRIES, 2);
	const H = 3600_000, now = 1_000 * H;
	const finals = [{ eventId: "a", kickoffMs: now - 30 * H }, { eventId: "b", kickoffMs: now - 60 * H }, { eventId: "c", kickoffMs: now - 70 * H }];
	const ix = (asaRetries: number | undefined, legacy?: boolean) => ({ source: "asa" as const, asaRetryAfter: now - 1, heat: "ok" as const, builtAt: 0, v: 2, asaRetries, ...(legacy ? { asaRetried: true } : {}) });
	const index = { a: ix(undefined), b: ix(1, true), c: ix(2) };
	assert.deepEqual(planAnalyticsBuilds({ finals, index, now, coreBlocked: true, afterKickoffMs: 4 * H, max: 10 }), ["a", "b"]);
	const complete = buildMatchAnalytics({ summary, asa, asaDepth: depth(), now: 1 })!;
	assert.equal(complete.asaRetryAfter, null);
});

test("height band: ESPN's own words for shots on target, exact Core height when present", async () => {
	const { heightBandFromText, heightBandFromZ, joinCoreShots, coreShots } = await import("../src/match-analytics.ts");
	assert.equal(heightBandFromText("Attempt saved. X right footed shot is saved in the top centre of the goal."), "high");
	assert.equal(heightBandFromText("Goal! ... left footed shot from the centre of the box to the bottom right corner."), "low");
	assert.equal(heightBandFromText("Attempt saved. ... is saved in the centre of the goal."), "middle");
	assert.equal(heightBandFromText("Attempt missed. ... misses to the left."), null);
	const shots = shotsFromSummary(summary);
	const onTarget = shots.filter((s) => s.outcome === "goal" || s.outcome === "onTarget");
	assert.ok(onTarget.every((s) => s.heightBand), "every on-target shot gets a band from ESPN's text");
	assert.ok(shots.filter((s) => s.outcome !== "goal" && s.outcome !== "onTarget").every((s) => !s.heightBand));
	assert.equal(shots.find((s) => s.outcome === "goal")!.heightBand, "low"); // "to the bottom right corner"
	assert.equal(heightBandFromZ(39.9 - 10), "high");
	const joined = joinCoreShots(shots, coreShots(core.items));
	assert.equal(joined[1].goalZ, 25.3);
	assert.equal(joined[1].heightBand, "middle"); // Core 25.3 = just under the top third (text said "top centre")
});

test("season shots against carry the keeper who faced them", () => {
	const m = buildMatchAnalytics({ summary, asa, asaDepth: depth(), now: 1 })!;
	const was = foldMatchIntoSeason(emptySeason("15365", 2026), m, 1);
	const keeper = was.keepers[0].athleteId;
	assert.ok(was.contributions[0].shotsAgainst.every((s) => s.keeperId === keeper));
});
