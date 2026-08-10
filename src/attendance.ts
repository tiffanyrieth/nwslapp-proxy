// Attendance backstop (2026-08-11) — proactive 30-day sweep + NWSL cross-reference.
//
// WHY THIS EXISTS: attendance re-checks used to be DEMAND-driven — a settled summary with
// attendance 0 was only re-fetched when someone OPENED that match after its edge TTL lapsed.
// At small user counts that is "never re-checks" (the banned current-usage lens, inverted).
// And in Aug 2026 ESPN's attendance ingestion went spotty for weeks (owner-observed), which
// defeats the feature: a match here and there is fine, weeks of blanks is not.
//
// WHAT IT DOES: every ~6h (KV-gated on the 5-min cron) it sweeps the last 30 days of finished
// matches whose attendance is still unknown and asks BOTH sources itself:
//   1. ESPN's summary (`gameInfo.attendance`) — a late-landing figure is picked up within hours
//      instead of waiting for a visitor;
//   2. NWSL's own matchfacts endpoint (`enviroment.numberOfSpectators` — their typo), the
//      league's keyless SDP API, discovered via their match-page widget bundle. Same Opta
//      upstream as ESPN, so it can't fill gaps that are empty at the league (verified live
//      2026-08-11: 6/6 matches agree with ESPN, nulls included) — but it is a second door to
//      the same warehouse, so an ESPN-side ingestion break can no longer blank the app.
// Found figures land in the KV LEDGER (`attendance:{espnEventId}`), and the /summary route's
// enrich hook patches them into a settled summary body on the next cache MISS (the one
// narrowly-scoped exception to the bytes-unchanged pass-through — see docs/backend.md).
//
// The full six-source research (why no other source can help: club recaps carry no figures,
// Wikipedia is aggregates-only, FBref/FotMob/Sofascore/FootyStats are bot-walled and
// Opta-fed) is recorded in docs/backend.md — do not re-litigate it from scratch.

import { ESPN_HEADERS } from "./espn-ua";

// Self-declared ESPN bases (index.ts's consts aren't importable without a cycle; these are the
// same stable strings). NWSL default only — the backstop deliberately covers NWSL matches, not
// the NT/cup feeds (their venues rarely report attendance at all, and the app renders their
// absence honestly).
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard";
const ESPN_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/summary";

const SDP_BASE = "https://api-sdp.nwslsoccer.com/v1/nwsl/football";
/** Season GUIDs, keyed by year — the SDP API addresses everything by these (captured live;
 *  2026's is also recorded in docs/roster-source-research.md). A missing year emits a diag so
 *  the sweep degrades to ESPN-only instead of failing silently at the season rollover. */
const NWSL_SEASON_GUIDS: Record<string, string> = {
	"2026": "nwsl::Football_Season::0b6761e4701749f593690c0f338da74c",
};

const LEDGER_PREFIX = "attendance:";
const SWEEP_GATE_KEY = "attendance-sweep:last"; // outside the ledger prefix so list() stays clean
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // ~4 sweeps/day
const SWEEP_WINDOW_DAYS = 30; // matches SUMMARY_PENDING_MAX_AGE_MS (owner: keep trying ~30 days)
const LEDGER_TTL_SECONDS = 60 * 24 * 3600; // self-cleaning well after the window closes

type Emit = (kind: string, detail: string) => void;

interface AttendanceEnv {
	FEED_TAGS: KVNamespace;
}

/** One banked figure. `source` says which door produced it (espn = late ESPN ingest,
 *  nwsl = the league feed had it while ESPN didn't). */
export interface AttendanceRecord {
	n: number;
	source: "espn" | "nwsl";
	at: string;
}

/** Decode a ledger value defensively — a malformed record reads as absent, never throws. */
export function decodeAttendanceRecord(raw: string | null): AttendanceRecord | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as Partial<AttendanceRecord>;
		if (typeof v.n !== "number" || v.n <= 0) return null;
		if (v.source !== "espn" && v.source !== "nwsl") return null;
		return { n: v.n, source: v.source, at: typeof v.at === "string" ? v.at : "" };
	} catch {
		return null;
	}
}

// ── Pure pieces (exported for tests) ────────────────────────────────────────────────────────

/** The minimal scoreboard-event shape the sweep reads. */
interface SweepEvent {
	id?: string;
	date?: string;
	status?: { type?: { state?: string; completed?: boolean } };
	competitions?: Array<{
		attendance?: number;
		competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }>;
	}>;
}

/** A finished-and-settled match still missing its crowd figure. Suspended/unsettled matches
 *  (`completed: false`) are excluded — their 0 is "not over yet", not "never reported". */
export function isSweepCandidate(event: SweepEvent): boolean {
	const type = event.status?.type;
	if (type?.state !== "post" || type.completed === false) return false;
	return !((event.competitions?.[0]?.attendance ?? 0) > 0);
}

/** The SDP match shape the join reads. */
interface SdpMatch {
	matchId?: string;
	matchDateUtc?: string;
	home?: { acronymName?: string };
}

/** Join an ESPN event to its SDP matchId by UTC calendar date (±1 day for timezone-boundary
 *  listings) + home-team acronym. ESPN abbreviations and SDP acronymNames agree for all 16
 *  clubs (the headshots pipeline has joined on them for months). nil when no match. */
export function joinSdpMatch(
	espn: { dateUTC: string; homeAbbr: string },
	sdpMatches: SdpMatch[],
): string | null {
	const day = espn.dateUTC.slice(0, 10);
	if (day.length !== 10) return null;
	const dayMs = Date.parse(`${day}T00:00:00Z`);
	if (!Number.isFinite(dayMs)) return null;
	for (const m of sdpMatches) {
		if (m.home?.acronymName !== espn.homeAbbr || !m.matchId || !m.matchDateUtc) continue;
		const mMs = Date.parse(`${m.matchDateUtc.slice(0, 10)}T00:00:00Z`);
		if (!Number.isFinite(mMs)) continue;
		if (Math.abs(mMs - dayMs) <= 24 * 3600 * 1000) return m.matchId;
	}
	return null;
}

/**
 * Patch a settled summary body's missing attendance with a ledger figure.
 *
 * ⚠️ THE ONE ALLOWED MUTATION on the pass-through (docs/backend.md + docs/decisions.md,
 * owner-approved 2026-08-11): fill `gameInfo.attendance` when it is 0/absent on a SETTLED
 * match, with a league-verified figure. Nothing else in the body may ever be touched.
 * Returns null when no patch applies (not settled, attendance already present, no gameInfo,
 * malformed body) — the caller serves the original bytes unchanged.
 */
export function patchAttendance(body: ArrayBuffer, n: number): ArrayBuffer | null {
	if (!(n > 0)) return null;
	try {
		const json = JSON.parse(new TextDecoder().decode(body)) as {
			header?: {
				competitions?: Array<{ status?: { type?: { state?: string; completed?: boolean } } }>;
			};
			gameInfo?: { attendance?: number };
		};
		const type = json.header?.competitions?.[0]?.status?.type;
		if (type?.state !== "post" || type.completed === false) return null;
		if (!json.gameInfo || (json.gameInfo.attendance ?? 0) > 0) return null;
		json.gameInfo.attendance = n;
		return new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
	} catch {
		return null;
	}
}

// ── The enrich hook (/summary MISS path) ────────────────────────────────────────────────────

/** Serve-side half of the backstop: on a summary MISS, fill a settled-but-zero attendance from
 *  the ledger. Parses the body once (the TTL chooser parses MISS bodies anyway — same cost
 *  class); hits KV only when the body actually needs a figure. Never throws; the original
 *  bytes pass through untouched on any miss/failure. */
export async function enrichSummaryAttendance(
	env: AttendanceEnv,
	eventId: string | null,
	body: ArrayBuffer,
): Promise<ArrayBuffer> {
	if (!eventId) return body;
	// Cheap applicability probe: patch with a sentinel figure — null means "nothing to fill"
	// (not settled / already has a crowd / malformed), so we skip the KV read entirely.
	if (patchAttendance(body, 1) === null) return body;
	const record = decodeAttendanceRecord(await env.FEED_TAGS.get(LEDGER_PREFIX + eventId));
	if (!record) return body;
	return patchAttendance(body, record.n) ?? body;
}

// ── The sweep (cron) ────────────────────────────────────────────────────────────────────────

const dayStamp = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");

/**
 * The proactive half: probe both sources for every finished match of the last 30 days still
 * missing a figure. Gated to ~every 6h; `force` (the admin page's sweep button) bypasses the
 * gate. Returns a small report for the admin page. Best-effort throughout — a failed source
 * skips that candidate and the next sweep retries.
 */
export async function attendanceSweep(
	env: AttendanceEnv,
	emit: Emit,
	force = false,
): Promise<{ ran: boolean; candidates: number; found: number }> {
	const now = Date.now();
	if (!force) {
		const last = Number(await env.FEED_TAGS.get(SWEEP_GATE_KEY));
		if (Number.isFinite(last) && now - last < SWEEP_INTERVAL_MS) {
			return { ran: false, candidates: 0, found: 0 };
		}
	}
	// Stamp BEFORE the work (checkErrorSpike's pattern): a failing sweep must not re-hammer
	// ESPN every 5 minutes — it retries on the next 6h tick.
	await env.FEED_TAGS.put(SWEEP_GATE_KEY, String(now));

	// 1. The last-30-days WINDOWED scoreboard — small (~15-20 events) and fresh ESPN-side
	// (the full-season `dates=` query is the one ESPN serves stale and the one whose 2MB
	// parse blew the CPU cap — never fetch that here). `_cb` forces a recompute.
	const from = dayStamp(new Date(now - SWEEP_WINDOW_DAYS * 24 * 3600 * 1000));
	const to = dayStamp(new Date(now));
	let events: SweepEvent[] = [];
	try {
		const res = await fetch(
			`${ESPN_SCOREBOARD}?dates=${from}-${to}&limit=100&_cb=${now}`,
			{ headers: ESPN_HEADERS },
		);
		if (!res.ok) throw new Error(`scoreboard ${res.status}`);
		events = ((await res.json()) as { events?: SweepEvent[] }).events ?? [];
	} catch (e) {
		emit("apiFailure", `attendance sweep scoreboard: ${(e as Error).message.slice(0, 60)}`);
		return { ran: true, candidates: 0, found: 0 };
	}

	// 2. Candidates not already banked.
	const candidates: SweepEvent[] = [];
	for (const event of events.filter(isSweepCandidate)) {
		if (!event.id) continue;
		if (await env.FEED_TAGS.get(LEDGER_PREFIX + event.id)) continue;
		candidates.push(event);
	}
	if (candidates.length === 0) return { ran: true, candidates: 0, found: 0 };

	// 3. Probe both sources per candidate. The SDP season list (the matchfacts join table) is
	// fetched lazily, once, only if some candidate gets past the ESPN probe.
	let sdpMatches: SdpMatch[] | null = null;
	let espnFound = 0;
	let nwslFound = 0;
	for (const event of candidates) {
		const eventId = event.id;
		if (!eventId) continue;
		let espnN = 0;
		try {
			const res = await fetch(`${ESPN_SUMMARY}?event=${eventId}&_cb=${Date.now()}`, {
				headers: ESPN_HEADERS,
			});
			if (res.ok) {
				const summary = (await res.json()) as { gameInfo?: { attendance?: number } };
				espnN = summary.gameInfo?.attendance ?? 0;
			}
		} catch {
			// fall through to the league feed
		}

		let nwslN = 0;
		if (sdpMatches === null && espnN <= 0) sdpMatches = await fetchSdpMatches(emit);
		if (espnN <= 0 && sdpMatches && sdpMatches.length > 0) {
			const home = event.competitions?.[0]?.competitors?.find((c) => c.homeAway === "home");
			const matchId =
				event.date && home?.team?.abbreviation
					? joinSdpMatch({ dateUTC: event.date, homeAbbr: home.team.abbreviation }, sdpMatches)
					: null;
			if (matchId) nwslN = await fetchMatchfactsSpectators(matchId, emit);
		}

		const n = espnN > 0 ? espnN : nwslN;
		if (n <= 0) continue;
		// Cross-source disagreement is observe-mode (the roster-truth philosophy): prefer ESPN
		// (it's the number the rest of the app's data would eventually show) and say so loudly.
		if (espnN > 0 && nwslN > 0 && espnN !== nwslN) {
			emit("attendanceCrossSource", `event ${eventId}: espn ${espnN} vs nwsl ${nwslN}`);
		}
		const record: AttendanceRecord = {
			n,
			source: espnN > 0 ? "espn" : "nwsl",
			at: new Date(now).toISOString(),
		};
		await env.FEED_TAGS.put(LEDGER_PREFIX + eventId, JSON.stringify(record), {
			expirationTtl: LEDGER_TTL_SECONDS,
		});
		if (espnN > 0) espnFound++;
		else nwslFound++;
	}

	// Quiet runs stay quiet — a diag every 6h forever would be noise, not signal.
	if (espnFound + nwslFound > 0) {
		emit(
			"attendanceSweep",
			`found ${espnFound + nwslFound} of ${candidates.length} (espn ${espnFound} / nwsl ${nwslFound})`,
		);
	}
	return { ran: true, candidates: candidates.length, found: espnFound + nwslFound };
}

/** The SDP season match list (the join table). Empty on any failure — the sweep then simply
 *  runs ESPN-only this tick. */
async function fetchSdpMatches(emit: Emit): Promise<SdpMatch[]> {
	const year = String(new Date().getUTCFullYear());
	const guid = NWSL_SEASON_GUIDS[year];
	if (!guid) {
		emit("apiFailure", `attendance sweep: no SDP season GUID for ${year} — capture it (see attendance.ts)`);
		return [];
	}
	try {
		const res = await fetch(`${SDP_BASE}/seasons/${guid}/matches`, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) throw new Error(`sdp matches ${res.status}`);
		const parsed = (await res.json()) as SdpMatch[] | { matches?: SdpMatch[] };
		return Array.isArray(parsed) ? parsed : (parsed.matches ?? []);
	} catch (e) {
		emit("apiFailure", `attendance sweep sdp: ${(e as Error).message.slice(0, 60)}`);
		return [];
	}
}

/** One matchfacts probe → the league's spectator count (0 = absent/unreported/failed). */
async function fetchMatchfactsSpectators(matchId: string, emit: Emit): Promise<number> {
	const year = String(new Date().getUTCFullYear());
	const guid = NWSL_SEASON_GUIDS[year];
	if (!guid) return 0;
	try {
		const res = await fetch(`${SDP_BASE}/seasons/${guid}/match/${matchId}/matchfacts`, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) return 0;
		// "enviroment" is the league API's own spelling — do not correct it.
		const facts = (await res.json()) as { enviroment?: { numberOfSpectators?: number } };
		return facts.enviroment?.numberOfSpectators ?? 0;
	} catch (e) {
		emit("apiFailure", `attendance matchfacts ${matchId.slice(-8)}: ${(e as Error).message.slice(0, 40)}`);
		return 0;
	}
}

// ── Admin surface ───────────────────────────────────────────────────────────────────────────

/** GET /admin/attendance (owner-authed by the caller): the ledger + sweep state, and
 *  `?sweep=1` to force a run (verification / owner spot-checks). Plain JSON — an ops read. */
export async function handleAdminAttendance(
	env: AttendanceEnv,
	emit: Emit,
	forceSweep: boolean,
): Promise<Response> {
	const sweep = forceSweep ? await attendanceSweep(env, emit, true) : null;
	const list = await env.FEED_TAGS.list({ prefix: LEDGER_PREFIX, limit: 100 });
	const ledger: Record<string, AttendanceRecord | null> = {};
	for (const key of list.keys) {
		ledger[key.name.slice(LEDGER_PREFIX.length)] = decodeAttendanceRecord(
			await env.FEED_TAGS.get(key.name),
		);
	}
	const lastSweep = Number(await env.FEED_TAGS.get(SWEEP_GATE_KEY));
	return new Response(
		JSON.stringify(
			{
				lastSweep: Number.isFinite(lastSweep) && lastSweep > 0 ? new Date(lastSweep).toISOString() : null,
				forcedSweep: sweep,
				ledger,
			},
			null,
			2,
		),
		{ headers: { "Content-Type": "application/json" } },
	);
}
