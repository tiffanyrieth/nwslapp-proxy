// Player headshots — the NWSL↔ESPN id-mapping layer. ESPN returns zero headshots for
// NWSL athletes, but nwslsoccer.com serves every player's photo on its Cloudinary CDN keyed
// by an opaque NWSL GUID. The app keys every player by ESPN athlete id, so this module's job
// is to produce a `{ espnAthleteId: nwslGuid }` map. The app then builds the Cloudinary URL
// on-device (`…/t_w_240/…/players/{guid}`) and loads it through its existing ImageCache; a
// missing photo 404s → the app keeps its jersey-number monogram.
//
// Self-contained on purpose (like bracket-engine.ts): index.ts imports only the two entry
// points — `buildHeadshotMap` (cron + admin POST /headshots/run) and `handleHeadshots`
// (GET /headshots). The NWSL side comes from the public, no-auth SDP JSON API
// (api-sdp.nwslsoccer.com); the ESPN side from the same /teams + /roster endpoints the
// bracket engine uses. Matching is by normalized full name, disambiguated by team — the only
// join, since the two providers share no player id (see Guardrails in the handoff).

// ── Data sources ──────────────────────────────────────────────────────────────

const SDP = "https://api-sdp.nwslsoccer.com/v1/nwsl/football";
const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl";

const MAP_KEY = "headshot-map-v1"; // KV: { [espnAthleteId]: nwslGuid }
const OVERRIDES_KEY = "headshots:overrides"; // KV: { [espnAthleteId]: nwslGuid } — owner-curated
const UNMATCHED_KEY = "headshots:unmatched"; // KV: audit list of ESPN players with no NWSL match
const META_KEY = "headshots:meta"; // KV: build stats for an at-a-glance health check
const HEADSHOTS_TTL = 6 * 3600; // 6h edge cache — the map changes ~weekly (cron) at most

// `playerId`/`teamId` arrive as `nwsl::Football_Player::{32-hex guid}`; we want the guid.
function guidOf(compoundId: string): string {
	return compoundId.split("::").pop() ?? "";
}

// Strip accents + punctuation, lowercase, collapse spaces — so "Lo'eau LaBonta" and
// "Loeau LaBonta", or "Sveindís" and "Sveindis", compare equal. Name is the only join key
// between ESPN and NWSL, so normalization is the whole ballgame.
function normalizeName(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "") // combining diacritics
		.toLowerCase()
		.replace(/[^a-z\s]/g, " ") // drop apostrophes, periods, hyphens
		.replace(/\s+/g, " ")
		.trim();
}

// ── NWSL side (SDP JSON API) ────────────────────────────────────────────────────

interface NwslPlayer {
	guid: string;
	name: string; // normalized "first last" (mediaFirstName + mediaLastName)
	short: string; // normalized shortName — the nickname for mononym players (Marta, Debinha…)
	teamAbbr: string;
}

// Resolve the current NWSL season id: /competitions → the entry literally named "NWSL"
// (the regular-season league, not Challenge Cup / Fall Series / etc.) → its seasons, newest
// by start date. Resolved dynamically so the yearly rollover needs no code change.
async function currentNwslSeasonId(): Promise<string> {
	const comps = (await (await fetch(`${SDP}/competitions`)).json()) as {
		competitions?: { competitionId?: string; name?: string }[];
	};
	const comp = (comps.competitions ?? []).find((c) => c.name === "NWSL");
	if (!comp?.competitionId) throw new Error("headshots: NWSL competition not found");

	const seasons = (await (await fetch(`${SDP}/competitions/${comp.competitionId}/seasons`)).json()) as {
		seasons?: { seasonId?: string; startDateUtc?: string | null }[];
	};
	const sorted = (seasons.seasons ?? [])
		.filter((s) => s.seasonId)
		.sort((a, b) => (b.startDateUtc ?? "").localeCompare(a.startDateUtc ?? ""));
	if (!sorted[0]?.seasonId) throw new Error("headshots: no NWSL season found");
	return sorted[0].seasonId;
}

// teamId → abbreviation (acronymName, e.g. "WAS"), so each player's team resolves to the
// same abbreviation key the app and ESPN use.
async function fetchNwslTeamAbbrs(seasonId: string): Promise<Map<string, string>> {
	const json = (await (await fetch(`${SDP}/seasons/${seasonId}/teams`)).json()) as {
		teams?: { teamId?: string; acronymName?: string }[];
	};
	const map = new Map<string, string>();
	for (const t of json.teams ?? []) {
		if (t.teamId && t.acronymName) map.set(t.teamId, t.acronymName.toUpperCase());
	}
	return map;
}

// All players for the season. The stats/players feed paginates at a fixed 30/page
// (pageSize is ignored), so loop until isLastPage. `displayName` is empty in this feed —
// the real name is mediaFirstName + mediaLastName.
async function fetchNwslPlayers(seasonId: string, teamAbbrs: Map<string, string>): Promise<NwslPlayer[]> {
	const out: NwslPlayer[] = [];
	let page = 1;
	let totalPages = 1;
	do {
		const json = (await (
			await fetch(`${SDP}/seasons/${seasonId}/stats/players?page=${page}`)
		).json()) as {
			players?: {
				playerId?: string;
				mediaFirstName?: string;
				mediaLastName?: string;
				shortName?: string;
				team?: { teamId?: string };
			}[] | null;
			pagination?: { totalPages?: number; isLastPage?: boolean };
		};
		totalPages = json.pagination?.totalPages ?? page;
		for (const p of json.players ?? []) {
			const guid = p.playerId ? guidOf(p.playerId) : "";
			const name = normalizeName(`${p.mediaFirstName ?? ""} ${p.mediaLastName ?? ""}`);
			if (!guid || !name) continue;
			out.push({
				guid,
				name,
				short: normalizeName(p.shortName ?? ""),
				teamAbbr: teamAbbrs.get(p.team?.teamId ?? "") ?? "",
			});
		}
		if (json.pagination?.isLastPage) break;
		page++;
	} while (page <= totalPages);
	return out;
}

// ── ESPN side (teams + rosters) ──────────────────────────────────────────────────

interface EspnPlayer {
	id: string; // ESPN athlete id (the app's player key)
	name: string; // normalized "first last"
	teamAbbr: string;
}

async function fetchEspnTeams(): Promise<{ id: string; abbr: string }[]> {
	const json = (await (await fetch(`${ESPN_SITE}/teams`)).json()) as {
		sports?: { leagues?: { teams?: { team?: { id?: string; abbreviation?: string } }[] }[] }[];
	};
	const teams = json.sports?.[0]?.leagues?.[0]?.teams ?? [];
	return teams
		.map((t) => ({ id: t.team?.id ?? "", abbr: (t.team?.abbreviation ?? "").toUpperCase() }))
		.filter((t) => t.id && t.abbr);
}

async function fetchEspnRoster(teamId: string, abbr: string): Promise<EspnPlayer[]> {
	const json = (await (await fetch(`${ESPN_SITE}/teams/${teamId}/roster`)).json()) as {
		athletes?: { id?: string; displayName?: string }[];
	};
	return (json.athletes ?? [])
		.filter((a) => a.id && a.displayName)
		.map((a) => ({ id: a.id!, name: normalizeName(a.displayName!), teamAbbr: abbr }));
}

// ── Build + match ────────────────────────────────────────────────────────────────

export interface HeadshotMeta {
	builtAt: string;
	nwslCount: number;
	espnCount: number;
	matched: number; // fresh matches resolved THIS run
	unmatched: number; // ESPN athletes this run with no NWSL match (audited in headshots:unmatched)
	overrides: number;
	mapSize: number; // total entries in the written (union-merged) map
}

/** Rebuild the ESPN→NWSL headshot map and write it (plus an audit + meta) to KV. Idempotent;
 *  called by the weekly cron and the admin POST /headshots/run. Returns the meta so the admin
 *  route can show match health at a glance. */
export async function buildHeadshotMap(env: Env): Promise<HeadshotMeta> {
	// NWSL + ESPN, in parallel where the season id allows.
	const seasonId = await currentNwslSeasonId();
	const nwslTeams = await fetchNwslTeamAbbrs(seasonId);
	const [nwslPlayers, espnTeams] = await Promise.all([
		fetchNwslPlayers(seasonId, nwslTeams),
		fetchEspnTeams(),
	]);
	const espnPlayers = (await Promise.all(espnTeams.map((t) => fetchEspnRoster(t.id, t.abbr)))).flat();

	// Index NWSL players by normalized full name (primary, mostly unique across ~435) and by
	// normalized shortName (secondary). The shortName key recovers mononym/nickname players
	// where ESPN uses just "Marta"/"Debinha" but NWSL's full name is the legal name — it lifts
	// the match rate ~94%→~98% with no false positives (abbreviated shortNames like
	// "L. LaBonta" never match an ESPN full display name, so they're harmless). Team
	// disambiguates a collision in either index, so ESPN/NWSL abbreviation drift can't break
	// the common case.
	const nwslByName = new Map<string, NwslPlayer[]>();
	const nwslByShort = new Map<string, NwslPlayer[]>();
	const index = (map: Map<string, NwslPlayer[]>, key: string, p: NwslPlayer) => {
		const list = map.get(key);
		if (list) list.push(p);
		else map.set(key, [p]);
	};
	for (const p of nwslPlayers) {
		index(nwslByName, p.name, p);
		if (p.short && p.short !== p.name) index(nwslByShort, p.short, p);
	}

	// Owner overrides win outright (the irreducible tail — players absent from the NWSL stats
	// feed, or any mismatch automated matching can't resolve).
	const overrides = ((await env.FEED_TAGS.get(OVERRIDES_KEY, "json")) as Record<string, string> | null) ?? {};

	const fresh: Record<string, string> = {};
	const unmatched: { espnId: string; name: string; team: string }[] = [];

	for (const e of espnPlayers) {
		if (overrides[e.id]) continue; // pinned by an override; don't auto-match
		// Primary by full name, then fall back to the nickname (shortName) index.
		const candidates = nwslByName.get(e.name) ?? nwslByShort.get(e.name);
		if (!candidates || candidates.length === 0) {
			unmatched.push({ espnId: e.id, name: e.name, team: e.teamAbbr });
			continue;
		}
		// 1 candidate → take it. >1 (duplicate name) → disambiguate by team abbr.
		const pick = candidates.length === 1 ? candidates[0] : candidates.find((c) => c.teamAbbr === e.teamAbbr);
		if (pick) fresh[e.id] = pick.guid;
		else unmatched.push({ espnId: e.id, name: e.name, team: e.teamAbbr });
	}

	// UNION-MERGE with the prior map (mirrors the app's "follows union, never delete"). An
	// espnId→guid mapping is stable, so a transient ESPN roster short-read on any single run
	// can only fail to ADD entries, never REMOVE good ones. Fresh matches + overrides win for
	// a key; everything previously known is preserved. A stale entry for a departed player is
	// harmless — the app only ever looks up athletes currently on the rosters it shows.
	const prior = ((await env.FEED_TAGS.get(MAP_KEY, "json")) as Record<string, string> | null) ?? {};
	const map: Record<string, string> = { ...prior, ...fresh, ...overrides };

	const meta: HeadshotMeta = {
		builtAt: new Date().toISOString(),
		nwslCount: nwslPlayers.length,
		espnCount: espnPlayers.length,
		matched: Object.keys(fresh).length,
		unmatched: unmatched.length,
		overrides: Object.keys(overrides).length,
		mapSize: Object.keys(map).length,
	};

	// Persist the map + the audit trail. The map has no TTL (it's the source of truth until
	// the next rebuild); the audit/meta keys likewise persist for inspection.
	await Promise.all([
		env.FEED_TAGS.put(MAP_KEY, JSON.stringify(map)),
		env.FEED_TAGS.put(UNMATCHED_KEY, JSON.stringify(unmatched)),
		env.FEED_TAGS.put(META_KEY, JSON.stringify(meta)),
	]);
	return meta;
}

// ── GET /headshots ────────────────────────────────────────────────────────────────

function withCacheStatus(response: Response, status: "HIT" | "MISS"): Response {
	const out = new Response(response.body, response);
	out.headers.set("X-Proxy-Cache", status);
	return out;
}

/** Serve the `{ espnAthleteId: nwslGuid }` map straight from KV. League-wide and read-only,
 *  so every request maps to one normalized, versioned edge-cache entry. Returns `{}` until the
 *  first build (the app then shows all monograms), and never caches an empty map at the edge. */
export async function handleHeadshots(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const cache = caches.default;
	const cacheUrl = new URL(url);
	cacheUrl.search = "";
	cacheUrl.searchParams.set("cv", "1"); // manual cache-version lever (bump to drop a stale entry)
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return withCacheStatus(hit, "HIT");

	let map: Record<string, string> = {};
	try {
		map = ((await env.FEED_TAGS.get(MAP_KEY, "json")) as Record<string, string> | null) ?? {};
	} catch {
		// A KV read failure → 502; the app falls back to monograms on any non-2xx.
		return new Response("headshot map unavailable", { status: 502 });
	}

	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", `public, max-age=${HEADSHOTS_TTL}`);
	const body = new Response(JSON.stringify(map), { status: 200, headers });
	// Don't pin an empty map at the edge for 6h before the first build lands.
	if (Object.keys(map).length > 0) ctx.waitUntil(cache.put(cacheKey, body.clone()));
	return withCacheStatus(body, "MISS");
}
