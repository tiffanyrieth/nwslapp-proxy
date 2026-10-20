// Player season stats — saved per-club copies, refreshed after each match, ESPN primary + NWSL backup
// (2026-10-20, src/team-stats-store.ts). Pure logic, node:test like ig-scrape.test.ts. The fixture is a
// trimmed REAL league-feed payload (BAY: Hannah Bebar + keeper Jordan Silkowitz).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	sdpStatsToEspn,
	resolveTeamStats,
	planStatsRefresh,
	nextEspnCopy,
	settledRegularSeasonMatches,
	latestMatchByTeam,
	STATS_REFRESH_AFTER_KICKOFF_MS,
	STATS_LAG_RETRY_MS,
	type TeamStatsCopy,
	type StatsPlayer,
} from "../src/team-stats-store.ts";
import { pairEspnToSdp, nwslStatsCopy } from "../src/roster-truth.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/sdp-stats-players-bay.json", import.meta.url), "utf8")) as {
	players: { mediaFirstName: string; mediaLastName: string; bibNumber: string; stats: { statsId: string; statsValue: number }[] }[];
};
const [bebar, silkowitz] = fixture.players;

// ── league feed → ESPN keys ──────────────────────────────────────────────────────────────────────

test("an outfielder's league totals map to the ESPN keys every reader uses", () => {
	const s = sdpStatsToEspn(bebar.stats);
	assert.equal(s["general.starts"], 28);
	assert.equal(s["general.minutes"], 2475);
	assert.equal(s["general.appearances"], 28);
	assert.equal(s["offensive.totalGoals"], 1);
	assert.equal(s["offensive.goalAssists"], 2);
	assert.equal(s["offensive.totalShots"], 20);
	assert.equal(s["offensive.shotsOnTarget"], 6);
	assert.equal(s["offensive.shotAssists"], 32);
	assert.equal(s["defensive.totalTackles"], 84);
	assert.equal(s["defensive.effectiveTackles"], 46);
	assert.equal(s["defensive.interceptions"], 53);
	assert.equal(s["goalKeeping.shotsFaced"], undefined); // not a keeper — no fake "41 shots faced"
});

test("a keeper's saves / clean sheets / shots faced come through", () => {
	const s = sdpStatsToEspn(silkowitz.stats);
	assert.equal(s["goalKeeping.saves"], 108); // `Saves Made` preferred
	assert.equal(s["goalKeeping.cleanSheet"], 7);
	assert.equal(s["goalKeeping.shotsFaced"], 148); // 108 saves + 40 conceded
	assert.equal(s["general.starts"], 27);
});

// ── pairing the league feed to ESPN ids (roster-truth's own rules) ───────────────────────────────

test("league players pair to ESPN ids by name, then by shirt number; unpaired are left out", () => {
	const espn = {
		teamAbbr: "BAY", espnTeamId: "22187",
		players: [
			{ id: "e1", display: "Hannah Bebar", name: "hannah bebar", jersey: 41, group: "M", rawPosition: "Midfielder" },
			{ id: "e2", display: "Jordan R. Silkowitz", name: "jordan r silkowitz", jersey: 29, group: "G", rawPosition: "Goalkeeper" }, // spelled differently → shirt-number pair
			{ id: "e3", display: "New Signing", name: "new signing", jersey: null, group: "F", rawPosition: "Forward" },
		],
	} as never;
	const squad = {
		teamAbbr: "BAY", teamGuid: "g", teamName: "BAY",
		players: [
			{ guid: "s1", name: "hannah bebar", short: "h bebar", shirt: "", display: "Hannah Bebar", jersey: "41", role: "M", minutes: 2475, games: 28, espnStats: sdpStatsToEspn(bebar.stats) },
			{ guid: "s2", name: "jordan silkowitz", short: "j silkowitz", shirt: "", display: "Jordan Silkowitz", jersey: "29", role: "G", minutes: 2403, games: 27, espnStats: sdpStatsToEspn(silkowitz.stats) },
		],
	} as never;
	const pairs = pairEspnToSdp(espn, squad);
	assert.equal(pairs.get("e1")?.guid, "s1");
	assert.equal(pairs.get("e2")?.guid, "s2");
	assert.equal(pairs.has("e3"), false);
	const roster = [
		{ id: "e1", name: "Hannah Bebar", jersey: 41, team: "BAY", position: "Midfielder" },
		{ id: "e2", name: "Jordan R. Silkowitz", jersey: 29, team: "BAY", position: "Goalkeeper" },
		{ id: "e3", name: "New Signing", jersey: null, team: "BAY", position: "Forward" },
	];
	const { copy, unmatched } = nwslStatsCopy({ teamId: "22187", teamAbbr: "BAY", year: 2026, roster, espn, squad, now: 1 });
	assert.equal(copy.source, "nwsl");
	assert.equal(copy.players.length, 2);
	assert.equal(unmatched, 1);
	assert.equal(copy.appearancesTotal, 55);
});

// ── choosing ESPN vs NWSL ────────────────────────────────────────────────────────────────────────

const P = (id: string, apps: number): StatsPlayer => ({ athleteId: id, name: id, jersey: null, position: "F", stats: { "general.appearances": apps } });
const copy = (source: "espn" | "nwsl", players: StatsPlayer[], extra: Partial<TeamStatsCopy> = {}): TeamStatsCopy => ({
	source, teamId: "1", teamAbbr: "WAS", year: 2026, fetchedAt: 100, basedOnEventId: source === "espn" ? "e1" : null,
	appearancesTotal: players.reduce((n, p) => n + (p.stats["general.appearances"] ?? 0), 0), players, ...extra,
});

test("ESPN is primary on a tie; the NWSL copy wins only with strictly more appearances", () => {
	const espn = copy("espn", [P("a", 5), P("b", 5)]);
	assert.equal(resolveTeamStats(espn, copy("nwsl", [P("a", 5), P("b", 5)]))?.source, "espn");
	assert.equal(resolveTeamStats(espn, copy("nwsl", [P("a", 6), P("b", 5)]))?.source, "nwsl");
	assert.equal(resolveTeamStats(null, copy("nwsl", [P("a", 1)]))?.source, "nwsl");
	assert.equal(resolveTeamStats(null, null), null);
});

test("a player missing from the chosen copy is filled from the other (new signing / ESPN drop)", () => {
	const r = resolveTeamStats(copy("espn", [P("a", 5), P("new", 1)]), copy("nwsl", [P("a", 5)]));
	assert.equal(r?.source, "espn"); // espn 6 > nwsl 5
	const r2 = resolveTeamStats(copy("espn", [P("a", 5)]), copy("nwsl", [P("a", 5), P("b", 3)]));
	assert.equal(r2?.source, "nwsl"); // nwsl has more appearances overall
	const r3 = resolveTeamStats(copy("espn", [P("a", 9), P("x", 9)]), copy("nwsl", [P("a", 9), P("y", 1)]));
	assert.deepEqual(r3?.players.map((p) => p.athleteId).sort(), ["a", "x", "y"]);
	assert.equal(r3?.source, "mixed");
});

// ── when to refresh ──────────────────────────────────────────────────────────────────────────────

const KO = Date.parse("2026-10-17T16:30:00Z");
const match = (eventId: string, a: string, b: string, kickoffMs = KO) => ({ eventId, teamIds: [a, b], kickoffMs });

test("a club refreshes ~2h after the whistle (kickoff + 4h), not before, and once per match", () => {
	const finals = [match("e1", "WAS", "GFC")];
	const none = new Map();
	assert.deepEqual(planStatsRefresh({ finals, espnCopies: none, now: KO + STATS_REFRESH_AFTER_KICKOFF_MS - 1, blockedUntil: 0 }), []);
	const due = planStatsRefresh({ finals, espnCopies: none, now: KO + STATS_REFRESH_AFTER_KICKOFF_MS, blockedUntil: 0 });
	assert.deepEqual(due.map((d) => d.teamId).sort(), ["GFC", "WAS"]);
	const done = new Map([["WAS", copy("espn", [], { basedOnEventId: "e1", retried: false, retryAfter: null })]]);
	const again = planStatsRefresh({ finals, espnCopies: done, now: KO + 10 * 3600 * 1000, blockedUntil: 0 });
	assert.deepEqual(again.map((d) => d.teamId), ["GFC"]); // WAS already based on e1 → locked until its next match
});

test("only each club's LATEST match counts, and at most 4 clubs per check (oldest first)", () => {
	const finals = [
		match("old", "WAS", "GFC", KO - 7 * 86400000),
		match("e1", "WAS", "GFC"), match("e2", "A", "B", KO - 3600000), match("e3", "C", "D", KO - 7200000),
	];
	assert.equal(latestMatchByTeam(finals).get("WAS")?.eventId, "e1");
	const due = planStatsRefresh({ finals, espnCopies: new Map(), now: KO + 86400000, blockedUntil: 0 });
	assert.equal(due.length, 4);
	assert.deepEqual(due.slice(0, 2).map((d) => d.eventId), ["e3", "e3"]);
});

test("nothing is scheduled while ESPN is refusing (durable block marker)", () => {
	assert.deepEqual(planStatsRefresh({ finals: [match("e1", "WAS", "GFC")], espnCopies: new Map(), now: KO + 86400000, blockedUntil: KO + 2 * 86400000 }), []);
});

test("ESPN lag: no new appearances after a new match → ONE retry ~22h later, then the club waits", () => {
	const t0 = KO + STATS_REFRESH_AFTER_KICKOFF_MS; // the first after-match refresh
	const prev = copy("espn", [P("a", 5)], { basedOnEventId: "e0" });
	const lagging = nextEspnCopy({ prev, teamId: "1", teamAbbr: "WAS", year: 2026, eventId: "e1", players: [P("a", 5)], now: t0 });
	assert.equal(lagging.retryAfter, t0 + STATS_LAG_RETRY_MS);
	assert.equal(lagging.retried, false);
	const finals = [match("e1", "1", "2")];
	const map = new Map([["1", lagging]]);
	const has1 = (now: number, m: Map<string, TeamStatsCopy>) => planStatsRefresh({ finals, espnCopies: m, now, blockedUntil: 0 }).some((d) => d.teamId === "1");
	assert.equal(has1(t0 + STATS_LAG_RETRY_MS - 1, map), false);
	assert.equal(has1(t0 + STATS_LAG_RETRY_MS, map), true);
	const retried = nextEspnCopy({ prev: lagging, teamId: "1", teamAbbr: "WAS", year: 2026, eventId: "e1", players: [P("a", 6)], now: t0 + STATS_LAG_RETRY_MS });
	assert.equal(retried.retried, true);
	assert.equal(retried.retryAfter, null);
	assert.equal(has1(t0 + 30 * 86400000, new Map([["1", retried]])), false); // locked until its next match
	const updated = nextEspnCopy({ prev, teamId: "1", teamAbbr: "WAS", year: 2026, eventId: "e1", players: [P("a", 6)], now: t0 });
	assert.equal(updated.retryAfter, null); // ESPN already had it — no retry
});

// ── finals out of the season scoreboard ─────────────────────────────────────────────────────────

test("only settled regular-season matches count (suspended / playoff / preseason / not-yet-played excluded)", () => {
	const ev = (id: string, slug: string, type: Record<string, unknown>) => ({
		id, date: "2026-10-17T16:30Z", season: { slug }, status: { type },
		competitions: [{ competitors: [{ team: { id: "1" } }, { team: { id: "2" } }] }],
	});
	const finals = settledRegularSeasonMatches({
		events: [
			ev("ok", "regular-season", { state: "post", completed: true, name: "STATUS_FULL_TIME" }),
			ev("sparse", "regular-season", { state: "post" }), // fail-open, like chooseSummaryTTL
			ev("susp", "regular-season", { state: "post", completed: false, name: "STATUS_SUSPENDED" }),
			ev("ppd", "regular-season", { state: "post", name: "STATUS_POSTPONED" }),
			ev("live", "regular-season", { state: "in" }),
			ev("po", "playoffs---quarterfinals", { state: "post", completed: true }),
			ev("pre", "preseason", { state: "post", completed: true }),
		],
	});
	assert.deepEqual(finals.map((f) => f.eventId), ["ok", "sparse"]);
});
