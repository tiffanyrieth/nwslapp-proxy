// MATCH ANALYTICS — shot maps, xG, heat maps (2026-10-20). Pure helpers, unit-tested in
// test/match-analytics.test.ts; the wiring (scheduler, build job, routes) is in index.ts.
//
// Sources, each with a second source (owner soft rule, CLAUDE.md "Second source"):
//   • Shots (location, end point, goal-mouth, outcome, shooter, assister) — ESPN `/summary` commentary, the
//     payload the app + proxy ALREADY fetch and cache: 0 new calls. Second source: ESPN's Core event stream,
//     plus the permanent saved copy (a match's shots never change after full time).
//   • Team xG per match + per-player xG/xA/shots/key passes — American Soccer Analysis (ASA) public API, credited
//     on screen. Second source: OUR estimate from the ESPN shot locations (`estimateXg`), labelled "xG (est.)".
//   • Heat maps — ESPN Core event stream (the only public source of touch locations). Second source: the
//     permanent saved copy; a new match with Core unreachable reads "not available yet" (owner 2026-10-20).
// Coordinates are ESPN/Opta's 0–100 pitch, ALREADY oriented so the shooting team attacks x = 100 (verified on
// both teams' shots, 2026-10-20) — never flip them.

import { normalizeName } from "./headshots.ts";

export type ShotOutcome = "goal" | "onTarget" | "offTarget" | "blocked" | "woodwork";
export type BodyPart = "head" | "left" | "right" | "other";

export interface Shot {
	minute: string; // ESPN display clock, e.g. "45'+2'"
	period: number;
	teamId: string;
	athleteId: string | null;
	assistAthleteId: string | null;
	x: number;
	y: number;
	endX: number | null;
	endY: number | null;
	/** Where across the goal mouth it went (0–100 of the goal line; ~45–55 is between the posts). */
	goalY: number | null;
	outcome: ShotOutcome;
	penalty: boolean;
	bodyPart: BodyPart;
	/** Our location-based estimate — always present, used when ASA has no number for the match. */
	xgEst: number;
}

/** ESPN play type → outcome. Goals come in several types ("Goal", "Goal - Header", "Goal - Volley", …);
 *  own goals are NOT shots by the scoring team, so they're excluded from the shot map. */
export function shotOutcome(type: string): ShotOutcome | null {
	if (type.startsWith("Own Goal")) return null;
	if (type.startsWith("Goal") || type === "Penalty - Scored") return "goal";
	switch (type) {
		case "Shot On Target": case "Penalty - Saved": return "onTarget";
		case "Shot Off Target": case "Penalty - Missed": return "offTarget";
		case "Shot Blocked": return "blocked";
		case "Shot Hit Woodwork": return "woodwork";
		default: return null;
	}
}

export function bodyPartOf(type: string, text: string): BodyPart {
	const t = text.toLowerCase();
	if (type === "Goal - Header" || t.includes("header") || t.includes("headed")) return "head";
	if (t.includes("left footed") || t.includes("left foot")) return "left";
	if (t.includes("right footed") || t.includes("right foot")) return "right";
	return "other";
}

// ── The "xG (est.)" model ─────────────────────────────────────────────────────────────────────────
// Logistic regression on shot ANGLE (radians the goal mouth subtends) + DISTANCE (metres) + HEADER, fitted
// 2026-10-20 on 870 real 2026 NWSL shots (98 goals) from 31 matches' ESPN summaries. Against ASA's per-match
// team xG on the same 62 team-matches: correlation 0.89, mean absolute difference 0.29, mean 1.58 vs 1.53.
// Good enough for a number labelled "(est.)"; ASA's model stays primary. Penalties use a fixed 0.76.
export const XG_EST_WEIGHTS = { intercept: -1.9555, angle: 2.1098, distance: -0.0682, header: -1.3868 } as const;
export const PENALTY_XG = 0.76;
const PITCH_LENGTH_M = 105;
const PITCH_WIDTH_M = 68;
const GOAL_WIDTH_M = 7.32;

export function estimateXg(s: { x: number; y: number; penalty: boolean; bodyPart: BodyPart }): number {
	if (s.penalty) return PENALTY_XG;
	const dx = ((100 - s.x) / 100) * PITCH_LENGTH_M;
	const dy = ((s.y - 50) / 100) * PITCH_WIDTH_M;
	const dist = Math.hypot(dx, dy);
	let angle = Math.atan2(GOAL_WIDTH_M * dx, dx * dx + dy * dy - (GOAL_WIDTH_M / 2) ** 2);
	if (angle < 0) angle += Math.PI;
	const w = XG_EST_WEIGHTS;
	const z = w.intercept + w.angle * angle + w.distance * dist + (s.bodyPart === "head" ? w.header : 0);
	return Math.round((1 / (1 + Math.exp(-z))) * 1000) / 1000;
}

// ── Shots out of an ESPN /summary ────────────────────────────────────────────────────────────────

interface SummaryLike {
	header?: { id?: string; competitions?: { date?: string; competitors?: { homeAway?: string; team?: { id?: string; abbreviation?: string; displayName?: string } }[] }[] };
	commentary?: { play?: {
		type?: { text?: string }; text?: string; period?: { number?: number }; clock?: { displayValue?: string };
		team?: { displayName?: string; id?: string };
		participants?: { athlete?: { displayName?: string; id?: string } }[];
		fieldPositionX?: number | null; fieldPositionY?: number | null; fieldPosition2X?: number | null; fieldPosition2Y?: number | null;
		goalPositionY?: number | null;
	} }[];
	rosters?: { team?: { id?: string; displayName?: string }; roster?: { athlete?: { id?: string; displayName?: string } }[] }[];
}

export interface MatchTeams {
	eventId: string;
	kickoff: string;
	home: { id: string; abbr: string; name: string };
	away: { id: string; abbr: string; name: string };
}

export function matchTeams(summary: SummaryLike): MatchTeams | null {
	const comp = summary.header?.competitions?.[0];
	const side = (ha: string) => comp?.competitors?.find((c) => c.homeAway === ha)?.team;
	const h = side("home"), a = side("away");
	if (!summary.header?.id || !comp?.date || !h?.id || !a?.id) return null;
	return {
		eventId: String(summary.header.id),
		kickoff: comp.date,
		home: { id: String(h.id), abbr: String(h.abbreviation ?? ""), name: String(h.displayName ?? "") },
		away: { id: String(a.id), abbr: String(a.abbreviation ?? ""), name: String(a.displayName ?? "") },
	};
}

/** Every shot in the match, shooter/assister resolved to ESPN ids through the SAME summary's rosters (the
 *  commentary names players by display name only). */
export function shotsFromSummary(summary: SummaryLike): Shot[] {
	const teams = matchTeams(summary);
	if (!teams) return [];
	const teamIdByName = new Map([[teams.home.name, teams.home.id], [teams.away.name, teams.away.id]]);
	const idByTeamAndName = new Map<string, string>();
	for (const r of summary.rosters ?? []) {
		const tid = String(r.team?.id ?? "");
		for (const p of r.roster ?? []) {
			if (p.athlete?.id && p.athlete.displayName) idByTeamAndName.set(`${tid}|${normalizeName(p.athlete.displayName)}`, String(p.athlete.id));
		}
	}
	const idFor = (teamId: string, name: string | undefined, direct: string | undefined): string | null => {
		if (direct) return String(direct);
		if (!name) return null;
		return idByTeamAndName.get(`${teamId}|${normalizeName(name)}`) ?? null;
	};
	const shots: Shot[] = [];
	for (const c of summary.commentary ?? []) {
		const p = c.play;
		const type = p?.type?.text ?? "";
		const outcome = shotOutcome(type);
		if (!p || !outcome || p.fieldPositionX == null || p.fieldPositionY == null) continue;
		const teamId = String(p.team?.id ?? teamIdByName.get(String(p.team?.displayName ?? "")) ?? "");
		if (!teamId) continue;
		const text = p.text ?? "";
		const penalty = type.startsWith("Penalty") || /\bpenalty\b/i.test(text) && !/penalty area/i.test(text);
		const bodyPart = bodyPartOf(type, text);
		const [shooter, assister] = p.participants ?? [];
		const base = { x: p.fieldPositionX, y: p.fieldPositionY, penalty, bodyPart };
		shots.push({
			minute: p.clock?.displayValue ?? "",
			period: p.period?.number ?? 0,
			teamId,
			athleteId: idFor(teamId, shooter?.athlete?.displayName, shooter?.athlete?.id),
			assistAthleteId: assister ? idFor(teamId, assister.athlete?.displayName, assister.athlete?.id) : null,
			x: p.fieldPositionX,
			y: p.fieldPositionY,
			endX: p.fieldPosition2X ?? null,
			endY: p.fieldPosition2Y ?? null,
			goalY: p.goalPositionY ?? null,
			outcome,
			penalty,
			bodyPart,
			xgEst: estimateXg(base),
		});
	}
	return shots;
}

// ── American Soccer Analysis matching ────────────────────────────────────────────────────────────

export interface AsaTeam { team_id: string; team_name: string; team_short_name?: string; team_abbreviation: string }
export interface AsaGame { game_id: string; date_time_utc: string; home_team_id: string; away_team_id: string }
export interface AsaGameXg { game_id: string; home_team_xgoals: number; away_team_xgoals: number }
export interface AsaPlayerXg {
	player_id: string; game_id: string; team_id: string; minutes_played?: number;
	shots?: number; shots_on_target?: number; goals?: number; xgoals?: number; key_passes?: number; primary_assists?: number; xassists?: number;
}
export interface AsaPlayer { player_id: string; player_name: string }

/** ASA abbreviations that differ from ESPN's. ASA also lists defunct clubs that reused an abbreviation
 *  (BOS, KC), so matching uses the TEAM NAME first and the abbreviation only as a fallback. */
const ASA_ABBR_TO_ESPN: Record<string, string> = { NJY: "GFC" };

export function asaTeamIdFor(espn: { abbr: string; name: string }, teams: AsaTeam[]): string | null {
	const norm = (s: string) => normalizeName(s.replace(/\bfc\b|\bsc\b/gi, ""));
	const byName = teams.find((t) => norm(t.team_name) === norm(espn.name));
	if (byName) return byName.team_id;
	const byAbbr = teams.filter((t) => (ASA_ABBR_TO_ESPN[t.team_abbreviation] ?? t.team_abbreviation) === espn.abbr);
	return byAbbr.length === 1 ? byAbbr[0].team_id : null;
}

/** The ASA game for an ESPN match: same home + away team, kickoff within 3 hours (times are both UTC). */
export function asaGameFor(m: MatchTeams, games: AsaGame[], teams: AsaTeam[]): AsaGame | null {
	const home = asaTeamIdFor(m.home, teams), away = asaTeamIdFor(m.away, teams);
	if (!home || !away) return null;
	const ko = Date.parse(m.kickoff);
	const asaTime = (g: AsaGame) => Date.parse(g.date_time_utc.replace(" UTC", "Z").replace(" ", "T"));
	return games.find((g) => g.home_team_id === home && g.away_team_id === away && Math.abs(asaTime(g) - ko) <= 3 * 3600_000) ?? null;
}

// ── The saved per-match copy ─────────────────────────────────────────────────────────────────────

export interface PlayerMatchLine {
	athleteId: string;
	teamId: string;
	shots: number;
	shotsOnTarget: number;
	goals: number;
	xg: number;
	xa: number | null;
	keyPasses: number | null;
	source: "asa" | "estimate";
}

export interface MatchAnalytics {
	v: 1;
	eventId: string;
	kickoff: string;
	home: { id: string; abbr: string };
	away: { id: string; abbr: string };
	shots: Shot[];
	xg: { home: number; away: number; source: "asa" | "estimate" };
	players: PlayerMatchLine[];
	/** Per-player touch heat maps (12×8 grids) from the ESPN Core event stream; null = not fetched (yet). */
	heat: Record<string, number[]> | null;
	heatStatus: "ok" | "unavailable" | "pending";
	/** athleteId → teamId for everyone in the match's rosters (splits heat grids per club). */
	rosterTeams?: Record<string, string>;
	builtAt: number;
	/** ASA hadn't posted the match yet → one retry after this (ms). */
	asaRetryAfter: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Build the saved copy. `asa` is optional (unavailable / not posted yet) — every number then comes from the
 *  ESPN shots + our estimate, and `source` says so. */
export function buildMatchAnalytics(args: {
	summary: SummaryLike;
	asa?: { teams: AsaTeam[]; games: AsaGame[]; gameXg: AsaGameXg[]; playerXg: AsaPlayerXg[]; players: AsaPlayer[] } | null;
	espnRosterNames?: Map<string, { teamId: string; name: string }>;
	heat?: Record<string, number[]> | null;
	heatStatus?: MatchAnalytics["heatStatus"];
	now: number;
	asaRetryMs?: number;
}): MatchAnalytics | null {
	const teams = matchTeams(args.summary);
	if (!teams) return null;
	const shots = shotsFromSummary(args.summary);
	const sum = (tid: string) => round2(shots.filter((s) => s.teamId === tid).reduce((n, s) => n + s.xgEst, 0));

	// ASA, when it has this match.
	const asaGame = args.asa ? asaGameFor(teams, args.asa.games, args.asa.teams) : null;
	const asaXg = asaGame ? args.asa!.gameXg.find((g) => g.game_id === asaGame.game_id) ?? null : null;
	const xg = asaXg
		? { home: round2(asaXg.home_team_xgoals), away: round2(asaXg.away_team_xgoals), source: "asa" as const }
		: { home: sum(teams.home.id), away: sum(teams.away.id), source: "estimate" as const };

	// Per-player lines: ESPN shots always; ASA's xG/xA/key passes when matched (by name within the club).
	const names = args.espnRosterNames ?? rosterNames(args.summary);
	const asaTeamToEspn = new Map<string, string>();
	if (args.asa && asaGame) {
		const hid = asaTeamIdFor(teams.home, args.asa.teams), aid = asaTeamIdFor(teams.away, args.asa.teams);
		if (hid) asaTeamToEspn.set(hid, teams.home.id);
		if (aid) asaTeamToEspn.set(aid, teams.away.id);
	}
	const asaNameById = new Map((args.asa?.players ?? []).map((p) => [p.player_id, normalizeName(p.player_name)]));
	const asaRows = asaGame ? args.asa!.playerXg.filter((r) => r.game_id === asaGame.game_id) : [];
	const asaByTeamName = new Map<string, AsaPlayerXg>();
	for (const r of asaRows) {
		const tid = asaTeamToEspn.get(r.team_id);
		const nm = asaNameById.get(r.player_id);
		if (tid && nm) asaByTeamName.set(`${tid}|${nm}`, r);
	}
	const lines = new Map<string, PlayerMatchLine>();
	const line = (athleteId: string, teamId: string): PlayerMatchLine => {
		let l = lines.get(athleteId);
		if (!l) {
			const nm = names.get(athleteId);
			const a = nm ? asaByTeamName.get(`${teamId}|${normalizeName(nm.name)}`) : undefined;
			l = a
				? { athleteId, teamId, shots: a.shots ?? 0, shotsOnTarget: a.shots_on_target ?? 0, goals: a.goals ?? 0, xg: round2(a.xgoals ?? 0), xa: round2(a.xassists ?? 0), keyPasses: a.key_passes ?? 0, source: "asa" }
				: { athleteId, teamId, shots: 0, shotsOnTarget: 0, goals: 0, xg: 0, xa: null, keyPasses: null, source: "estimate" };
			lines.set(athleteId, l);
		}
		return l;
	};
	for (const s of shots) {
		if (!s.athleteId) continue;
		const l = line(s.athleteId, s.teamId);
		if (l.source === "estimate") {
			l.shots += 1;
			if (s.outcome === "goal" || s.outcome === "onTarget") l.shotsOnTarget += 1;
			if (s.outcome === "goal") l.goals += 1;
			l.xg = round2(l.xg + s.xgEst);
		}
	}
	// ASA players who created chances but never shot (key passes / xA) still get a line.
	for (const [athleteId, nm] of names) {
		if (lines.has(athleteId)) continue;
		if (asaByTeamName.has(`${nm.teamId}|${normalizeName(nm.name)}`)) {
			const l = line(athleteId, nm.teamId);
			if (!(l.keyPasses || l.xa || l.shots)) lines.delete(athleteId);
		}
	}
	return {
		v: 1,
		eventId: teams.eventId,
		kickoff: teams.kickoff,
		home: { id: teams.home.id, abbr: teams.home.abbr },
		away: { id: teams.away.id, abbr: teams.away.abbr },
		shots,
		xg,
		players: [...lines.values()].sort((a, b) => b.xg - a.xg),
		heat: args.heat ?? null,
		heatStatus: args.heatStatus ?? (args.heat ? "ok" : "pending"),
		rosterTeams: Object.fromEntries([...names].map(([id, v]) => [id, v.teamId])),
		builtAt: args.now,
		asaRetryAfter: xg.source === "estimate" ? args.now + (args.asaRetryMs ?? 22 * 3600_000) : null,
	};
}

/** athleteId → {teamId, display name} from the summary's rosters. */
export function rosterNames(summary: SummaryLike): Map<string, { teamId: string; name: string }> {
	const out = new Map<string, { teamId: string; name: string }>();
	for (const r of summary.rosters ?? []) {
		const tid = String(r.team?.id ?? "");
		for (const p of r.roster ?? []) if (p.athlete?.id && p.athlete.displayName) out.set(String(p.athlete.id), { teamId: tid, name: p.athlete.displayName });
	}
	return out;
}

// ── Season rollup per club ───────────────────────────────────────────────────────────────────────
// Stored as one CONTRIBUTION per match; every total is recomputed from them, so re-folding a match (e.g. ASA's
// real xG replacing our estimate a day later) replaces its contribution and can never double-count.

export interface SeasonPlayerLine { athleteId: string; matches: number; shots: number; shotsOnTarget: number; goals: number; xg: number; xa: number; keyPasses: number }
export interface SeasonContribution {
	eventId: string;
	kickoff: string;
	xgFor: number;
	xgAgainst: number;
	source: "asa" | "estimate";
	shotsFor: Shot[];
	shotsAgainst: Shot[];
	players: PlayerMatchLine[];
	/** This club's players' touch grids from that match (heat maps), when the match has them. */
	heat?: Record<string, number[]>;
}
export interface TeamSeasonAnalytics {
	v: 1;
	teamId: string;
	year: number;
	contributions: SeasonContribution[];
	// Derived (recomputed on every fold):
	matches: number;
	xgFor: number;
	xgAgainst: number;
	xgSources: { asa: number; estimate: number };
	players: SeasonPlayerLine[];
	/** Season touch grids per player (sum of the matches that have heat), and how many matches fed them. */
	heat: Record<string, number[]>;
	heatMatches: number;
	updatedAt: number;
}

export function emptySeason(teamId: string, year: number): TeamSeasonAnalytics {
	return { v: 1, teamId, year, contributions: [], matches: 0, xgFor: 0, xgAgainst: 0, xgSources: { asa: 0, estimate: 0 }, players: [], heat: {}, heatMatches: 0, updatedAt: 0 };
}

/** Fold one match into a club's season (idempotent per eventId). Not this club's match → unchanged. */
export function foldMatchIntoSeason(prev: TeamSeasonAnalytics, m: MatchAnalytics, now: number): TeamSeasonAnalytics {
	const tid = prev.teamId;
	if (m.home.id !== tid && m.away.id !== tid) return prev;
	const isHome = m.home.id === tid;
	const contribution: SeasonContribution = {
		eventId: m.eventId,
		kickoff: m.kickoff,
		xgFor: isHome ? m.xg.home : m.xg.away,
		xgAgainst: isHome ? m.xg.away : m.xg.home,
		source: m.xg.source,
		shotsFor: m.shots.filter((s) => s.teamId === tid),
		shotsAgainst: m.shots.filter((s) => s.teamId !== tid),
		players: m.players.filter((p) => p.teamId === tid),
		heat: m.heat ? Object.fromEntries(Object.entries(m.heat).filter(([id]) => m.players.some((p) => p.athleteId === id && p.teamId === tid) || teamOfHeat(m, id) === tid)) : undefined,
	};
	const contributions = [...prev.contributions.filter((c) => c.eventId !== m.eventId), contribution]
		.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
	return recompute({ ...prev, contributions }, now);
}

function recompute(s: TeamSeasonAnalytics, now: number): TeamSeasonAnalytics {
	const players = new Map<string, SeasonPlayerLine>();
	let xgFor = 0, xgAgainst = 0;
	const xgSources = { asa: 0, estimate: 0 };
	const heat: Record<string, number[]> = {};
	let heatMatches = 0;
	for (const c of s.contributions) {
		xgFor += c.xgFor; xgAgainst += c.xgAgainst; xgSources[c.source] += 1;
		if (c.heat && Object.keys(c.heat).length) {
			heatMatches += 1;
			for (const [id, g] of Object.entries(c.heat)) {
				const acc = (heat[id] ??= new Array(g.length).fill(0));
				for (let i = 0; i < g.length; i++) acc[i] += g[i];
			}
		}
		for (const l of c.players) {
			const p = players.get(l.athleteId) ?? { athleteId: l.athleteId, matches: 0, shots: 0, shotsOnTarget: 0, goals: 0, xg: 0, xa: 0, keyPasses: 0 };
			p.matches += 1; p.shots += l.shots; p.shotsOnTarget += l.shotsOnTarget; p.goals += l.goals;
			p.xg += l.xg; p.xa += l.xa ?? 0; p.keyPasses += l.keyPasses ?? 0;
			players.set(l.athleteId, p);
		}
	}
	return {
		...s,
		matches: s.contributions.length,
		xgFor: round2(xgFor),
		xgAgainst: round2(xgAgainst),
		xgSources,
		players: [...players.values()].map((p) => ({ ...p, xg: round2(p.xg), xa: round2(p.xa) })).sort((a, b) => b.xg - a.xg),
		heat,
		heatMatches,
		updatedAt: now,
	};
}

/** Which club a heat-grid athlete played for in this match (shots/lines first, else the match's roster map). */
function teamOfHeat(m: MatchAnalytics, athleteId: string): string | null {
	return m.rosterTeams?.[athleteId] ?? null;
}

// ── Heat maps (ESPN Core event stream) ───────────────────────────────────────────────────────────

export const HEAT_COLS = 12;
export const HEAT_ROWS = 8;

/** Core play `participants[].athlete.$ref` → the athlete id. */
export function athleteIdFromRef(ref: string | undefined): string | null {
	const m = /\/athletes\/(\d+)/.exec(ref ?? "");
	return m ? m[1] : null;
}

/** Core event stream → per-player touch grids (HEAT_COLS × HEAT_ROWS counts, row-major, x across). Only the
 *  acting player (participants[0]) is credited; events without a location are skipped. */
export function heatGrids(events: { fieldPositionX?: number | null; fieldPositionY?: number | null; participants?: { athlete?: { $ref?: string } }[] }[]): Record<string, number[]> {
	const out: Record<string, number[]> = {};
	for (const e of events) {
		const x = e.fieldPositionX, y = e.fieldPositionY;
		if (x == null || y == null || (x === 0 && y === 0)) continue;
		const id = athleteIdFromRef(e.participants?.[0]?.athlete?.$ref);
		if (!id) continue;
		const col = Math.min(HEAT_COLS - 1, Math.max(0, Math.floor((x / 100) * HEAT_COLS)));
		const row = Math.min(HEAT_ROWS - 1, Math.max(0, Math.floor((y / 100) * HEAT_ROWS)));
		(out[id] ??= new Array(HEAT_COLS * HEAT_ROWS).fill(0))[row * HEAT_COLS + col] += 1;
	}
	return out;
}

// ── Scheduling builds ────────────────────────────────────────────────────────────────────────────

export interface AnalyticsIndexEntry { source: "asa" | "estimate"; asaRetryAfter: number | null; asaRetried?: boolean; heat: MatchAnalytics["heatStatus"]; heatRetryAfter?: number; builtAt: number }
export type AnalyticsIndex = Record<string, AnalyticsIndexEntry>;

/** Which settled matches to build now (newest first, capped): never built · ASA's real xG due (ONE retry) ·
 *  heat due while ESPN Core accepts us. A match is only eligible ≥ `afterKickoffMs` after kickoff. */
export function planAnalyticsBuilds(args: {
	finals: { eventId: string; kickoffMs: number }[];
	index: AnalyticsIndex;
	now: number;
	coreBlocked: boolean;
	afterKickoffMs: number;
	max: number;
}): string[] {
	return [...args.finals]
		.sort((a, b) => b.kickoffMs - a.kickoffMs)
		.filter((f) => {
			if (args.now < f.kickoffMs + args.afterKickoffMs) return false;
			const ix = args.index[f.eventId];
			if (!ix) return true;
			if (ix.source === "estimate" && !ix.asaRetried && ix.asaRetryAfter !== null && args.now >= ix.asaRetryAfter) return true;
			return ix.heat !== "ok" && !args.coreBlocked && args.now >= (ix.heatRetryAfter ?? 0);
		})
		.slice(0, args.max)
		.map((f) => f.eventId);
}
