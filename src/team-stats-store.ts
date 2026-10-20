// PLAYER SEASON STATS — one saved copy per club, refreshed only after that club plays (2026-10-20).
//
// WHY: stats used to be re-downloaded from ESPN on an HOURLY timer per team (team pages + a second,
// separate Know Her Game copy) — an AI default with no reason, though a club's season totals only change
// after it plays: in a normal week 1 of 168 refreshes carried new information. ESPN's stats API
// (`sports.core.api.espn.com …/athletes/{id}/statistics`) then started answering 403 to every Cloudflare
// request (2026-10-17 at the latest), which blanked team-page leaders and every Know Her Game pick.
//
// NOW (owner decisions 2026-10-20, docs/backend.md ESPN section):
//   • ESPN copy (`stats:espn:{teamId}:{year}`) — refreshed ONCE per club ~2h after each of its settled
//     regular-season matches (the scheduler in index.ts `maybeScheduleStatsRefresh`), never on request.
//   • NWSL copy (`stats:nwsl:{teamId}:{year}`) — the BACKUP, written by the nightly roster-truth run from
//     the league feed it ALREADY downloads (`stats/players?teamId=`): zero extra calls.
//   • Every reader (team page, Know Her Game, the Monday stat questions, the bracket) reads these copies.
//     No reader ever triggers an ESPN stats call.
// Copies live in the ContentStore Durable Object — never KV (KV writes are reserved for live matches).
// Stats always use ESPN key names ("general.starts", "offensive.totalGoals", …) so readers see one shape.

import type { ContentStore, ContentPut } from "./content-store.ts";

export type StatsSource = "espn" | "nwsl";

export interface StatsPlayer {
	athleteId: string;
	name: string;
	jersey: number | null;
	position: string;
	age?: number | null;
	country?: string | null;
	stats: Record<string, number>;
}

export interface TeamStatsCopy {
	source: StatsSource;
	teamId: string;
	teamAbbr: string;
	year: number;
	fetchedAt: number;
	/** ESPN copy: the settled match this refresh was for. NWSL copy: null (nightly). */
	basedOnEventId: string | null;
	/** Sum of every player's appearances — season stats are cumulative, so a bigger sum = newer data. */
	appearancesTotal: number;
	/** ESPN lag retry: ESPN hadn't posted the match yet, try once more after this (ms). */
	retryAfter?: number | null;
	/** The lag retry already ran for basedOnEventId. */
	retried?: boolean;
	players: StatsPlayer[];
}

export const statsKey = (source: StatsSource, teamId: string, year: number) => `stats:${source}:${teamId}:${year}`;
/** Durable ESPN-refused marker (ms until): SELF refresh runs land in different isolates, so the per-isolate
 *  backoff in fetchStatsReport can't coordinate them — this one can. */
export const STATS_ESPN_BLOCK_KEY = "stats:espn-blocked-until";
export const STATS_ESPN_BLOCK_MS = 6 * 3600 * 1000;
/** Refresh a club this long after KICKOFF (~2h after the final whistle — ESPN posts season totals late). */
export const STATS_REFRESH_AFTER_KICKOFF_MS = 4 * 3600 * 1000;
/** ESPN lag retry: when a refresh shows no new appearances, try once more this much later. */
export const STATS_LAG_RETRY_MS = 22 * 3600 * 1000;
/** At most this many clubs per 30-min scheduling check (each refresh ≈ 29 ESPN calls, own invocation). */
export const STATS_REFRESH_PER_CHECK = 4;

// ── NWSL (SDP) → ESPN key names ──────────────────────────────────────────────────────────────────
// Live-verified 2026-10-20 against `stats/players?teamId=` (BAY). Each ESPN key lists SDP ids in order of
// preference; the first one present wins. Keep this the ONLY place the league feed's names are known.
export const SDP_TO_ESPN: Record<string, string[]> = {
	"general.starts": ["Starts"],
	"general.minutes": ["minutes-played"],
	"general.appearances": ["Appearances", "games-played"],
	"offensive.totalGoals": ["Goals", "goals"],
	"offensive.goalAssists": ["Goal Assists", "assists"],
	"offensive.totalShots": ["Total Shots"],
	"offensive.shotsOnTarget": ["Shots On Target ( inc goals )"],
	"offensive.shotAssists": ["Key Passes (Attempt Assists)"],
	"goalKeeping.saves": ["Saves Made", "saves"],
	"goalKeeping.cleanSheet": ["Clean Sheets"],
	"defensive.totalTackles": ["Total Tackles"],
	"defensive.effectiveTackles": ["Tackles Won"],
	"defensive.interceptions": ["Interceptions"],
};

/** One league-feed player's `stats[]` → ESPN-keyed numbers. `goalKeeping.shotsFaced` (the bracket's save%
 *  seeding) is derived as saves + goals conceded, the shots-on-target a keeper faced. */
export function sdpStatsToEspn(stats: { statsId?: string; statsValue?: number | null }[] | undefined): Record<string, number> {
	const byId = new Map<string, number>();
	for (const s of stats ?? []) {
		if (s?.statsId && typeof s.statsValue === "number" && Number.isFinite(s.statsValue)) byId.set(s.statsId, s.statsValue);
	}
	const out: Record<string, number> = {};
	for (const [espnKey, ids] of Object.entries(SDP_TO_ESPN)) {
		const hit = ids.find((id) => byId.has(id));
		if (hit) out[espnKey] = byId.get(hit) as number;
	}
	// Keepers only: `Saves Made` is keeper-only in the feed, while outfielders carry `saves: 0` AND their team's
	// goals conceded while on the pitch (a midfielder would otherwise "face" 41 shots).
	const conceded = byId.get("Goals Conceded") ?? byId.get("goals-conceded");
	if (byId.has("Saves Made") && conceded != null) out["goalKeeping.shotsFaced"] = (byId.get("Saves Made") as number) + conceded;
	return out;
}

export function appearancesTotal(players: StatsPlayer[]): number {
	return players.reduce((n, p) => n + (p.stats["general.appearances"] ?? 0), 0);
}

// ── Choosing a copy ──────────────────────────────────────────────────────────────────────────────

export interface ResolvedTeamStats {
	players: StatsPlayer[];
	source: StatsSource | "mixed";
	asOf: number;
}

/** ESPN is the primary. The NWSL copy wins only when it holds STRICTLY more appearances (it caught a match
 *  ESPN hasn't posted, or ESPN is blocked and its copy is old). Any player missing from the chosen copy is
 *  filled from the other one (the league feed lags new signings 1–3 weeks; ESPN can drop a player). */
export function resolveTeamStats(espn: TeamStatsCopy | null, nwsl: TeamStatsCopy | null): ResolvedTeamStats | null {
	if (!espn && !nwsl) return null;
	const primary = espn && (!nwsl || espn.appearancesTotal >= nwsl.appearancesTotal) ? espn : (nwsl as TeamStatsCopy);
	const other = primary === espn ? nwsl : espn;
	const have = new Set(primary.players.map((p) => p.athleteId));
	const filled = (other?.players ?? []).filter((p) => !have.has(p.athleteId));
	return {
		players: [...primary.players, ...filled],
		source: filled.length > 0 ? "mixed" : primary.source,
		asOf: primary.fetchedAt,
	};
}

// ── Scheduling the ESPN refresh ──────────────────────────────────────────────────────────────────

export interface SettledMatch {
	eventId: string;
	teamIds: string[];
	kickoffMs: number;
	/** A playoff match — match analytics include these; the regular-season stats refresh skips them. */
	playoff?: boolean;
}

/** Each club's most recent settled regular-season match. */
export function latestMatchByTeam(finals: SettledMatch[]): Map<string, SettledMatch> {
	const out = new Map<string, SettledMatch>();
	for (const m of finals) {
		for (const t of m.teamIds) {
			const cur = out.get(t);
			if (!cur || m.kickoffMs > cur.kickoffMs) out.set(t, m);
		}
	}
	return out;
}

/** Which clubs to refresh now: their latest settled match is ≥ STATS_REFRESH_AFTER_KICKOFF_MS old and their
 *  ESPN copy isn't based on it yet — or the one-time lag retry is due. Nothing while ESPN is refused. */
export function planStatsRefresh(args: {
	finals: SettledMatch[];
	espnCopies: Map<string, TeamStatsCopy | null>;
	now: number;
	blockedUntil: number;
	max?: number;
}): { teamId: string; eventId: string }[] {
	if (args.now < args.blockedUntil) return [];
	const due: { teamId: string; eventId: string; kickoffMs: number }[] = [];
	for (const [teamId, m] of latestMatchByTeam(args.finals)) {
		if (args.now < m.kickoffMs + STATS_REFRESH_AFTER_KICKOFF_MS) continue;
		const copy = args.espnCopies.get(teamId) ?? null;
		const newMatch = !copy || copy.basedOnEventId !== m.eventId;
		const lagRetry = !!copy && copy.basedOnEventId === m.eventId && !copy.retried && !!copy.retryAfter && args.now >= copy.retryAfter;
		if (newMatch || lagRetry) due.push({ teamId, eventId: m.eventId, kickoffMs: m.kickoffMs });
	}
	due.sort((a, b) => a.kickoffMs - b.kickoffMs); // oldest pending first
	return due.slice(0, args.max ?? STATS_REFRESH_PER_CHECK).map(({ teamId, eventId }) => ({ teamId, eventId }));
}

/** The copy an ESPN refresh writes, with the lag-retry bookkeeping: a refresh for a NEW match that shows no
 *  more appearances than before means ESPN hasn't posted it yet → schedule one retry; the retry itself
 *  clears the flag either way (then the club waits for its next match). */
export function nextEspnCopy(args: {
	prev: TeamStatsCopy | null;
	teamId: string;
	teamAbbr: string;
	year: number;
	eventId: string;
	players: StatsPlayer[];
	now: number;
}): TeamStatsCopy {
	const total = appearancesTotal(args.players);
	const isRetry = !!args.prev && args.prev.basedOnEventId === args.eventId;
	const lagging = !isRetry && !!args.prev && total <= args.prev.appearancesTotal;
	return {
		source: "espn",
		teamId: args.teamId,
		teamAbbr: args.teamAbbr,
		year: args.year,
		fetchedAt: args.now,
		basedOnEventId: args.eventId,
		appearancesTotal: total,
		retryAfter: lagging ? args.now + STATS_LAG_RETRY_MS : null,
		retried: isRetry,
		players: args.players,
	};
}

/** Settled regular-season matches out of a full-season ESPN scoreboard body. Settled = `post` AND not
 *  `completed:false` AND no explicit non-final status (fail-open on a sparse payload, like chooseSummaryTTL);
 *  preseason / playoff slugs are excluded (playoffs don't touch the regular-season totals, types/1). */
export const NON_FINAL_STATUS = new Set([
	"STATUS_SUSPENDED", "STATUS_POSTPONED", "STATUS_DELAYED", "STATUS_CANCELED", "STATUS_CANCELLED", "STATUS_ABANDONED",
]);
export function settledRegularSeasonMatches(scoreboard: unknown): SettledMatch[] {
	return settledMatches(scoreboard).filter((m) => !m.playoff);
}

/** Every settled regular-season AND playoff match (playoffs flagged); preseason excluded. */
export function settledMatches(scoreboard: unknown): SettledMatch[] {
	const events = ((scoreboard as { events?: unknown[] } | null)?.events ?? []) as {
		id?: string;
		date?: string;
		season?: { slug?: string };
		status?: { type?: { state?: string; completed?: boolean; name?: string } };
		competitions?: { competitors?: { team?: { id?: string } }[]; status?: { type?: { state?: string; completed?: boolean; name?: string } } }[];
	}[];
	const out: SettledMatch[] = [];
	for (const e of events) {
		const slug = (e.season?.slug ?? "").toLowerCase();
		if (slug.startsWith("preseason")) continue;
		const st = e.status?.type ?? e.competitions?.[0]?.status?.type;
		if (st?.state !== "post" || st.completed === false || (st.name && NON_FINAL_STATUS.has(st.name))) continue;
		const kickoffMs = Date.parse(e.date ?? "");
		const teamIds = (e.competitions?.[0]?.competitors ?? []).map((c) => String(c.team?.id ?? "")).filter(Boolean);
		if (!e.id || Number.isNaN(kickoffMs) || teamIds.length !== 2) continue;
		out.push({ eventId: String(e.id), teamIds, kickoffMs, ...(slug.startsWith("playoffs") ? { playoff: true } : {}) });
	}
	return out;
}

// ── Storage (ContentStore DO — the same singleton index.ts uses) ─────────────────────────────────

export interface StatsStoreEnv {
	CONTENT_STORE?: DurableObjectNamespace;
}

function store(env: StatsStoreEnv): DurableObjectStub<ContentStore> | null {
	const ns = env.CONTENT_STORE;
	if (!ns) return null;
	// Same id + location as index.ts `contentStoreStub` — one store.
	return ns.get(ns.idFromName("content"), { locationHint: "enam" }) as unknown as DurableObjectStub<ContentStore>;
}

function parseCopy(v: string | null | undefined): TeamStatsCopy | null {
	if (!v) return null;
	try {
		const c = JSON.parse(v) as TeamStatsCopy;
		return c && Array.isArray(c.players) ? c : null;
	} catch {
		return null;
	}
}

/** Both copies for each club, in ONE store call. Throws when the store is unbound/unreachable (the caller
 *  decides: a route answers an error, the app falls back to its phone path). */
export async function readTeamStatsCopies(
	env: StatsStoreEnv,
	teamIds: string[],
	year: number,
): Promise<Map<string, { espn: TeamStatsCopy | null; nwsl: TeamStatsCopy | null }>> {
	const s = store(env);
	if (!s) throw new Error("stats store unbound");
	const keys = teamIds.flatMap((t) => [statsKey("espn", t, year), statsKey("nwsl", t, year)]);
	const got = (await s.getMany(keys)) as Record<string, string | null>;
	const out = new Map<string, { espn: TeamStatsCopy | null; nwsl: TeamStatsCopy | null }>();
	for (const t of teamIds) out.set(t, { espn: parseCopy(got[statsKey("espn", t, year)]), nwsl: parseCopy(got[statsKey("nwsl", t, year)]) });
	return out;
}

/** Resolved stats for one club (null = no copy of either kind yet). */
export async function readResolvedTeamStats(env: StatsStoreEnv, teamId: string, year: number): Promise<ResolvedTeamStats | null> {
	const c = (await readTeamStatsCopies(env, [teamId], year)).get(teamId);
	return c ? resolveTeamStats(c.espn, c.nwsl) : null;
}

/** athleteId → stats across the given clubs (resolved per club) — the Monday stat questions + the bracket. */
export async function readStatsByAthlete(env: StatsStoreEnv, teamIds: string[], year: number): Promise<Map<string, Record<string, number>>> {
	const copies = await readTeamStatsCopies(env, teamIds, year);
	const out = new Map<string, Record<string, number>>();
	for (const c of copies.values()) {
		for (const p of resolveTeamStats(c.espn, c.nwsl)?.players ?? []) out.set(p.athleteId, p.stats);
	}
	return out;
}

export async function readNumber(env: StatsStoreEnv, key: string): Promise<number> {
	const s = store(env);
	if (!s) return 0;
	const v = ((await s.getMany([key])) as Record<string, string | null>)[key];
	const n = v == null ? 0 : Number(v);
	return Number.isFinite(n) ? n : 0;
}

/** Write copies (and optional plain entries) in ONE store call. Returns false if the store refused. */
export async function writeStats(env: StatsStoreEnv, copies: TeamStatsCopy[], extra: ContentPut[] = []): Promise<boolean> {
	const s = store(env);
	if (!s) return false;
	const entries: ContentPut[] = [
		...copies.map((c) => ({ key: statsKey(c.source, c.teamId, c.year), value: JSON.stringify(c) })),
		...extra,
	];
	if (entries.length === 0) return true;
	const res = (await s.putMany(entries)) as { stored: number; oversize: string[] };
	return res.oversize.length === 0;
}
