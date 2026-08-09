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
import { ESPN_HEADERS } from "./espn-ua.ts";

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

/** Per-club pass/fail from the latest run — the small key `/roster` consults at serve time
 *  (tweak 2, owner-approved 2026-07-31). A club whose last verification FAILED is held on its
 *  last-known-good copy until it passes again; healthy clubs keep serving live. 48h TTL is the
 *  kill switch: if the cron dies the verdicts expire and serving falls open to live-first. */
export const VERDICTS_KEY = "roster-truth-verdicts-v1";
const VERDICTS_TTL = 60 * 60 * 48;

export interface VerdictMap {
	at: string;
	/** Keyed by ESPN team id (the `?team=` param `/roster` receives). */
	clubs: Record<string, { abbr: string; ok: boolean }>;
}

/** Owner rulings that outrank BOTH feeds. See `applyOverrides`. */
export const OVERRIDES_KEY = "roster-truth:overrides";
/** Overrides are kept well past expiry so the admin portal can still SHOW an expired ruling and
 *  offer to renew it — an entry that simply vanished would make the regression invisible. */
const OVERRIDES_TTL = 60 * 60 * 24 * 365;

// ── Thresholds (every number traceable to a measurement in research §10) ─────────

const SQUAD_MIN = 16; // below this the payload is broken, not a small squad
const SQUAD_MAX = 34; // above this something has merged two clubs
const GK_MIN = 1;
/** ⚠️ A raw keeper COUNT cannot detect the "5 goalkeepers" failure, and the first live run proved
 *  it: Louisville genuinely carries 5, listed identically by BOTH feeds (Bloomer, Roque, Sekany,
 *  Floyd, Prohaska), while the Spirit's bad 5 was fabrication. Same number, opposite meanings.
 *  So the single-payload bound is only what is physically impossible; the real test is
 *  `GK_DISAGREE_MIN` below, which asks the league rather than a constant. */
const GK_MAX = 6;
/** ESPN vs league keeper-count gap that means something is wrong. The Spirit incident was ESPN 5
 *  against a true 3 — a gap of 2. Deep-squad differences of 1 are routine (one feed retains a
 *  departed keeper) and must not cry wolf. */
const GK_DISAGREE_MIN = 2;
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

// ── Matchday jerseys — THE THIRD SOURCE, and the best one ────────────────────────
//
// WHY (2026-08-03, Khyah Harper). ESPN's roster field is the app's jersey source and it is often
// BLANK for a recent signing; SDP's `bibNumber` can't be trusted either (rule 3 above — duplicates
// on 12/16 clubs, and it lags a transfer by 1-3 weeks). That leaves a real dispute nothing on-feed
// can settle, so it goes to the weekly adjudication routine and gets answered from a club website.
//
// But a MATCH LINEUP carries the number the player actually wore. `/summary` → `rosters[]` lists
// every matchday squad member, starter AND substitute, with her jersey. We already fetch and cache
// that payload for Predict, Match Detail and the watcher's lineup push, so this source is free.
//
// The specimen: Harper transferred Gotham → Houston on 2026-07-28. ESPN had jersey `null`; SDP said
// 34 — which was also her OLD Gotham number, so "the feed is just lagging the transfer" was a
// perfectly reasonable read, and wrong. She dressed for Houston on 08-02 wearing 34. The lineup had
// the answer ~32h before the routine ran, and settles it in a way neither roster feed nor a
// plausibility argument can.
//
// RANKING: matchday > ESPN roster field > SDP bibNumber. A number a player was actually listed
// under on a teamsheet outranks any squad-list field.
//
// LIMIT (deliberate, stated rather than hidden): this can only answer for players who have DRESSED.
// Someone who has never made a matchday squad still falls through to the routine — which is the
// right trade, because an unused player's number is also the one that matters least.

/** How far back to look for a matchday squad. Three weeks spans several matchdays for every club
 *  while staying short enough that a mid-season number change isn't answered from stale data. */
const MATCHDAY_WINDOW_DAYS = 21;
/** Hard cap on `/summary` fetches per run.
 *
 *  ⚠️ THIS NUMBER IS A BUDGET, NOT A PREFERENCE, and the earlier arithmetic here understated it.
 *  The free plan allows **50 subrequests per invocation**. The verification run itself spends ~40
 *  (16 clubs × 2 feeds = 32, + setup, + **3** KV writes: SDP_SQUADS / REPORT / VERDICTS). The
 *  matchday block then adds, worst case: `readOverrides` (1 KV read) + the scoreboard (1) + up to
 *  MAX summaries + `writeOverrides` (1 KV write). So at MAX = N the run's worst case is ~40 + 3 + N.
 *  At the old N = 6 that is ~49 — margin of ~1, not the "~4" the old comment claimed, and a
 *  season-cache miss or a 17th club would tip it over 50 and fail the WHOLE nightly run.
 *  N = 4 restores a ~3 margin. The cost is negligible: the loop stops the moment every question is
 *  answered (both live 2026-08-03 specimens took TWO), and anything unresolved falls through to the
 *  weekly routine — degrading across nights, never breaking. Re-check this arithmetic before raising
 *  it or adding a 17th club. */
const MATCHDAY_MAX_SUMMARIES = 4;

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
	/** Almost certainly ONE person the two feeds spell differently — paired because they wear the
	 *  same number for the same club. Split out so they stop being double-counted as an erasure
	 *  AND an addition. See `pairNameVariances`. */
	likelyNameVariances: { espnAthleteId: string; espnName: string; sdpName: string; jersey: string }[];
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
		likelyNameVariances: number;
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
	/** Set by the weekly adjudication routine, never by the portal's pin buttons. An auto ruling
	 *  may replace another auto ruling but NEVER an owner pin — the owner outranks the robot. */
	auto?: boolean;
	/** Citation URL — the club roster page (or fallback source) the ruling was read from. Makes
	 *  every pin defensible: "Defender, per denversummitfc.com/…, checked <date>". REQUIRED on
	 *  auto rulings; optional on owner pins. */
	source?: string;
}

/** One ruling from the weekly adjudication routine. The routine only posts what it could resolve
 *  from an authoritative page — an unresolved mismatch is simply not posted (declining is free). */
export interface AutoRuling {
	espnAthleteId: string;
	playerName: string;
	teamAbbr: string;
	position?: Group;
	jersey?: number;
	source: string;
}

const VALID_GROUPS = new Set<string>(["G", "D", "M", "F"]);

/** Apply a batch of auto rulings to the override map. Pure — the endpoint wires KV around it.
 *
 *  Server-side rules (enforced HERE, not trusted to the routine's prompt):
 *  - a ruling without a SOURCE URL is rejected (an unsupported pin is worse than the mismatch);
 *  - an owner pin is never overwritten (auto may only replace auto);
 *  - position must be one of G/D/M/F; jersey a non-negative integer; one of the two required;
 *  - structurally, rulings can only CORRECT a listed player — membership is untouchable because
 *    `applyOverrides` can never add or remove anyone. */
export function applyAutoRulings(
	overrides: OverrideMap,
	rulings: AutoRuling[],
	now: number,
): { next: OverrideMap; accepted: string[]; skipped: { espnAthleteId: string; reason: string }[] } {
	const next: OverrideMap = { ...overrides };
	const accepted: string[] = [];
	const skipped: { espnAthleteId: string; reason: string }[] = [];

	for (const r of rulings) {
		const id = String(r?.espnAthleteId ?? "");
		if (!id) {
			skipped.push({ espnAthleteId: "?", reason: "missing espnAthleteId" });
			continue;
		}
		if (typeof r.source !== "string" || !/^https?:\/\//.test(r.source)) {
			skipped.push({ espnAthleteId: id, reason: "missing/invalid source URL" });
			continue;
		}
		const hasPos = r.position != null;
		const hasJersey = r.jersey != null;
		if (!hasPos && !hasJersey) {
			skipped.push({ espnAthleteId: id, reason: "no position or jersey" });
			continue;
		}
		if (hasPos && !VALID_GROUPS.has(String(r.position))) {
			skipped.push({ espnAthleteId: id, reason: `invalid position "${r.position}"` });
			continue;
		}
		if (hasJersey && (!Number.isInteger(r.jersey) || (r.jersey as number) < 0)) {
			skipped.push({ espnAthleteId: id, reason: `invalid jersey "${r.jersey}"` });
			continue;
		}
		const existing = next[id];
		if (existing && !existing.auto && Date.parse(existing.expiresAt) > now) {
			skipped.push({ espnAthleteId: id, reason: "owner pin in force — not overwritten" });
			continue;
		}
		// ⚠️ CARRY FORWARD an IN-FORCE auto override's fields. This object REPLACES `existing`, so
		// without this a jersey-only ruling (position unset) landing on a player who already has an
		// auto POSITION override would DROP the position — and `pendingAdjudications` then suppresses
		// her position mismatch for the full 90 days, because any active override hides it from the
		// work list. New signings are exactly the cohort with both a blank jersey AND a wrong
		// position, so the nightly matchday jersey pass makes that collision recurring. Preserving
		// the in-force position (and vice versa for jersey) keeps both corrections alive; an EXPIRED
		// override is not carried, so it correctly re-adjudicates.
		const inForce = existing && existing.auto && Date.parse(existing.expiresAt) > now ? existing : undefined;
		const position = r.position ?? inForce?.position;
		const jersey = r.jersey ?? inForce?.jersey;
		next[id] = {
			espnAthleteId: id,
			playerName: String(r.playerName ?? inForce?.playerName ?? id),
			teamAbbr: String(r.teamAbbr ?? inForce?.teamAbbr ?? ""),
			...(position != null ? { position } : {}),
			...(jersey != null ? { jersey } : {}),
			setAt: new Date(now).toISOString(),
			expiresAt: overrideExpiry(now),
			auto: true,
			source: r.source,
		};
		accepted.push(id);
	}
	return { next, accepted, skipped };
}

/** The routine's work list: open position/jersey mismatches with NO active override. Pure. */
export function pendingAdjudications(
	report: RosterTruthReport | null,
	overrides: OverrideMap,
	now: number,
): {
	positions: (PositionMismatch & { teamAbbr: string })[];
	jerseys: { espnAthleteId: string; name: string; teamAbbr: string; sdpJersey: string }[];
} {
	const active = activeOverrides(overrides, now);
	const positions: (PositionMismatch & { teamAbbr: string })[] = [];
	const jerseys: { espnAthleteId: string; name: string; teamAbbr: string; sdpJersey: string }[] = [];
	for (const c of report?.clubs ?? []) {
		for (const m of c.diffs.positionMismatches) {
			if (!active[m.espnAthleteId]) positions.push({ ...m, teamAbbr: c.abbr });
		}
		for (const j of c.diffs.missingJerseys) {
			if (!active[j.espnAthleteId]) jerseys.push({ ...j, teamAbbr: c.abbr });
		}
	}
	return { positions, jerseys };
}

// ── Matchday jersey extraction (pure) ────────────────────────────────────────────

/** One `/summary` payload, only the shape we read. */
interface SummaryPayload {
	rosters?: {
		team?: { abbreviation?: string };
		roster?: { jersey?: string | number | null; athlete?: { id?: string; displayName?: string } }[];
	}[];
}

/** One scoreboard event, only the shape we read. */
export interface ScoreboardEvent {
	id?: string;
	date?: string;
	competitions?: { competitors?: { team?: { abbreviation?: string } }[] }[];
}

export interface MatchdayJersey {
	jersey: number;
	teamAbbr: string;
	/** ISO kickoff of the match this was read from — later wins on conflict. */
	date: string;
	/** Citation, satisfying `applyAutoRulings`'s source-URL rule. */
	source: string;
}

/** athleteId → jersey, from ONE match summary. Pure.
 *
 *  Both sides of the match are read: a jersey is a fact about the player regardless of which club
 *  we were asking about. Entries without an id or a numeric jersey are skipped rather than
 *  guessed — a blank on a teamsheet means the same thing as a blank on a roster. */
export function jerseysFromSummary(
	summary: SummaryPayload | null,
	eventId: string,
	date: string,
): Map<string, MatchdayJersey> {
	const out = new Map<string, MatchdayJersey>();
	const source = `${ESPN_SITE}/summary?event=${eventId}`;
	for (const side of summary?.rosters ?? []) {
		const teamAbbr = (side.team?.abbreviation ?? "").toUpperCase();
		for (const entry of side.roster ?? []) {
			const id = String(entry.athlete?.id ?? "");
			if (!id) continue;
			const raw = entry.jersey;
			if (raw == null || raw === "") continue;
			const jersey = Number(raw);
			if (!Number.isInteger(jersey) || jersey < 0) continue;
			out.set(id, { jersey, teamAbbr, date, source });
		}
	}
	return out;
}

/** Which matches to spend a `/summary` fetch on. Pure.
 *
 *  NEWEST FIRST, because a number can change and the most recent teamsheet is the current truth —
 *  and because the newest match is also the one most likely to include a just-signed player. Only
 *  matches involving a club we have a question about are considered; everything else is spend for
 *  nothing. Capped so the nightly run can't blow its subrequest budget on a busy fortnight. */
export function pickMatchdayEvents(
	events: ScoreboardEvent[],
	clubs: Set<string>,
	max = MATCHDAY_MAX_SUMMARIES,
): { id: string; date: string }[] {
	return (events ?? [])
		.filter((e) => {
			if (!e.id) return false;
			const abbrs = (e.competitions?.[0]?.competitors ?? [])
				.map((c) => (c.team?.abbreviation ?? "").toUpperCase());
			return abbrs.some((a) => clubs.has(a));
		})
		.map((e) => ({ id: String(e.id), date: String(e.date ?? "") }))
		.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
		.slice(0, max);
}

/** Merge a match's jerseys into the running map, newest-wins. Pure. */
export function mergeMatchdayJerseys(
	into: Map<string, MatchdayJersey>,
	from: Map<string, MatchdayJersey>,
): Map<string, MatchdayJersey> {
	for (const [id, v] of from) {
		const prev = into.get(id);
		if (!prev || prev.date < v.date) into.set(id, v);
	}
	return into;
}

/** Turn resolvable pending jersey questions into rulings. Pure.
 *
 *  ⚠️ It rules on the JERSEY ONLY. Position is a separate question with separate evidence, and
 *  collapsing the two is exactly how the 2026-08-03 Harper writeup let a well-sourced position
 *  carry an unsourced number. A teamsheet is authoritative about the shirt and says nothing about
 *  whether she is a forward.
 *
 *  A player whose matchday jersey ALREADY equals what SDP proposed still produces a ruling: the
 *  point is not that the two disagree, it's that ESPN is blank and the teamsheet can fill it with
 *  something better than a guess. */
export function matchdayRulings(
	pending: { espnAthleteId: string; name: string; teamAbbr: string }[],
	jerseys: Map<string, MatchdayJersey>,
): { rulings: AutoRuling[]; unresolved: string[] } {
	const rulings: AutoRuling[] = [];
	const unresolved: string[] = [];
	for (const p of pending) {
		const hit = jerseys.get(p.espnAthleteId);
		if (!hit) {
			unresolved.push(p.espnAthleteId);
			continue;
		}
		rulings.push({
			espnAthleteId: p.espnAthleteId,
			playerName: p.name,
			teamAbbr: p.teamAbbr,
			jersey: hit.jersey,
			source: hit.source,
		});
	}
	return { rulings, unresolved };
}

/** Answer as many open jersey questions as recent teamsheets can. Fetches only when there is
 *  something to answer, so a clean night costs ZERO subrequests.
 *
 *  `fetchJson` is injected so the orchestration is testable without network. */
export async function resolveJerseysFromMatchday(
	pending: { espnAthleteId: string; name: string; teamAbbr: string }[],
	now: number,
	fetchJson: <T>(url: string) => Promise<T | null> = getJSON,
): Promise<{ rulings: AutoRuling[]; unresolved: string[]; matchesRead: number }> {
	if (!pending.length) return { rulings: [], unresolved: [], matchesRead: 0 };

	const clubs = new Set(pending.map((p) => p.teamAbbr.toUpperCase()));
	const end = new Date(now);
	const start = new Date(now - MATCHDAY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
	const stamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
	const board = await fetchJson<{ events?: ScoreboardEvent[] }>(
		`${ESPN_SITE}/scoreboard?dates=${stamp(start)}-${stamp(end)}&limit=200`,
	);

	const targets = pickMatchdayEvents(board?.events ?? [], clubs);
	let jerseys = new Map<string, MatchdayJersey>();
	let matchesRead = 0;
	// Sequential, newest first, and it STOPS as soon as every question is answered — the common
	// case is one fetch. Parallelising would spend the whole cap every time for no gain.
	for (const t of targets) {
		const summary = await fetchJson<SummaryPayload>(`${ESPN_SITE}/summary?event=${t.id}`);
		matchesRead++;
		jerseys = mergeMatchdayJerseys(jerseys, jerseysFromSummary(summary, t.id, t.date));
		if (pending.every((p) => jerseys.has(p.espnAthleteId))) break;
	}

	return { ...matchdayRulings(pending, jerseys), matchesRead };
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

	// Keeper count judged against the LEAGUE, not a constant — see GK_MAX. Louisville's real 5 and
	// the Spirit's fabricated 5 are indistinguishable by count; they differ in whether the league
	// agrees. Both feeds saying 5 is a deep keeper corps; ESPN alone saying 5 is the bug.
	if (sdp) {
		const espnGk = espn.players.filter((p) => p.group === "G").length;
		const sdpGk = sdp.players.filter((p) => p.role === "G").length;
		if (Math.abs(espnGk - sdpGk) >= GK_DISAGREE_MIN) {
			failures.push(`${espnGk} goalkeepers on ESPN vs ${sdpGk} in the league feed`);
		}
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
		likelyNameVariances: [],
	};
	if (!sdp) return diffs;

	// Match ESPN → SDP by any name form. Ambiguity (two DIFFERENT SDP players sharing a key) is
	// skipped rather than guessed — a wrong join would manufacture a mismatch out of nothing.
	//
	// ⚠️ The identity check on `guid` is load-bearing, not defensive: a player's own name forms
	// frequently normalize to the SAME string (Temwa Chawinga's shortName IS her full name; Izzy
	// Rodriguez's shirtName is; Lorena's shortName and shirtName are both "Lorena"). Treating that
	// as a collision made ~50 players unmatchable, and because an unmatched SDP player looks exactly
	// like one ESPN dropped, they all surfaced as fake "erased by ESPN" findings on the first run.
	const byKey = new Map<string, SdpSquadPlayer | null>();
	const put = (k: string, p: SdpSquadPlayer) => {
		if (!k) return;
		const cur = byKey.get(k);
		if (cur === undefined) byKey.set(k, p); // first sighting
		else if (cur && cur.guid !== p.guid) byKey.set(k, null); // genuinely two people → unusable
		// same player again, or already-null: leave as is
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

	const unmatchedSdp = sdp.players.filter((p) => !matched.has(p.guid));

	// Pair up the leftovers that are really ONE person spelled two ways, before either side is
	// reported. Without this the same human appears twice — as an ESPN addition AND as a league
	// erasure — which is half the noise on a real run.
	const { variances, espnOnly, sdpOnly } = pairNameVariances(diffs.espnOnly, unmatchedSdp);
	diffs.likelyNameVariances = variances;
	diffs.espnOnly = espnOnly;
	for (const p of sdpOnly) {
		if (p.minutes >= SDP_ERASURE_MIN_MINUTES) {
			diffs.sdpOnlyWithMinutes.push({ name: p.display, jersey: p.jersey, minutes: p.minutes });
		}
	}
	return diffs;
}

/** Pair unmatched ESPN players with unmatched league players **by shirt number**.
 *
 *  Within one squad a number identifies a person, so a leftover on each side wearing the same
 *  number is overwhelmingly a spelling difference rather than one arrival plus one departure.
 *  Verified against all 16 clubs on 2026-07-30 — this rule pairs every known variance and
 *  mis-pairs none, because a genuinely erased player (Fuller #47, Heaps #10, Spaanstra #30) has no
 *  same-numbered counterpart on the ESPN side:
 *      Maitane #77 = Maitane López · Mary Hardin #18 = Cate Hardin · Lizbeth Ovalle #13 =
 *      Jacqueline Ovalle · Amelia Van Zanten #16 = Amelia Donna Van Zanten · Sam Meza #20 =
 *      Samantha Meza · Paige Monaghan #4 = Paige Cronin (married name) · Nicki Hernández #20 =
 *      Nicolette Hernández
 *  Players with no number can't be paired this way and stay on their own side — correctly, since
 *  Bethi (a real signing with no number yet) must keep showing up as an ESPN-only addition. */
export function pairNameVariances(
	espnOnly: PlayerDiffs["espnOnly"],
	sdpUnmatched: SdpSquadPlayer[],
): {
	variances: PlayerDiffs["likelyNameVariances"];
	espnOnly: PlayerDiffs["espnOnly"];
	sdpOnly: SdpSquadPlayer[];
} {
	const variances: PlayerDiffs["likelyNameVariances"] = [];
	const usedSdp = new Set<string>();
	const usedEspn = new Set<string>();

	for (const e of espnOnly) {
		if (e.jersey == null) continue;
		const hit = sdpUnmatched.find((s) => !usedSdp.has(s.guid) && s.jersey != null && Number(s.jersey) === e.jersey);
		if (!hit) continue;
		usedSdp.add(hit.guid);
		usedEspn.add(e.espnAthleteId);
		variances.push({
			espnAthleteId: e.espnAthleteId,
			espnName: e.name,
			sdpName: hit.display,
			jersey: String(e.jersey),
		});
	}
	return {
		variances,
		espnOnly: espnOnly.filter((e) => !usedEspn.has(e.espnAthleteId)),
		sdpOnly: sdpUnmatched.filter((s) => !usedSdp.has(s.guid)),
	};
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
			likelyNameVariances: sum((c) => c.diffs.likelyNameVariances.length),
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
		// ESPN_HEADERS carries the mandatory UA — ESPN 403s UA-less Worker fetches (2026-08-04 rule;
		// this helper was missed by that sweep and blanked the nightly verification on 8/07–8/08).
		const r = await fetch(url, { headers: ESPN_HEADERS });
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
	const verdictClubs: VerdictMap["clubs"] = {};

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
				// Unverified ≠ failed: a fetch blip must not hold a club on its cached copy.
				verdictClubs[t.id] = { abbr: t.abbr, ok: true };
				clubs.push({
					abbr: t.abbr,
					espnCount: -1,
					sdpCount: -1,
					verified: false,
					gateB: { ok: true, failures: [] },
					gateC: { ok: true, failures: [], sdpOverlap: 1, priorOverlap: null },
					diffs: { positionMismatches: [], missingJerseys: [], espnOnly: [], sdpOnlyWithMinutes: [], likelyNameVariances: [] },
				});
				return;
			}

			const espn = toEspnRoster(mapEspnRosterAthletes(espnRaw, t.abbr), t.abbr, t.id);
			const squad = sdpTeam ? toSdpSquad(sdpRaw, t.abbr, sdpTeam.guid, t.abbr) : null;
			if (squad) squads.push(squad);
			namesByClub[t.abbr] = espn.players.map((p) => p.name);

			const gateB = gateShape(espn);
			const gateC = gateContinuity(espn, squad, priorNames[t.abbr] ?? null);
			verdictClubs[t.id] = { abbr: t.abbr, ok: gateB.ok && gateC.ok };
			clubs.push({
				abbr: t.abbr,
				espnCount: espn.players.length,
				sdpCount: squad?.players.length ?? -1,
				verified: true,
				gateB,
				gateC,
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
		env.FEED_TAGS.put(
			VERDICTS_KEY,
			JSON.stringify({ at: ranAt, clubs: verdictClubs } satisfies VerdictMap),
			{ expirationTtl: VERDICTS_TTL },
		),
	]);

	// Answer what recent teamsheets can, BEFORE the weekly routine ever sees it. Best-effort by
	// construction: a failure here must never fail the verification run, which has already been
	// written above. On a night with nothing pending this spends just ONE KV read (`readOverrides`,
	// which is needed to compute `pending`) and no fetches; only a night with an open jersey question
	// spends the scoreboard + summaries + the write.
	let matchdayResolved = 0;
	let matchdayRead = 0;
	try {
		const now = Date.parse(ranAt);
		const overrides = await readOverrides(env);
		const pending = pendingAdjudications(report, overrides, now);
		if (pending.jerseys.length) {
			const { rulings, matchesRead } = await resolveJerseysFromMatchday(pending.jerseys, now);
			matchdayRead = matchesRead;
			if (rulings.length) {
				const { next, accepted } = applyAutoRulings(overrides, rulings, now);
				if (accepted.length) {
					await writeOverrides(env, next);
					matchdayResolved = accepted.length;
				}
			}
		}
	} catch (e) {
		emit([{ kind: "rosterTruthRunFail", detail: `matchday ${(e as Error).message.slice(0, 60)}` }]);
	}

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
		detail: `${s.clubsVerified}/16 ok, ${s.positionMismatches} pos, ${s.espnOnly} espnOnly, `
			+ `${s.sdpOnlyWithMinutes} erased, matchday ${matchdayResolved} fixed/${matchdayRead} read`,
	});
	emit(events.slice(0, 20));

	return report;
}

/** Latest report for the admin portal. */
export async function readRosterTruthReport(env: RosterTruthEnv): Promise<RosterTruthReport | null> {
	return (await env.FEED_TAGS.get(REPORT_KEY, "json")) as RosterTruthReport | null;
}

export async function readVerdicts(env: RosterTruthEnv): Promise<VerdictMap | null> {
	return (await env.FEED_TAGS.get(VERDICTS_KEY, "json")) as VerdictMap | null;
}

export async function readOverrides(env: RosterTruthEnv): Promise<OverrideMap> {
	return ((await env.FEED_TAGS.get(OVERRIDES_KEY, "json")) as OverrideMap | null) ?? {};
}

export async function writeOverrides(env: RosterTruthEnv, map: OverrideMap): Promise<void> {
	await env.FEED_TAGS.put(OVERRIDES_KEY, JSON.stringify(map), { expirationTtl: OVERRIDES_TTL });
}
