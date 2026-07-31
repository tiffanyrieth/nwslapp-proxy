// Roster truth — nightly ESPN×NWSL cross-check, plus the owner-override store.
//
// WHY THIS EXISTS. ESPN is the app's roster source and it fails in ways the existing guards
// structurally cannot see. The size floor (`ROSTER_GOOD_MIN`) catches a roster COLLAPSING; it is
// blind to a roster that is full-sized and wrong. Verified live on 2026-07-30 across all 16 clubs
// (`docs/roster-source-research.md` §10):
//   • Kennedy Fuller, Lindsey Heaps (USWNT captain) and Alexa Spaanstra are ERASED from ESPN
//     league-wide despite documented 2026 moves — their clubs' rosters look perfectly healthy.
//   • Trinity Rodman sat mislabelled MIDFIELDER for three weeks, silently corrupting Predict's
//     band bonus, the Bracket's position pools, and KHG's keeper-question logic.
//   • ESPN briefly deleted Orlando Pride as a TEAM; nothing anywhere checks the club count.
//
// THE DESIGN, in one line: verification runs at BUILD time, never at serve time. A nightly cron
// compares the two feeds and writes a report. No user request ever waits on a cross-check, and a
// cross-check can never be the reason a roster fails to load. If SDP is unreachable the run simply
// records less; nothing user-facing changes.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO (each rule paid for by a real specimen):
//   1. Never DELETE an ESPN-only player. A new signing and a fabricated player are indistinguishable
//      from payload shape, and the sweep's membership false-positive rate was 100% — every ESPN-only
//      name was a real signing or a name variance. Bethi and Ngock were recorded as "phantoms" for a
//      day on exactly this mistake.
//   2. Never AUTO-PICK a winner on a position disagreement. SDP was right on Rodman/Girelli/Sanchez
//      but ESPN was right on Sonis; a blanket "prefer the league feed" would have mislabelled
//      Denver's captain. Report it; the owner rules via an override.
//   3. Never trust SDP's `bibNumber` as a current jersey. It carries DUPLICATE numbers on 12 of 16
//      clubs (a departed player's number reassigned, both retained).
//   4. Never judge membership per-player — only in AGGREGATE. Per-player diffs are noise; wholesale
//      divergence is the contamination alarm.
//
// Self-contained like headshots.ts: index.ts imports the entry points only. The SDP/join primitives
// come FROM headshots.ts so the ESPN↔NWSL name join is the one that has been proven at ~98% for
// months — a second copy of the normalization would drift and silently break the join.

import {
	SDP,
	guidOf,
	normalizeName,
	currentNwslSeasonId,
	fetchNwslTeamAbbrs,
} from "./headshots.ts";
import { POSITION_GROUP, mapEspnRosterAthletes, type RosterPlayer } from "./bracket-engine.ts";

const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl";

// ── KV keys ──────────────────────────────────────────────────────────────────────

/** League-wide SDP squad snapshot (~70KB). 30d TTL is a deliberate KILL SWITCH: if the nightly
 *  cron dies the snapshot expires rather than silently ageing into a stale "truth". */
const SDP_SQUADS_KEY = "sdp-squads-v1";
const SDP_SQUADS_TTL = 60 * 60 * 24 * 30;

/** Latest verification report. Carries each club's ESPN names so the NEXT run can measure
 *  night-over-night continuity from one KV read instead of re-fetching yesterday's world. */
const REPORT_KEY = "roster-truth-report-v1";
const REPORT_TTL = 60 * 60 * 24 * 30;

/** Cached SDP season id — saves two `/competitions` setup fetches on most runs (the subrequest
 *  budget is the binding constraint). 7d TTL so the yearly season rollover self-heals. */
const SEASON_KEY = "sdp-season-v1";
const SEASON_TTL = 60 * 60 * 24 * 7;

/** Owner rulings that outrank BOTH feeds. See `applyOverrides`. */
export const OVERRIDES_KEY = "roster-truth:overrides";
/** Overrides are kept well past expiry so the admin portal can still SHOW an expired ruling and
 *  offer to renew it — an entry that simply vanished would make the regression invisible. */
const OVERRIDES_TTL = 60 * 60 * 24 * 365;

// ── Thresholds (every number traceable to a measurement in research §10) ─────────

const SQUAD_MIN = 16; // below this the payload is broken, not a small squad
const SQUAD_MAX = 34; // above this something has merged two clubs
const GK_MIN = 1;
const GK_MAX = 4; // WAS legitimately carried 4 on 2026-07-30; the Spirit's bad "5 keepers" is the floor of implausible
/** Measured ESPN↔SDP name overlap is 93–100% with the shortName index; contamination scores ~0%.
 *  0.80 sits below every real club and far above any substitution event. */
const SDP_OVERLAP_MIN = 0.8;
/** Night-over-night ESPN self-continuity. Squad churn between two nights is tiny; 0.5 only trips
 *  on a wholesale replacement. */
const PRIOR_OVERLAP_MIN = 0.5;
/** An SDP-only player with real minutes is an ESPN ERASURE signal (Fuller/Heaps/Spaanstra). With
 *  zero minutes she is usually a departed or preseason registration — noise, not signal. */
const SDP_ERASURE_MIN_MINUTES = 90;

/** Default life of an owner override. A permanent pin becomes an invisible lie the day the fact
 *  genuinely changes (Rodman really could convert to midfield one season). Expiry is SAFE because
 *  the nightly verifier keeps running: when a ruling lapses while the feeds still disagree, the
 *  mismatch simply reappears in the next report instead of regressing in silence. */
export const OVERRIDE_TTL_DAYS = 90;

// ── Types ────────────────────────────────────────────────────────────────────────

export type Group = "G" | "D" | "M" | "F";

export interface SdpSquadPlayer {
	guid: string;
	name: string; // normalized "first last"
	short: string; // normalized shortName — the mononym index (Debinha, Lorena, Marta…)
	shirt: string; // normalized shirtName
	display: string; // human-readable, for reports
	jersey: string | null; // bibNumber — RECORDED ONLY, never authoritative (dupes on 12/16 clubs)
	role: Group | null;
	minutes: number;
	games: number;
}

export interface SdpSquad {
	teamAbbr: string;
	teamGuid: string;
	teamName: string;
	players: SdpSquadPlayer[];
}

export interface EspnRosterPlayer {
	id: string;
	display: string;
	name: string; // normalized
	jersey: number | null;
	group: Group | null;
	rawPosition: string;
}

export interface EspnTeamRoster {
	teamAbbr: string;
	espnTeamId: string;
	players: EspnRosterPlayer[];
}

export interface GateResult {
	ok: boolean;
	failures: string[];
}

export interface PositionMismatch {
	espnAthleteId: string;
	name: string;
	espn: Group;
	sdp: Group;
	minutes: number;
}

export interface PlayerDiffs {
	/** Rodman class. NEITHER source auto-wins — owner rules via an override. */
	positionMismatches: PositionMismatch[];
	/** Sentnor class: ESPN has no jersey but a matched SDP record does. */
	missingJerseys: { espnAthleteId: string; name: string; sdpJersey: string }[];
	/** Ngock/Bethi class: on ESPN, not (yet) in the league feed. New-signing candidates — NEVER removed. */
	espnOnly: { espnAthleteId: string; name: string; jersey: number | null }[];
	/** Fuller/Heaps/Spaanstra class: the league still lists her with real minutes, ESPN does not. */
	sdpOnlyWithMinutes: { name: string; jersey: string | null; minutes: number }[];
}

export interface ClubReport {
	abbr: string;
	espnCount: number;
	sdpCount: number;
	/** false ⇒ a fetch failed and this club was SKIPPED. Unverified is not the same as failed. */
	verified: boolean;
	gateB: GateResult;
	gateC: GateResult & { sdpOverlap: number; priorOverlap: number | null };
	diffs: PlayerDiffs;
}

export interface RosterTruthReport {
	ranAt: string;
	seasonId: string;
	gateA: GateResult;
	clubs: ClubReport[];
	summary: {
		clubsVerified: number;
		gateFailures: number;
		positionMismatches: number;
		missingJerseys: number;
		espnOnly: number;
		sdpOnlyWithMinutes: number;
	};
	/** Per-club normalized ESPN names — the next run's night-over-night continuity baseline. */
	espnNames: Record<string, string[]>;
}

// ── Overrides ────────────────────────────────────────────────────────────────────

export interface RosterOverride {
	espnAthleteId: string;
	/** Denormalized for the admin UI — the report/roster may not be loaded when rendering. */
	playerName: string;
	teamAbbr: string;
	position?: Group;
	jersey?: number;
	note?: string;
	setAt: string; // ISO
	expiresAt: string; // ISO
}

export type OverrideMap = Record<string, RosterOverride>;

export function overrideExpiry(now: number, days = OVERRIDE_TTL_DAYS): string {
	return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Overrides still in force at `now`. Pure — expiry is evaluated at READ time (rather than by
 *  deleting the KV entry) so a lapsed ruling stays visible and renewable in the portal. */
export function activeOverrides(all: OverrideMap, now: number): OverrideMap {
	const out: OverrideMap = {};
	for (const [id, o] of Object.entries(all ?? {})) {
		if (Date.parse(o.expiresAt) > now) out[id] = o;
	}
	return out;
}

/** Apply owner rulings to an ESPN roster body, in place of what either feed says.
 *
 *  Deliberately NARROW: it can only correct `position` and `jersey` on a player ESPN already
 *  lists. It cannot add or remove anyone — an override is a correction, never a second source of
 *  membership, so a stale ruling can never make a real player disappear.
 *
 *  Returns the (possibly unchanged) body plus which ids were touched, for the diag trail. */
export function applyOverrides(
	body: unknown,
	overrides: OverrideMap,
	now: number,
): { body: unknown; applied: string[] } {
	const active = activeOverrides(overrides, now);
	if (Object.keys(active).length === 0) return { body, applied: [] };
	const athletes = (body as { athletes?: Record<string, unknown>[] })?.athletes;
	if (!Array.isArray(athletes)) return { body, applied: [] };

	const applied: string[] = [];
	const patched = athletes.map((a) => {
		const o = active[String(a?.id ?? "")];
		if (!o) return a;
		const next: Record<string, unknown> = { ...a };
		if (o.position) {
			const pos = (a.position ?? {}) as Record<string, unknown>;
			next.position = {
				...pos,
				abbreviation: o.position,
				displayName: GROUP_LABEL[o.position],
				name: GROUP_LABEL[o.position].toLowerCase(),
			};
		}
		if (o.jersey != null) next.jersey = String(o.jersey);
		// Inert marker: the Swift decoder ignores unknown keys, and it makes an override
		// obvious when eyeballing a raw payload.
		next.proxyOverridden = true;
		applied.push(o.espnAthleteId);
		return next;
	});
	return { body: { ...(body as Record<string, unknown>), athletes: patched }, applied };
}

const GROUP_LABEL: Record<Group, string> = {
	G: "Goalkeeper",
	D: "Defender",
	M: "Midfielder",
	F: "Forward",
};

// ── Pure gates + diffs (the unit-tested surface) ─────────────────────────────────

/** SDP `roleLabel` → position group. Tolerant of label drift; unknown → null (never guessed). */
export function roleLabelToGroup(roleLabel: string | undefined | null): Group | null {
	const s = (roleLabel ?? "").toLowerCase();
	if (!s) return null;
	if (s.includes("keeper")) return "G";
	if (s.includes("defend") || s.includes("back")) return "D";
	if (s.includes("midfield")) return "M";
	if (s.includes("forward") || s.includes("strik") || s.includes("wing") || s.includes("attack")) return "F";
	return null;
}

export function espnGroupOf(position: string): Group | null {
	return POSITION_GROUP[(position ?? "").toUpperCase()] ?? null;
}

/** GATE A — the league still has the clubs we think it has.
 *  Catches ESPN deleting Orlando Pride (observed 2026-07-27) and the cross-provider failure where a
 *  club was renamed to ANOTHER club. SDP's list is authoritative here: the league knows its members. */
export function gateTeamIdentity(espnAbbrs: string[], sdpAbbrs: string[]): GateResult {
	const failures: string[] = [];
	const espn = new Set(espnAbbrs.map((a) => a.toUpperCase()));
	const sdp = new Set(sdpAbbrs.map((a) => a.toUpperCase()));
	if (sdp.size === 0) return { ok: false, failures: ["SDP returned no teams — cannot verify identity"] };
	const missing = [...sdp].filter((a) => !espn.has(a)).sort();
	const extra = [...espn].filter((a) => !sdp.has(a)).sort();
	if (missing.length) failures.push(`ESPN is missing club(s): ${missing.join(", ")}`);
	if (extra.length) failures.push(`ESPN has unknown club(s): ${extra.join(", ")}`);
	if (espn.size !== sdp.size) failures.push(`club count ${espn.size} (ESPN) vs ${sdp.size} (NWSL)`);
	return { ok: failures.length === 0, failures };
}

/** GATE B — the squad is shaped like a squad. Single-payload, no second source needed.
 *  Catches the collapse class (POR→1, ACFC→1) and the "5 goalkeepers" class. */
export function gateShape(r: EspnTeamRoster): GateResult {
	const failures: string[] = [];
	const n = r.players.length;
	if (n < SQUAD_MIN) failures.push(`squad size ${n} (min ${SQUAD_MIN})`);
	else if (n > SQUAD_MAX) failures.push(`squad size ${n} (max ${SQUAD_MAX})`);
	const gk = r.players.filter((p) => p.group === "G").length;
	if (gk < GK_MIN) failures.push(`${gk} goalkeepers (min ${GK_MIN})`);
	else if (gk > GK_MAX) failures.push(`${gk} goalkeepers (max ${GK_MAX})`);
	const jerseys = r.players.map((p) => p.jersey).filter((j): j is number => j != null);
	const dupes = [...new Set(jerseys.filter((j, i) => jerseys.indexOf(j) !== i))].sort((a, b) => a - b);
	if (dupes.length) failures.push(`duplicate jersey(s): ${dupes.join(", ")}`);
	return { ok: failures.length === 0, failures };
}

/** Share of `names` found in the SDP index. The index carries full name + shortName + shirtName
 *  because this league is full of mononyms and legal-vs-known names — Débora Cristiane de Oliveira
 *  IS Debinha. Naive full-name matching measured 89–92%; with this index, 96.3%. */
export function overlapRatio(names: string[], index: Set<string>): number {
	if (names.length === 0) return 0;
	const hit = names.filter((n) => index.has(n)).length;
	return hit / names.length;
}

export function sdpNameIndex(squad: SdpSquad): Set<string> {
	const idx = new Set<string>();
	for (const p of squad.players) {
		if (p.name) idx.add(p.name);
		if (p.short) idx.add(p.short);
		if (p.shirt) idx.add(p.shirt);
	}
	return idx;
}

/** GATE C — are these still the same humans?
 *  The only detector for wholesale contamination, which passes every size/shape check: 24 players
 *  from another sport is a plausible squad. Two independent axes — against the league feed, and
 *  against what ESPN itself said last night. */
export function gateContinuity(
	espn: EspnTeamRoster,
	sdp: SdpSquad | null,
	priorNames: string[] | null,
): GateResult & { sdpOverlap: number; priorOverlap: number | null } {
	const failures: string[] = [];
	const names = espn.players.map((p) => p.name).filter(Boolean);

	const sdpOverlap = sdp ? overlapRatio(names, sdpNameIndex(sdp)) : 1;
	if (sdp && sdpOverlap < SDP_OVERLAP_MIN) {
		failures.push(`only ${Math.round(sdpOverlap * 100)}% of the ESPN squad is known to the league feed`);
	}

	let priorOverlap: number | null = null;
	if (priorNames && priorNames.length > 0) {
		priorOverlap = overlapRatio(priorNames, new Set(names));
		if (priorOverlap < PRIOR_OVERLAP_MIN) {
			failures.push(`only ${Math.round(priorOverlap * 100)}% of last night's squad is still present`);
		}
	}
	return { ok: failures.length === 0, failures, sdpOverlap, priorOverlap };
}

/** GATE D — per-player differences. Observe-only: NEVER a gate failure, never pages.
 *  These are the quiet wrongs (a flipped position, an erased player) that no shape check can see. */
export function diffPlayers(espn: EspnTeamRoster, sdp: SdpSquad | null): PlayerDiffs {
	const diffs: PlayerDiffs = {
		positionMismatches: [],
		missingJerseys: [],
		espnOnly: [],
		sdpOnlyWithMinutes: [],
	};
	if (!sdp) return diffs;

	// Match ESPN → SDP by any name form. Ambiguity (two SDP players sharing a key) is skipped
	// rather than guessed — a wrong join would manufacture a mismatch out of nothing.
	const byKey = new Map<string, SdpSquadPlayer | null>();
	const put = (k: string, p: SdpSquadPlayer) => {
		if (!k) return;
		byKey.set(k, byKey.has(k) ? null : p); // null marks "ambiguous"
	};
	for (const p of sdp.players) {
		put(p.name, p);
		put(p.short, p);
		put(p.shirt, p);
	}

	const matched = new Set<string>();
	for (const e of espn.players) {
		const m = byKey.get(e.name);
		if (!m) {
			if (m === null && byKey.has(e.name)) continue; // ambiguous name — no claim either way
			diffs.espnOnly.push({ espnAthleteId: e.id, name: e.display, jersey: e.jersey });
			continue;
		}
		matched.add(m.guid);
		if (e.group && m.role && e.group !== m.role) {
			diffs.positionMismatches.push({
				espnAthleteId: e.id,
				name: e.display,
				espn: e.group,
				sdp: m.role,
				minutes: m.minutes,
			});
		}
		if (e.jersey == null && m.jersey) {
			diffs.missingJerseys.push({ espnAthleteId: e.id, name: e.display, sdpJersey: m.jersey });
		}
	}

	for (const p of sdp.players) {
		if (matched.has(p.guid)) continue;
		if (p.minutes >= SDP_ERASURE_MIN_MINUTES) {
			diffs.sdpOnlyWithMinutes.push({ name: p.display, jersey: p.jersey, minutes: p.minutes });
		}
	}
	return diffs;
}

export function assembleReport(args: {
	ranAt: string;
	seasonId: string;
	gateA: GateResult;
	clubs: ClubReport[];
	/** Per-club normalized ESPN names, carried forward as the next run's continuity baseline. */
	espnNames?: Record<string, string[]>;
}): RosterTruthReport {
	const { ranAt, seasonId, gateA, clubs, espnNames = {} } = args;
	const sum = (f: (c: ClubReport) => number) => clubs.reduce((n, c) => n + f(c), 0);
	return {
		ranAt,
		seasonId,
		gateA,
		clubs,
		summary: {
			clubsVerified: clubs.filter((c) => c.verified).length,
			gateFailures:
				(gateA.ok ? 0 : gateA.failures.length) +
				sum((c) => c.gateB.failures.length + c.gateC.failures.length),
			positionMismatches: sum((c) => c.diffs.positionMismatches.length),
			missingJerseys: sum((c) => c.diffs.missingJerseys.length),
			espnOnly: sum((c) => c.diffs.espnOnly.length),
			sdpOnlyWithMinutes: sum((c) => c.diffs.sdpOnlyWithMinutes.length),
		},
		espnNames,
	};
}

// ── I/O ──────────────────────────────────────────────────────────────────────────

const stat = (p: { stats?: { statsId?: string; statsValue?: number }[] }, id: string): number =>
	p.stats?.find((s) => s.statsId === id)?.statsValue ?? 0;

/** ⚠️ SINGLE-ATTEMPT ON PURPOSE — see the budget note on `runRosterTruth`. */
async function getJSON<T>(url: string): Promise<T | null> {
	try {
		const r = await fetch(url, { headers: { Accept: "application/json" } });
		if (!r.ok) return null;
		return (await r.json()) as T;
	} catch {
		return null;
	}
}

function toSdpSquad(
	raw: { players?: Record<string, unknown>[] } | null,
	teamAbbr: string,
	teamGuid: string,
	teamName: string,
): SdpSquad {
	const players: SdpSquadPlayer[] = [];
	for (const p of raw?.players ?? []) {
		// Placeholder rows (team "TBC") exist in this feed and are not people.
		if (p.isTeamFake) continue;
		const display = `${p.mediaFirstName ?? ""} ${p.mediaLastName ?? ""}`.trim();
		const guid = p.playerId ? guidOf(String(p.playerId)) : "";
		if (!guid || !display) continue;
		const bib = p.bibNumber == null || p.bibNumber === "" ? null : String(p.bibNumber);
		players.push({
			guid,
			name: normalizeName(display),
			short: normalizeName(String(p.shortName ?? "")),
			shirt: normalizeName(String(p.shirtName ?? "")),
			display,
			jersey: bib,
			role: roleLabelToGroup(p.roleLabel as string),
			minutes: stat(p as never, "minutes-played"),
			games: stat(p as never, "games-played"),
		});
	}
	return { teamAbbr, teamGuid, teamName, players };
}

function toEspnRoster(players: RosterPlayer[], abbr: string, espnTeamId: string): EspnTeamRoster {
	return {
		teamAbbr: abbr,
		espnTeamId,
		players: players.map((p) => ({
			id: p.id,
			display: p.name,
			name: normalizeName(p.name),
			jersey: p.jersey,
			group: espnGroupOf(p.position),
			rawPosition: p.position,
		})),
	};
}

export type EmitBatch = (events: { kind: string; detail: string }[]) => void;

interface RosterTruthEnv {
	FEED_TAGS: KVNamespace;
}

/** Run one verification pass over all 16 clubs and persist the report + SDP snapshot.
 *
 *  ⚠️ SUBREQUEST BUDGET is the governing constraint: a free-plan Worker invocation gets 50, and KV
 *  operations count. The plan is ~39 (1 season KV read + 1 SDP teams + 1 ESPN teams + 16 ESPN
 *  rosters + 16 SDP squads + 1 prior-report read + 2 writes + 1 batched diag). Two rules keep it
 *  there, and breaking either will silently start failing runs:
 *    • NO RETRIES. A failed club fetch marks that club `verified: false` and moves on — nightly
 *      cadence and the admin re-run are the retry.
 *    • ONE batched diag write, never one per finding.
 */
export async function runRosterTruth(env: RosterTruthEnv, emit: EmitBatch): Promise<RosterTruthReport> {
	const ranAt = new Date().toISOString();

	// Season id — cached, because resolving it costs two fetches we'd rather spend on clubs.
	let seasonId = "";
	const cachedSeason = (await env.FEED_TAGS.get(SEASON_KEY, "json")) as { seasonId?: string } | null;
	if (cachedSeason?.seasonId) seasonId = cachedSeason.seasonId;
	else {
		seasonId = await currentNwslSeasonId();
		await env.FEED_TAGS.put(SEASON_KEY, JSON.stringify({ seasonId, resolvedAt: ranAt }), {
			expirationTtl: SEASON_TTL,
		});
	}

	const [sdpTeamMap, espnTeamsRaw] = await Promise.all([
		fetchNwslTeamAbbrs(seasonId),
		getJSON<{ sports?: { leagues?: { teams?: { team?: { id?: string; abbreviation?: string; displayName?: string } }[] }[] }[] }>(
			`${ESPN_SITE}/teams`,
		),
	]);

	const espnTeams = (espnTeamsRaw?.sports?.[0]?.leagues?.[0]?.teams ?? [])
		.map((t) => ({ id: t.team?.id ?? "", abbr: (t.team?.abbreviation ?? "").toUpperCase() }))
		.filter((t) => t.id && t.abbr);
	const sdpTeams = [...sdpTeamMap.entries()].map(([guid, abbr]) => ({ guid, abbr }));

	const gateA = gateTeamIdentity(espnTeams.map((t) => t.abbr), sdpTeams.map((t) => t.abbr));

	const prior = (await env.FEED_TAGS.get(REPORT_KEY, "json")) as RosterTruthReport | null;
	const priorNames = prior?.espnNames ?? {};

	// One fetch each per club, in parallel — a club that fails is skipped, never retried.
	const squads: SdpSquad[] = [];
	const clubs: ClubReport[] = [];
	const namesByClub: Record<string, string[]> = {};

	await Promise.all(
		espnTeams.map(async (t) => {
			const sdpTeam = sdpTeams.find((s) => s.abbr === t.abbr);
			const [espnRaw, sdpRaw] = await Promise.all([
				getJSON<Parameters<typeof mapEspnRosterAthletes>[0]>(`${ESPN_SITE}/teams/${t.id}/roster`),
				sdpTeam
					? getJSON<{ players?: Record<string, unknown>[] }>(
							`${SDP}/seasons/${seasonId}/stats/players?teamId=${sdpTeam.guid}`,
						)
					: Promise.resolve(null),
			]);

			if (!espnRaw) {
				clubs.push({
					abbr: t.abbr,
					espnCount: -1,
					sdpCount: -1,
					verified: false,
					gateB: { ok: true, failures: [] },
					gateC: { ok: true, failures: [], sdpOverlap: 1, priorOverlap: null },
					diffs: { positionMismatches: [], missingJerseys: [], espnOnly: [], sdpOnlyWithMinutes: [] },
				});
				return;
			}

			const espn = toEspnRoster(mapEspnRosterAthletes(espnRaw, t.abbr), t.abbr, t.id);
			const squad = sdpTeam ? toSdpSquad(sdpRaw, t.abbr, sdpTeam.guid, t.abbr) : null;
			if (squad) squads.push(squad);
			namesByClub[t.abbr] = espn.players.map((p) => p.name);

			clubs.push({
				abbr: t.abbr,
				espnCount: espn.players.length,
				sdpCount: squad?.players.length ?? -1,
				verified: true,
				gateB: gateShape(espn),
				gateC: gateContinuity(espn, squad, priorNames[t.abbr] ?? null),
				diffs: diffPlayers(espn, squad),
			});
		}),
	);

	clubs.sort((a, b) => a.abbr.localeCompare(b.abbr));
	const report = assembleReport({ ranAt, seasonId, gateA, clubs, espnNames: namesByClub });

	await Promise.all([
		env.FEED_TAGS.put(
			SDP_SQUADS_KEY,
			JSON.stringify({ builtAt: ranAt, seasonId, teams: squads }),
			{ expirationTtl: SDP_SQUADS_TTL },
		),
		env.FEED_TAGS.put(REPORT_KEY, JSON.stringify(report), { expirationTtl: REPORT_TTL }),
	]);

	// ONE batched emit. Gate failures page (severity scales with blast radius: a single club is 1-2
	// events and stays under the alert threshold, while a contamination or a deleted team fails many
	// clubs at once and crosses it). The summary is a breadcrumb and never pages.
	const events: { kind: string; detail: string }[] = [];
	if (!gateA.ok) for (const f of gateA.failures) events.push({ kind: "rosterTruthGateFail", detail: `A ${f}` });
	for (const c of clubs) {
		for (const f of c.gateB.failures) events.push({ kind: "rosterTruthGateFail", detail: `B ${c.abbr} ${f}` });
		for (const f of c.gateC.failures) events.push({ kind: "rosterTruthGateFail", detail: `C ${c.abbr} ${f}` });
	}
	const s = report.summary;
	events.push({
		kind: "rosterTruthSummary",
		detail: `${s.clubsVerified}/16 ok, ${s.positionMismatches} pos, ${s.espnOnly} espnOnly, ${s.sdpOnlyWithMinutes} erased`,
	});
	emit(events.slice(0, 20));

	return report;
}

/** Latest report for the admin portal. */
export async function readRosterTruthReport(env: RosterTruthEnv): Promise<RosterTruthReport | null> {
	return (await env.FEED_TAGS.get(REPORT_KEY, "json")) as RosterTruthReport | null;
}

export async function readOverrides(env: RosterTruthEnv): Promise<OverrideMap> {
	return ((await env.FEED_TAGS.get(OVERRIDES_KEY, "json")) as OverrideMap | null) ?? {};
}

export async function writeOverrides(env: RosterTruthEnv, map: OverrideMap): Promise<void> {
	await env.FEED_TAGS.put(OVERRIDES_KEY, JSON.stringify(map), { expirationTtl: OVERRIDES_TTL });
}
