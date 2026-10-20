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
	// ── Phase 2 (2026-10-20): joined in by location when a source has the shot ──
	/** ASA's per-shot xG (`games/shots`). Present → the shot's own number is no longer an estimate. */
	xgAsa?: number;
	/** ASA post-shot xG: how hard an ON-TARGET shot was to save (null when off target / blocked). */
	psxg?: number | null;
	/** How the chance came about (ASA `pattern_of_play`). */
	situation?: Situation;
	assistType?: "cross" | "throughBall" | null;
	/** ESPN's own per-shot xG / xGOT + shot height (Core event stream; dormant while Core refuses Cloudflare). */
	xgEspn?: number;
	xgotEspn?: number;
	/** Height where it crossed the goal line (Core `goalPositionZ`, 0–100 scale; the crossbar is ≈ 38). */
	goalZ?: number;
	/** High / middle / low third of the goal for a shot ON TARGET: ESPN's own words ("top centre", "bottom left
	 *  corner", "centre of the goal") — exact Core height overrides when present. */
	heightBand?: HeightBand;
	/** Season "shots against" only: the keeper who faced it (that match's keeper with the most minutes). */
	keeperId?: string;
}

export type HeightBand = "high" | "middle" | "low";
/** ESPN text → band. Calibrated on GFC @ WAS against Core heights: "top …" Z 25–32, "centre of the goal" 4–15,
 *  "bottom …" 2–4 (crossbar ≈ 38, "hits the bar" = 39.9). */
export function heightBandFromText(text: string): HeightBand | null {
	const t = text.toLowerCase();
	if (/\b(top|high) (left|right|centre|center)\b|\btop corner\b|\bhigh centre\b/.test(t)) return "high";
	if (/\b(bottom|low) (left|right|centre|center)\b|\bbottom corner\b/.test(t)) return "low";
	if (/\b(centre|center) of the goal\b/.test(t)) return "middle";
	return null;
}
/** Core height → band: thirds of the crossbar height (Design's 0.8 m / 1.6 m of 2.44 m). */
export function heightBandFromZ(z: number): HeightBand {
	return z > 25.3 ? "high" : z < 12.7 ? "low" : "middle";
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
		const band = outcome === "goal" || outcome === "onTarget" ? heightBandFromText(text) : null;
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
			...(band ? { heightBand: band } : {}),
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
	v: 1 | 2;
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
	// ── v2 (2026-10-20): every position ──
	/** Keepers: shots faced, saves, goals prevented (+ keeper g+). Empty until ASA has the match. */
	keepers?: KeeperLine[];
	/** Goals added (g+) for every outfield player, by action. Empty until ASA has the match. */
	gplus?: GplusLine[];
	/** Passing vs expected. Empty until ASA has the match. */
	xpass?: XpassLine[];
	/** Defensive actions by location per player (ESPN Core; null while Core refuses Cloudflare). */
	defense?: Record<string, DefAction[]> | null;
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
	/** Phase 2: ASA's per-shot rows, keepers, g+ and xPass for THIS match (any piece may be missing). */
	asaDepth?: AsaDepth | null;
	/** Phase 2: ESPN Core extras from the heat step's pages (null while Core refuses Cloudflare). */
	core?: { shots?: { x: number; y: number; xg?: number; xgot?: number; goalZ?: number }[]; defense?: Record<string, DefAction[]> } | null;
	now: number;
	asaRetryMs?: number;
}): MatchAnalytics | null {
	const teams = matchTeams(args.summary);
	if (!teams) return null;
	let shots = shotsFromSummary(args.summary);
	if (args.core?.shots?.length) shots = joinCoreShots(shots, args.core.shots);
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
				: { athleteId, teamId, shots: 0, shotsOnTarget: 0, goals: 0, xg: 0, xa: 0, keyPasses: 0, source: "estimate" };
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
		// xA (est.): the passer ESPN names on a shot is credited that shot's estimated xG (+ a key pass) —
		// ASA's definition, computed from our own estimate when ASA has no row for the match.
		if (s.assistAthleteId) {
			const a = line(s.assistAthleteId, s.teamId);
			if (a.source === "estimate") { a.xa = round2((a.xa ?? 0) + s.xgEst); a.keyPasses = (a.keyPasses ?? 0) + 1; }
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
	// Phase 2: ASA's own per-shot values, joined with the club mapping (so a home and an away shot at the same spot
	// can't swap) — the copy's `shots` below carry them.
	if (asaGame && args.asaDepth?.shots?.length) shots = joinAsaShots(shots, args.asaDepth.shots, asaTeamToEspn);
	// Phase 2: ASA ids → ESPN athletes by normalized name within the club (the same join as the xG lines).
	const espnByTeamName = new Map<string, string>();
	for (const [id, nm] of names) espnByTeamName.set(`${nm.teamId}|${normalizeName(nm.name)}`, id);
	const mapAsa: AsaAthleteMapper = (asaPlayerId, asaTeamId) => {
		const teamId = asaTeamToEspn.get(asaTeamId);
		const nm = asaNameById.get(asaPlayerId);
		const athleteId = teamId && nm ? espnByTeamName.get(`${teamId}|${nm}`) : undefined;
		return teamId && athleteId ? { athleteId, teamId } : null;
	};
	const d = asaGame ? args.asaDepth : null;
	const gplusOut = d?.playerGplus ? gplusLines(d.playerGplus.filter((r) => r.game_id === asaGame!.game_id), mapAsa) : [];
	return {
		v: 2,
		eventId: teams.eventId,
		kickoff: teams.kickoff,
		home: { id: teams.home.id, abbr: teams.home.abbr },
		away: { id: teams.away.id, abbr: teams.away.abbr },
		shots,
		xg,
		keepers: d?.gkXg ? keeperLines(d.gkXg.filter((k) => k.game_id === asaGame!.game_id), (d.gkGplus ?? []).filter((k) => k.game_id === asaGame!.game_id), mapAsa) : [],
		gplus: gplusOut,
		xpass: d?.xpass ? xpassLines(d.xpass.filter((r) => r.game_id === asaGame!.game_id), mapAsa) : [],
		defense: args.core?.defense ?? null,
		players: [...lines.values()].sort((a, b) => b.xg - a.xg),
		heat: args.heat ?? null,
		heatStatus: args.heatStatus ?? (args.heat ? "ok" : "pending"),
		rosterTeams: Object.fromEntries([...names].map(([id, v]) => [id, v.teamId])),
		builtAt: args.now,
		// ASA lags 2h–33h after kickoff (measured on the 10/17 matches) → retry while xG or the g+ depth is missing
		// (at most MAX_ASA_RETRIES times, see planAnalyticsBuilds).
		asaRetryAfter: xg.source === "estimate" || !gplusOut.length ? args.now + (args.asaRetryMs ?? 22 * 3600_000) : null,
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

// ── Phase 2: every position (ASA depth + ESPN Core extras, 2026-10-20) ─────────────────────────────
// Verified on GFC @ WAS (ASA game Oa5wPGp9q1): ASA's per-shot rows carry the SAME coordinates as ESPN's
// (18/18 join by location) and their xG sums to ASA's team totals; keeper post-shot xG faced minus goals
// conceded = goals prevented (Berger +0.14). g+ / xPass are ASA's own models — no second source (saved forever).

export interface AsaShot {
	game_id: string; team_id: string; shooter_player_id?: string; expanded_minute?: number; game_minute?: number; period_id?: number;
	shot_location_x: number; shot_location_y: number; shot_xg: number; shot_psxg?: number;
	goal?: number; own_goal?: number; head?: number; pattern_of_play?: string; assist_cross?: number; assist_through_ball?: number;
}
export interface AsaGkXg {
	player_id: string; game_id: string; team_id: string; minutes_played?: number; shots_faced?: number;
	goals_conceded?: number; saves?: number; xgoals_gk_faced?: number; goals_minus_xgoals_gk?: number;
}
export interface AsaGplusRow {
	player_id: string; game_id: string; team_id: string; general_position?: string; minutes_played?: number;
	data?: { action_type: string; goals_added_raw?: number; goals_added_above_avg?: number; count_actions?: number }[];
}
export interface AsaXpass {
	player_id: string; game_id: string; team_id: string; attempted_passes?: number; pass_completion_percentage?: number;
	xpass_completion_percentage?: number; passes_completed_over_expected?: number;
}
/** Everything ASA has for ONE match beyond team/player xG. Each piece optional (ASA can lag or fail per call). */
// (No game-flow: the app's chart is the RUNNING xG of these shots — ASA's `games/game-flow` is a per-minute threat
// value, not xG, so it was dropped 2026-10-20 to save a call per match.)
export interface AsaDepth { shots?: AsaShot[]; gkXg?: AsaGkXg[]; playerGplus?: AsaGplusRow[]; gkGplus?: AsaGplusRow[]; xpass?: AsaXpass[] }

export type Situation = "regular" | "corner" | "freeKick" | "setPiece" | "penalty" | "fastBreak" | "throwIn" | "other";
export function situationOf(pattern: string | undefined): Situation {
	const p = (pattern ?? "").toLowerCase().replace(/[^a-z]/g, "");
	switch (p) {
		case "regular": return "regular";
		case "corner": return "corner";
		case "freekick": return "freeKick";
		case "setpiece": return "setPiece";
		case "penalty": return "penalty";
		case "fastbreak": return "fastBreak";
		case "throwin": return "throwIn";
		default: return "other";
	}
}

export type GplusActions = Record<string, { raw: number; aboveAvg: number; count: number }>;
export interface GplusLine { athleteId: string; teamId: string; position: string | null; minutes: number; raw: number; aboveAvg: number; actions: GplusActions }
export interface KeeperLine {
	athleteId: string; teamId: string; minutes: number; shotsFaced: number; saves: number; goalsConceded: number;
	/** Post-shot xG of the on-target shots she faced. */
	xgotFaced: number;
	/** xgotFaced − goals conceded (positive = she kept out more than an average keeper would). */
	goalsPrevented: number;
	gplus: GplusActions | null;
}
export interface XpassLine { athleteId: string; teamId: string; attempted: number; completionPct: number; xCompletionPct: number; overExpected: number }
export type DefKind = "tackle" | "tackleLost" | "interception" | "clearance" | "block" | "recovery";
/** One defensive action, oriented like shots (her team attacks x = 100). */
export interface DefAction { kind: DefKind; x: number; y: number; minute: string }

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const locKey = (x: number, y: number) => `${Math.round(x * 10)}|${Math.round(y * 10)}`;

/** Join ASA's per-shot rows onto our shots. Both come from Opta and usually share exact coordinates, but on some
 *  matches one side carries a revised spot (1–3 units off — WAS @ CHI 2026-09-20: 24 of 27 missed an exact join).
 *  So: same team (when `asaTeamToEspn` is given), same half, within 3 minutes, nearest spot within 5 units; each ASA
 *  row used once, closest pairs first. Unmatched → unchanged (the shot keeps our estimate). */
export function joinAsaShots(shots: Shot[], asa: AsaShot[], asaTeamToEspn?: Map<string, string>): Shot[] {
	// "90'+4'" = 94 (ASA counts stoppage time on: its game_minute + 1 = 94 for that shot).
	const minuteOf = (m: string) => (m.match(/\d+/g) ?? ["0"]).reduce((n, d) => n + Number(d), 0);
	const pairs: { i: number; j: number; cost: number }[] = [];
	shots.forEach((s, i) => {
		asa.forEach((a, j) => {
			if (asaTeamToEspn && asaTeamToEspn.get(a.team_id) !== s.teamId) return;
			if (a.period_id && s.period && a.period_id !== s.period) return;
			const am = a.game_minute != null ? a.game_minute + 1 : a.expanded_minute ?? 0;
			const dm = Math.abs(am - minuteOf(s.minute));
			const dist = Math.hypot(a.shot_location_x - s.x, a.shot_location_y - s.y);
			if (dm > 3 || dist > 5) return;
			pairs.push({ i, j, cost: dist + dm * 0.5 });
		});
	});
	pairs.sort((p, q) => p.cost - q.cost);
	const byShot = new Map<number, AsaShot>();
	const used = new Set<number>();
	for (const p of pairs) {
		if (byShot.has(p.i) || used.has(p.j)) continue;
		byShot.set(p.i, asa[p.j]);
		used.add(p.j);
	}
	return shots.map((s, i) => {
		const a = byShot.get(i);
		if (!a) return s;
		const onTarget = s.outcome === "goal" || s.outcome === "onTarget";
		return {
			...s,
			xgAsa: r3(a.shot_xg),
			psxg: onTarget && a.shot_psxg != null ? r3(a.shot_psxg) : null,
			situation: situationOf(a.pattern_of_play),
			assistType: a.assist_cross ? "cross" : a.assist_through_ball ? "throughBall" : null,
		};
	});
}

/** Join ESPN Core's per-shot xG / xGOT / height onto our shots by location (dormant while Core is blocked). */
export function joinCoreShots(shots: Shot[], core: { x: number; y: number; xg?: number; xgot?: number; goalZ?: number }[]): Shot[] {
	const byLoc = new Map(core.map((c) => [locKey(c.x, c.y), c]));
	return shots.map((s) => {
		const c = byLoc.get(locKey(s.x, s.y));
		if (!c) return s;
		const onTarget = s.outcome === "goal" || s.outcome === "onTarget";
		return { ...s, ...(c.xg != null ? { xgEspn: r3(c.xg) } : {}), ...(c.xgot != null ? { xgotEspn: r3(c.xgot) } : {}),
			...(c.goalZ != null ? { goalZ: c.goalZ, ...(onTarget ? { heightBand: heightBandFromZ(c.goalZ) } : {}) } : {}) };
	});
}

function gplusActions(row: AsaGplusRow | undefined): GplusActions | null {
	if (!row?.data?.length) return null;
	const out: GplusActions = {};
	for (const d of row.data) out[d.action_type] = { raw: r3(d.goals_added_raw ?? 0), aboveAvg: r3(d.goals_added_above_avg ?? 0), count: d.count_actions ?? 0 };
	return out;
}

/** ASA player id (+ ASA team) → ESPN athlete id, by normalized name within the club. */
export type AsaAthleteMapper = (asaPlayerId: string, asaTeamId: string) => { athleteId: string; teamId: string } | null;

export function keeperLines(gk: AsaGkXg[], gkGplus: AsaGplusRow[], map: AsaAthleteMapper): KeeperLine[] {
	const out: KeeperLine[] = [];
	for (const k of gk) {
		const who = map(k.player_id, k.team_id);
		if (!who) continue;
		const faced = k.xgoals_gk_faced ?? 0, conceded = k.goals_conceded ?? 0;
		out.push({
			...who, minutes: k.minutes_played ?? 0, shotsFaced: k.shots_faced ?? 0, saves: k.saves ?? 0, goalsConceded: conceded,
			xgotFaced: r3(faced), goalsPrevented: r3(faced - conceded),
			gplus: gplusActions(gkGplus.find((g) => g.player_id === k.player_id)),
		});
	}
	return out;
}

export function gplusLines(rows: AsaGplusRow[], map: AsaAthleteMapper): GplusLine[] {
	const out: GplusLine[] = [];
	for (const r of rows) {
		const who = map(r.player_id, r.team_id);
		const actions = gplusActions(r);
		if (!who || !actions) continue;
		const vals = Object.values(actions);
		out.push({ ...who, position: r.general_position ?? null, minutes: r.minutes_played ?? 0,
			raw: r3(vals.reduce((n, a) => n + a.raw, 0)), aboveAvg: r3(vals.reduce((n, a) => n + a.aboveAvg, 0)), actions });
	}
	return out.sort((a, b) => b.raw - a.raw);
}

export function xpassLines(rows: AsaXpass[], map: AsaAthleteMapper): XpassLine[] {
	const out: XpassLine[] = [];
	for (const r of rows) {
		const who = map(r.player_id, r.team_id);
		if (!who || !r.attempted_passes) continue;
		out.push({ ...who, attempted: r.attempted_passes, completionPct: r3(r.pass_completion_percentage ?? 0),
			xCompletionPct: r3(r.xpass_completion_percentage ?? 0), overExpected: r3(r.passes_completed_over_expected ?? 0) });
	}
	return out;
}

/** ESPN Core event stream → each player's defensive actions (same pages the heat step reads). */
export const DEF_KINDS: Record<string, DefKind> = {
	"tackle": "tackle", "attempted-tackle": "tackleLost", "interception": "interception", "clear": "clearance",
	"blocked-pass": "block", "ball-recovery": "recovery",
};
export function defenseFromCore(events: { type?: { type?: string }; fieldPositionX?: number | null; fieldPositionY?: number | null; clock?: { displayValue?: string }; participants?: { athlete?: { $ref?: string } }[] }[]): Record<string, DefAction[]> {
	const out: Record<string, DefAction[]> = {};
	for (const e of events) {
		const kind = DEF_KINDS[e.type?.type ?? ""];
		const x = e.fieldPositionX, y = e.fieldPositionY;
		if (!kind || x == null || y == null) continue;
		const id = athleteIdFromRef(e.participants?.[0]?.athlete?.$ref);
		if (!id) continue;
		(out[id] ??= []).push({ kind, x, y, minute: e.clock?.displayValue ?? "" });
	}
	return out;
}

/** Core shots (with ESPN's own xG / xGOT / height) for `joinCoreShots`. */
export function coreShots(events: { type?: { type?: string }; fieldPositionX?: number | null; fieldPositionY?: number | null; expectedGoals?: number; expectedGoalsOnTarget?: number; goalPositionZ?: number }[]): { x: number; y: number; xg?: number; xgot?: number; goalZ?: number }[] {
	return events
		.filter((e) => e.expectedGoals != null && e.fieldPositionX != null && e.fieldPositionY != null && /shot|goal/.test(e.type?.type ?? "") && e.type?.type !== "goal-kick")
		.map((e) => ({ x: e.fieldPositionX as number, y: e.fieldPositionY as number, xg: e.expectedGoals, xgot: e.expectedGoalsOnTarget, goalZ: e.goalPositionZ }));
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
	// Phase 2 — this club's rows from the match:
	keepers?: KeeperLine[];
	gplus?: GplusLine[];
	xpass?: XpassLine[];
	defense?: Record<string, DefAction[]>;
}
export interface SeasonKeeperLine { athleteId: string; matches: number; minutes: number; shotsFaced: number; saves: number; goalsConceded: number; xgotFaced: number; goalsPrevented: number; gplus: GplusActions | null }
export interface SeasonGplusLine { athleteId: string; matches: number; minutes: number; raw: number; aboveAvg: number; actions: GplusActions }
export interface SeasonXpassLine { athleteId: string; matches: number; attempted: number; completionPct: number; xCompletionPct: number; overExpected: number }
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
	// Phase 2 (derived):
	keepers: SeasonKeeperLine[];
	gplus: SeasonGplusLine[];
	/** The club's total g+ (sum of every player's, raw) and how many matches had ASA g+. */
	teamGplus: number;
	gplusMatches: number;
	xpass: SeasonXpassLine[];
	defense: Record<string, DefAction[]>;
	defenseMatches: number;
	updatedAt: number;
}

export function emptySeason(teamId: string, year: number): TeamSeasonAnalytics {
	return { v: 1, teamId, year, contributions: [], matches: 0, xgFor: 0, xgAgainst: 0, xgSources: { asa: 0, estimate: 0 }, players: [], heat: {}, heatMatches: 0,
		keepers: [], gplus: [], teamGplus: 0, gplusMatches: 0, xpass: [], defense: {}, defenseMatches: 0, updatedAt: 0 };
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
		// Each shot against carries the keeper who faced it (most minutes that match) → a keeper's season goal face.
		shotsAgainst: m.shots.filter((s) => s.teamId !== tid).map((s) => {
			const k = [...(m.keepers ?? [])].filter((x) => x.teamId === tid).sort((a, b) => b.minutes - a.minutes)[0];
			return k ? { ...s, keeperId: k.athleteId } : s;
		}),
		players: m.players.filter((p) => p.teamId === tid),
		heat: m.heat ? Object.fromEntries(Object.entries(m.heat).filter(([id]) => m.players.some((p) => p.athleteId === id && p.teamId === tid) || teamOfHeat(m, id) === tid)) : undefined,
		keepers: (m.keepers ?? []).filter((k) => k.teamId === tid),
		gplus: (m.gplus ?? []).filter((g) => g.teamId === tid),
		xpass: (m.xpass ?? []).filter((x) => x.teamId === tid),
		defense: m.defense ? Object.fromEntries(Object.entries(m.defense).filter(([id]) => teamOfHeat(m, id) === tid)) : undefined,
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
	const keepers = new Map<string, SeasonKeeperLine>();
	const gplus = new Map<string, SeasonGplusLine>();
	const xpass = new Map<string, SeasonXpassLine & { completed: number; expected: number }>();
	const defense: Record<string, DefAction[]> = {};
	let gplusMatches = 0, defenseMatches = 0;
	const addActions = (into: GplusActions, from: GplusActions | null) => {
		for (const [k, a] of Object.entries(from ?? {})) {
			const t = (into[k] ??= { raw: 0, aboveAvg: 0, count: 0 });
			t.raw += a.raw; t.aboveAvg += a.aboveAvg; t.count += a.count;
		}
	};
	for (const c of s.contributions) {
		for (const k of c.keepers ?? []) {
			const t = keepers.get(k.athleteId) ?? { athleteId: k.athleteId, matches: 0, minutes: 0, shotsFaced: 0, saves: 0, goalsConceded: 0, xgotFaced: 0, goalsPrevented: 0, gplus: {} };
			t.matches += 1; t.minutes += k.minutes; t.shotsFaced += k.shotsFaced; t.saves += k.saves; t.goalsConceded += k.goalsConceded;
			t.xgotFaced += k.xgotFaced; t.goalsPrevented += k.goalsPrevented; addActions(t.gplus ?? {}, k.gplus);
			keepers.set(k.athleteId, t);
		}
		if (c.gplus?.length) gplusMatches += 1;
		for (const g of c.gplus ?? []) {
			const t = gplus.get(g.athleteId) ?? { athleteId: g.athleteId, matches: 0, minutes: 0, raw: 0, aboveAvg: 0, actions: {} };
			t.matches += 1; t.minutes += g.minutes; t.raw += g.raw; t.aboveAvg += g.aboveAvg; addActions(t.actions, g.actions);
			gplus.set(g.athleteId, t);
		}
		for (const x of c.xpass ?? []) {
			const t = xpass.get(x.athleteId) ?? { athleteId: x.athleteId, matches: 0, attempted: 0, completionPct: 0, xCompletionPct: 0, overExpected: 0, completed: 0, expected: 0 };
			t.matches += 1; t.attempted += x.attempted; t.completed += x.attempted * x.completionPct; t.expected += x.attempted * x.xCompletionPct; t.overExpected += x.overExpected;
			xpass.set(x.athleteId, t);
		}
		if (c.defense && Object.keys(c.defense).length) {
			defenseMatches += 1;
			for (const [id, list] of Object.entries(c.defense)) (defense[id] ??= []).push(...list);
		}
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
		keepers: [...keepers.values()].map((k) => ({ ...k, xgotFaced: r3(k.xgotFaced), goalsPrevented: r3(k.goalsPrevented), gplus: roundActions(k.gplus) })),
		gplus: [...gplus.values()].map((g) => ({ ...g, raw: r3(g.raw), aboveAvg: r3(g.aboveAvg), actions: roundActions(g.actions) ?? {} })).sort((a, b) => b.raw - a.raw),
		teamGplus: r3([...gplus.values()].reduce((n, g) => n + g.raw, 0)),
		gplusMatches,
		xpass: [...xpass.values()].map(({ completed, expected, ...x }) => ({ ...x, completionPct: x.attempted ? r3(completed / x.attempted) : 0, xCompletionPct: x.attempted ? r3(expected / x.attempted) : 0, overExpected: r3(x.overExpected) })),
		defense,
		defenseMatches,
		updatedAt: now,
	};
}

function roundActions(a: GplusActions | null): GplusActions | null {
	if (!a || !Object.keys(a).length) return null;
	return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { raw: r3(v.raw), aboveAvg: r3(v.aboveAvg), count: v.count }]));
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

/** ASA is re-asked at most this many times after the first build (+22h, +44h) for missing xG / g+ depth. */
export const MAX_ASA_RETRIES = 2;
export interface AnalyticsIndexEntry { source: "asa" | "estimate"; asaRetryAfter: number | null; asaRetried?: boolean;
	/** How many ASA retries have run (`asaRetried` = the older one-retry flag, read as 1). */
	asaRetries?: number; heat: MatchAnalytics["heatStatus"]; heatRetryAfter?: number; builtAt: number;
	/** Copy version — a v1 copy (no keepers / g+ / per-shot ASA xG) is rebuilt ONCE to v2. */
	v?: number;
	/** ASA depth present (keepers / g+ / xPass) — the status page counts these. */
	depth?: boolean }
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
			if ((ix.v ?? 1) < 2) return true; // phase-2 upgrade, once (paced by `max` like the backfill)
			const retries = ix.asaRetries ?? (ix.asaRetried ? 1 : 0);
			if (ix.asaRetryAfter !== null && args.now >= ix.asaRetryAfter && retries < MAX_ASA_RETRIES) return true;
			return ix.heat !== "ok" && !args.coreBlocked && args.now >= (ix.heatRetryAfter ?? 0);
		})
		.slice(0, args.max)
		.map((f) => f.eventId);
}
