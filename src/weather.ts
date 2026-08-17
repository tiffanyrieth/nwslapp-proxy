// Kickoff weather — the historical temperature + sky condition a past NWSL match was
// played in, surfaced as a small stamp in the app's Match Detail header
// ("Prime Video | BMO Stadium • ☁️ 70° • Attendance: 13,900").
//
// ESPN carries NO weather for NWSL (its /summary gameInfo is venue/attendance/officials
// only), so we source it from Open-Meteo (free, no key, ~1–2 km grid model — no physical
// weather-station guessing). The kickoff temperature, not the daily high: an 8pm match is a
// very different number from a 3pm one, so we index Open-Meteo's HOURLY array at the exact
// kickoff hour. Night-awareness rides Open-Meteo's `is_day` flag at that hour, so a 7:30pm
// March kickoff after a 6pm sunset renders a moon icon, not a sun.
//
// Self-contained on purpose (like headshots.ts / bracket-engine.ts): index.ts imports only
// `handleWeather`. The event → (venue, kickoff, finished-state) lookup is injected as
// `getSummary` so the route can reuse the worker's OWN edge-cached /summary pass-through —
// the app fires /summary at screen-open moments before /weather, so it's almost always a warm
// HIT (zero extra ESPN calls; a finished match's summary is IMMUTABLE_TTL-cached ~forever).
//
// PAST MATCHES ONLY for now. The response envelope is versioned (`v`/`mode`) so a later
// `mode:"forecast"` for upcoming games (the "Matchday Weather" card concept) can be added
// without an app-side decode change. Finished-match weather never changes, so a successful
// lookup is written ONCE to KV (`weather:{eventId}`, no TTL) and served forever after — the
// same write-once/last-known-good economics as /roster, but simpler (the value is immutable).

// ── Venue → coordinates ─────────────────────────────────────────────────────────
// Keyed by ESPN VENUE ID (stable across sponsorship renames — a stadium renamed mid-season
// keeps its id, so the lookup never silently breaks the way a name key would). Enumerated
// live from the full 2026 season scoreboard (every venue that appears, incl. alternate/neutral
// sites). An unknown id → honest `unknown-venue` + diag (no geocoding guess in v1; Open-Meteo's
// free geocoding API is the documented v2 fallback). Open-Meteo's grid is ~1–2 km, so
// coordinates only need to be within a few hundred meters of the pitch.
// `indoor: true` suppresses the game-time forecast card (a domed/roofed venue's outdoor forecast
// is meaningless). ZERO venues are flagged today — every 2026 NWSL site is outdoor (PayPal Park has
// no roof) — but the flag future-proofs a one-off/preseason indoor site per the design handoff.
export const VENUE_COORDS: Record<string, { lat: number; lon: number; name: string; indoor?: boolean }> = {
	"7604": { lat: 38.8687, lon: -77.0126, name: "Audi Field" },                                  // WAS
	"9895": { lat: 39.1097, lon: -94.5735, name: "CPKC Stadium" },                                // KC
	"6072": { lat: 37.3513, lon: -121.9250, name: "PayPal Park" },                                // BAY
	"6541": { lat: 35.7841, lon: -78.7820, name: "WakeMed Soccer Park" },                         // NC
	"9195": { lat: 32.7831, lon: -117.1196, name: "Snapdragon Stadium" },                         // SD
	"6971": { lat: 28.5410, lon: -81.3890, name: "Inter&Co Stadium" },                            // ORL
	"8390": { lat: 38.2589, lon: -85.7364, name: "Lynn Family Stadium" },                         // LOU
	"4383": { lat: 45.5215, lon: -122.6919, name: "Providence Park" },                            // POR
	"4791": { lat: 29.7522, lon: -95.3524, name: "Shell Energy Stadium" },                        // HOU
	"10469": { lat: 42.0587, lon: -87.6712, name: "Northwestern Medicine Field at Martin Stadium" }, // CHI
	"3714": { lat: 40.5830, lon: -111.8930, name: "America First Field" },                        // UTA
	"7605": { lat: 34.0126, lon: -118.2843, name: "BMO Stadium" },                                // LA
	"9606": { lat: 40.7368, lon: -74.1503, name: "Red Bull Arena" },                              // GFC (Sports Illustrated Stadium)
	"4485": { lat: 47.5952, lon: -122.3316, name: "Lumen Field" },                                // SEA
	"11017": { lat: 39.7392, lon: -105.0000, name: "Centennial Stadium" },                        // DEN (interim 2026 site — verify)
	"10660": { lat: 42.0909, lon: -71.2643, name: "Gillette Stadium" },                           // BOS (alt)
	"10224": { lat: 41.8746, lon: -71.3825, name: "Centreville Bank Stadium" },                   // BOS
	"2731": { lat: 39.8058, lon: -104.8919, name: "Dick's Sporting Goods Park" },                 // DEN (alt)
	"9837": { lat: 47.6608, lon: -117.4156, name: "ONE Spokane Stadium" },                        // SEA (alt)
	"1419": { lat: 39.7439, lon: -105.0201, name: "Empower Field at Mile High" },                 // DEN (1-off)
	"5146": { lat: 40.7571, lon: -73.8458, name: "Citi Field" },                                  // GFC (1-off)
	"10442": { lat: 40.7930, lon: -73.9215, name: "Icahn Stadium" },                              // 1-off
};

export function venueCoords(venueId: string | undefined | null): { lat: number; lon: number; name: string; indoor?: boolean } | null {
	if (!venueId) return null;
	return VENUE_COORDS[venueId] ?? null;
}

// ── WMO weather_code → time-neutral condition label ─────────────────────────────
// Labels stay time-neutral ("Clear", not "Sunny") — the day/night distinction is carried by
// the icon (app-side, driven by is_day), not the word. Groups per Open-Meteo's WMO table.
export function conditionLabel(code: number | null | undefined): string {
	if (code == null) return "";
	if (code === 0) return "Clear";
	if (code === 1 || code === 2) return "Partly cloudy";
	if (code === 3) return "Cloudy";
	if (code === 45 || code === 48) return "Fog";
	if (code >= 51 && code <= 57) return "Drizzle";
	if (code >= 61 && code <= 67) return "Rain";
	if (code >= 71 && code <= 77) return "Snow";
	if (code >= 80 && code <= 82) return "Showers";
	if (code === 85 || code === 86) return "Snow showers";
	if (code >= 95 && code <= 99) return "Thunderstorm";
	return ""; // unmapped → app falls back to a neutral cloud icon + no label
}

// ── Kickoff hour ────────────────────────────────────────────────────────────────
// Round the kickoff instant to the nearest whole UTC hour and format it as the "YYYY-MM-DDTHH:00"
// key Open-Meteo emits in its hourly `time` array (we request timezone=UTC so no per-venue
// timezone table is needed — a UTC instant indexes a UTC-labelled array directly). Nearest, not
// floor: a 7:40pm kickoff belongs to the 8pm reading, and the rounding correctly rolls the date
// (and month/year) at 23:40 → next day 00:00. Returns null for an unparseable date.
export function kickoffHourUtc(dateStr: string | undefined | null): string | null {
	if (!dateStr) return null;
	const ms = Date.parse(dateStr);
	if (Number.isNaN(ms)) return null;
	const rounded = new Date(Math.round(ms / 3_600_000) * 3_600_000);
	const y = rounded.getUTCFullYear();
	const mo = String(rounded.getUTCMonth() + 1).padStart(2, "0");
	const d = String(rounded.getUTCDate()).padStart(2, "0");
	const h = String(rounded.getUTCHours()).padStart(2, "0");
	return `${y}-${mo}-${d}T${h}:00`;
}

// ── Open-Meteo source selection + URL ───────────────────────────────────────────
// The archive API (ERA5 reanalysis) lags ~2–5 days for very recent dates, so for a match that
// finished within the last week we use the forecast API's `past_days` (covers the last 92 days
// with the same hourly fields). Older than that → the archive API. `pickApi` returns which to
// hit; a caller may retry the other once if the chosen source has no reading at the kickoff hour.
const RECENT_DAYS = 7;
const FORECAST_PAST_MAX = 92;

// A LIVE match (`state === "in"`) can take the historical kickoff-temp path once its kickoff hour
// is settled in Open-Meteo — so the immutable reading is captured DURING the match and is already
// warm in KV when the card flips to full-time (kills the in→post fetch race). We wait this long
// past kickoff before locking it: Open-Meteo advises ~10 min after a model update, and this also
// dodges the parked "fabricated kickoff" edge (a match that shows `in` at 1' but never started).
export const WEATHER_LIVE_SETTLE_MS = 30 * 60_000; // 30 min — a 7pm kickoff locks at ~7:30pm.

// True when a LIVE match's kickoff hour is settled enough to capture the immutable kickoff temp.
// A finished match (`post`) always takes the historical path; this only decides the live case.
export function liveWeatherSettled(state: string | undefined, kickoffMs: number, nowMs: number): boolean {
	return state === "in" && Number.isFinite(kickoffMs) && kickoffMs <= nowMs - WEATHER_LIVE_SETTLE_MS;
}

export function pickApi(kickoffMs: number, nowMs: number): "forecast" | "archive" {
	const daysAgo = (nowMs - kickoffMs) / 86_400_000;
	return daysAgo <= RECENT_DAYS ? "forecast" : "archive";
}

const HOURLY = "temperature_2m,weather_code,is_day";

export function buildOpenMeteoUrl(
	api: "forecast" | "archive",
	coords: { lat: number; lon: number },
	kickoffMs: number,
	nowMs: number,
): string {
	const common =
		`latitude=${coords.lat}&longitude=${coords.lon}` +
		`&hourly=${HOURLY}&temperature_unit=fahrenheit&timezone=UTC`;
	if (api === "forecast") {
		// past_days must span from today back to the kickoff date (ceil + 1 day of headroom),
		// clamped to the API's 92-day maximum.
		const daysAgo = Math.ceil((nowMs - kickoffMs) / 86_400_000) + 1;
		const pastDays = Math.min(Math.max(daysAgo, 1), FORECAST_PAST_MAX);
		return `https://api.open-meteo.com/v1/forecast?${common}&past_days=${pastDays}&forecast_days=1`;
	}
	const date = new Date(kickoffMs).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
	return `https://archive-api.open-meteo.com/v1/archive?${common}&start_date=${date}&end_date=${date}`;
}

// ── FORECAST mode (upcoming matches) ─────────────────────────────────────────────
// The game-time weather strip on a FUTURE match: the hourly forecast for the 4-hour game window
// (kickoff −1h … kickoff +2h). Distinct from the historical stamp above in three ways: it fetches
// the forward-looking forecast (more hourly fields: feels-like, wind, precip; plus daily sunset),
// it is NOT immutable (a forecast changes run-to-run) so it is EDGE-cached with an 8h TTL rather
// than written to KV, and it is bounded to a 10-day horizon.
//
// ⚠️ 10-DAY HORIZON, not Open-Meteo's 16-day max: model skill falls to ~65-80% by day 10 and the
// 11-16 window (GFS territory for US venues) flip-flops between runs. A confident 4-hour strip that
// far out would assert precision the forecast doesn't have — against the data-only design stance.
export const FORECAST_MAX_DAYS = 10;
export const FORECAST_HOURLY =
	"temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,precipitation_probability";

/** NWS heat index (°F) from air temp (°F) + relative humidity (%) — the Rothfusz regression with the two
 *  NWS adjustments and the Steadman low-end check. This is the "feels like 105°" number fans + stadiums use
 *  for heat protocols; below ~80°F it isn't meaningful and returns ≈ the air temp. We COMPUTE it rather than
 *  use Open-Meteo's `apparent_temperature`, which is a different metric — it nets humidity against wind and
 *  lands back near the air temp on a hot windy day (live-verified: a 96°F Houston game came back "feels 96°").
 *  Pure + unit-tested (test/weather-heat-index.test.ts). */
export function heatIndexF(tempF: number, rh: number): number {
	const T = tempF;
	const R = Math.max(0, Math.min(100, rh));
	// Steadman low-end: if the simple average stays under 80°F, there's no meaningful heat index.
	const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + R * 0.094);
	if ((simple + T) / 2 < 80) return T;
	let hi =
		-42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R -
		6.83783e-3 * T * T - 5.481717e-2 * R * R + 1.22874e-3 * T * T * R +
		8.5282e-4 * T * R * R - 1.99e-6 * T * T * R * R;
	if (R < 13 && T >= 80 && T <= 112) {
		hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
	} else if (R > 85 && T >= 80 && T <= 87) {
		hi += ((R - 85) / 10) * ((87 - T) / 5);
	}
	return hi;
}

/** The venue's UTC offset (seconds) from an Open-Meteo `timezone=auto` payload — 0 if absent. Lets the
 *  app render the weather card's hour labels + sunset in VENUE-LOCAL time (a sunset is a local event; the
 *  kickoff time in the match header stays the fan's own local time). */
export function utcOffsetSeconds(payload: unknown): number {
	const o = (payload as { utc_offset_seconds?: unknown })?.utc_offset_seconds;
	return typeof o === "number" && Number.isFinite(o) ? o : 0;
}

/** True when kickoff is in the future and inside the forecast horizon. */
export function withinForecastHorizon(kickoffMs: number, nowMs: number): boolean {
	const daysAhead = (kickoffMs - nowMs) / 86_400_000;
	return daysAhead > 0 && daysAhead <= FORECAST_MAX_DAYS;
}

/**
 * The Open-Meteo forecast URL for a match's game window. `start_date`/`end_date` span the UTC
 * calendar dates the window touches (kickoff −1h … kickoff +2h can straddle a UTC midnight), so the
 * hourly array is guaranteed to contain all four window hours plus the sunset for those dates.
 * `forecast_days` is NOT used — explicit dates keep the payload to the 1-2 relevant days (~2KB),
 * never the 10-day block.
 */
export function buildForecastUrl(coords: { lat: number; lon: number }, kickoffMs: number): string {
	const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	// ⚠️ `timezone=auto`, NOT UTC (changed 2026-08-12): the hourly + daily arrays come back in the venue's
	// LOCAL time, with a top-level `utc_offset_seconds`. This is what makes the daily `sunset` the venue's
	// LOCAL-day sunset — a UTC-day request returned the WRONG day for west-coast/late games (e.g. an SD game's
	// sunset came back +24h off, so the app hid it). We widen the date range to ±1 UTC day so the venue-local
	// match day + its sunset are always covered regardless of the offset (~3 local days, still tiny). The
	// window hours + sunset are matched by UTC INSTANT downstream (extractWindow/nearestSunset convert using
	// the offset), so the app's UTC-instant contract is unchanged.
	const start = dayOf(kickoffMs - 86_400_000);
	const end = dayOf(kickoffMs + 86_400_000);
	return (
		`https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
		`&hourly=${FORECAST_HOURLY}&daily=sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto` +
		`&start_date=${start}&end_date=${end}`
	);
}

/** One hour of the game-window forecast, as the app renders it. */
export interface ForecastHour {
	time: string; // "YYYY-MM-DDTHH:00Z"
	tempF: number;
	feelsLikeF: number;
	weatherCode: number;
	isDay: number;
	windMph: number;
	precipPct: number;
}

/** The four window hours (kickoff −1h, kickoff, +1h, +2h) pulled from a forecast payload, kickoff
 *  at index 1. Returns null if any of the four hours is missing (a partial strip would be worse
 *  than none). `isoKickoffHour` is the nearest-hour key from `kickoffHourUtc`. */
export function extractWindow(payload: unknown, isoKickoffHour: string): ForecastHour[] | null {
	const hourly = (payload as { hourly?: Record<string, unknown[]> })?.hourly;
	if (!hourly || !Array.isArray(hourly.time)) return null;
	const kickoffMs = Date.parse(`${isoKickoffHour}:00Z`);
	if (Number.isNaN(kickoffMs)) return null;
	const offsetMs = utcOffsetSeconds(payload) * 1000;
	// hourly.time is VENUE-LOCAL now (timezone=auto). Index each entry by its true UTC instant so the
	// window is matched by instant, not by a UTC-labelled string (keeps the app's UTC-instant contract).
	const idxByUtc = new Map<number, number>();
	for (let i = 0; i < hourly.time.length; i++) {
		const t = hourly.time[i];
		if (typeof t !== "string") continue;
		const localAsUtc = Date.parse(t.endsWith("Z") ? t : `${t}Z`);
		if (!Number.isNaN(localAsUtc)) idxByUtc.set(localAsUtc - offsetMs, i);
	}
	const out: ForecastHour[] = [];
	for (let offset = -1; offset <= 2; offset++) {
		const i = idxByUtc.get(kickoffMs + offset * 3_600_000);
		if (i === undefined) return null;
		const temp = hourly.temperature_2m?.[i];
		const rh = hourly.relative_humidity_2m?.[i];
		const apparent = hourly.apparent_temperature?.[i];
		const code = hourly.weather_code?.[i];
		const day = hourly.is_day?.[i];
		const wind = hourly.wind_speed_10m?.[i];
		const precip = hourly.precipitation_probability?.[i];
		if (typeof temp !== "number" || Number.isNaN(temp)) return null;
		// feels-like: the COMPUTED NWS heat index when it's a real boost (hot + humid); otherwise Open-Meteo's
		// apparent_temperature (which carries the wind chill in the cold); otherwise the air temp.
		const hi = typeof rh === "number" ? heatIndexF(temp, rh) : temp;
		const feelsRaw = hi > temp + 0.5 ? hi : typeof apparent === "number" ? apparent : temp;
		out.push({
			time: new Date(kickoffMs + offset * 3_600_000).toISOString(), // UTC instant, WITH seconds
			tempF: Math.round(temp),
			feelsLikeF: Math.round(feelsRaw),
			weatherCode: typeof code === "number" ? code : -1,
			isDay: typeof day === "number" ? day : 1,
			windMph: typeof wind === "number" ? Math.round(wind) : 0,
			precipPct: typeof precip === "number" ? precip : 0,
		});
	}
	return out;
}

/** The sunset instant (UTC) nearest the kickoff. Open-Meteo `daily.sunset` is now a per-date array of
 *  VENUE-LOCAL ISO strings (timezone=auto), so each is converted to a true UTC instant using the venue
 *  offset before picking the closest to kickoff — the one that falls in/near the game window. Because the
 *  array is keyed on the venue's LOCAL days, the match-evening sunset is present + wins (the old UTC-day
 *  request returned a neighbouring day's sunset for west-coast/late games). null when absent/malformed. */
export function nearestSunset(payload: unknown, kickoffMs: number): string | null {
	const sunsets = (payload as { daily?: { sunset?: unknown[] } })?.daily?.sunset;
	if (!Array.isArray(sunsets)) return null;
	const offsetMs = utcOffsetSeconds(payload) * 1000;
	let best: string | null = null;
	let bestDelta = Infinity;
	for (const s of sunsets) {
		if (typeof s !== "string") continue;
		const localAsUtc = Date.parse(s.endsWith("Z") ? s : `${s}Z`);
		if (Number.isNaN(localAsUtc)) continue;
		const ms = localAsUtc - offsetMs; // true UTC instant of the local sunset
		const delta = Math.abs(ms - kickoffMs);
		if (delta < bestDelta) {
			bestDelta = delta;
			best = new Date(ms).toISOString();
		}
	}
	return best;
}

/** 8h — the forecast's edge-cache + client TTL. The underlying models refresh only a few times/day
 *  (GFS 4×, ECMWF 2×), so a shorter TTL just re-downloads the same run. Open-Meteo already stitches
 *  to the latest available run on every fetch, so 8h keeps the strip current without waste. */
export const FORECAST_TTL_SECONDS = 8 * 3600;

// ── Extract the kickoff-hour reading from an Open-Meteo payload ──────────────────
export interface HourReading {
	tempF: number;
	weatherCode: number;
	isDay: number; // 1 = day, 0 = night, at the kickoff hour
}

export function extractHour(payload: unknown, isoHour: string): HourReading | null {
	const hourly = (payload as { hourly?: Record<string, unknown[]> })?.hourly;
	if (!hourly || !Array.isArray(hourly.time)) return null;
	const i = hourly.time.indexOf(isoHour);
	if (i < 0) return null;
	const temp = hourly.temperature_2m?.[i];
	const code = hourly.weather_code?.[i];
	const day = hourly.is_day?.[i];
	if (typeof temp !== "number" || Number.isNaN(temp)) return null;
	return {
		tempF: Math.round(temp),
		weatherCode: typeof code === "number" ? code : -1,
		isDay: typeof day === "number" ? day : 1,
	};
}

// ── Response envelopes ──────────────────────────────────────────────────────────
// The app's `MatchWeather` decoder is versioned by `mode` and reads every field optionally, so a
// new mode is additive — no app-side decode change to ship the forecast (the app just starts
// rendering it once its build handles `isForecast`). Top-level `tempF` stays ABSENT in forecast
// mode: the app's `roundedTemp` feeds the Match Detail header-rail gate, and a value there would
// surface the rail on a future match.
type Envelope =
	| { v: 1; mode: "historical"; tempF: number; weatherCode: number; isDay: number; condition: string; asOf: string }
	| { v: 1; mode: "forecast"; venueName: string; hours: ForecastHour[]; sunset: string | null; utcOffsetSeconds: number; asOf: string }
	| { v: 1; mode: "unavailable"; reason: "not-finished" | "unknown-venue" | "upstream-error" | "too-far-out" | "indoor-venue" };

function json(body: Envelope, cacheControl: string): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json", "Cache-Control": cacheControl },
	});
}

const CC_IMMUTABLE = "public, max-age=31536000, immutable";
const CC_NOT_FINISHED = "public, max-age=60";     // flips fast once the match hits full-time
const CC_UNKNOWN_VENUE = "public, max-age=3600";  // a table fix serves within the hour
const CC_ERROR = "no-store";
const CC_FORECAST = `public, max-age=${FORECAST_TTL_SECONDS}`;  // 8h — see FORECAST_TTL_SECONDS
const CC_TOO_FAR = "public, max-age=3600";        // re-check hourly as the match enters the horizon

// A minimal shape of the fields we read out of ESPN's /summary payload.
interface SummaryLite {
	header?: {
		competitions?: Array<{
			date?: string;
			status?: { type?: { state?: string } };
		}>;
	};
	gameInfo?: { venue?: { id?: string; fullName?: string } };
}

type EmitDiag = (env: Env, ctx: ExecutionContext, kind: string, detail: string) => void;

/**
 * GET /weather?event={espnEventId}
 *
 * `getSummary(eventId)` resolves the event's venue + kickoff + state via the worker's own
 * edge-cached /summary; `emit` is index.ts's emitDiag (injected to keep this module self-contained).
 */
export async function handleWeather(
	url: URL,
	env: Env,
	ctx: ExecutionContext,
	getSummary: (eventId: string) => Promise<SummaryLite | null>,
	emit: EmitDiag,
	nowMs: number = Date.now(),
): Promise<Response> {
	const eventId = url.searchParams.get("event") ?? "";
	// Validate strictly (unlike /summary's pass-through): this route WRITES KV, so a junk id
	// must never mint a `weather:*` key.
	if (!/^\d+$/.test(eventId)) {
		return new Response("missing or invalid ?event", { status: 400 });
	}

	const kvKey = `weather:${eventId}`;

	// 1. KV hit → serve the immutable record.
	try {
		const cached = await env.FEED_TAGS.get(kvKey, "json");
		if (cached) return json(cached as Envelope, CC_IMMUTABLE);
	} catch {
		/* KV read failure → fall through and recompute */
	}

	// 2. Resolve the event (venue / kickoff / finished-state) via the cached summary.
	let summary: SummaryLite | null = null;
	try {
		summary = await getSummary(eventId);
	} catch {
		summary = null;
	}
	if (!summary) {
		emit(env, ctx, "weatherSummaryUnavailable", eventId);
		return json({ v: 1, mode: "unavailable", reason: "upstream-error" }, CC_ERROR);
	}

	const competition = summary.header?.competitions?.[0];
	const state = competition?.status?.type?.state;

	const coords = venueCoords(summary.gameInfo?.venue?.id);
	if (!coords) {
		emit(env, ctx, "weatherVenueUnknown", `${eventId} venue=${summary.gameInfo?.venue?.id ?? "?"}:${summary.gameInfo?.venue?.fullName ?? "?"}`);
		return json({ v: 1, mode: "unavailable", reason: "unknown-venue" }, CC_UNKNOWN_VENUE);
	}

	const isoHour = kickoffHourUtc(competition?.date);
	const kickoffMs = competition?.date ? Date.parse(competition.date) : NaN;
	if (!isoHour || Number.isNaN(kickoffMs)) {
		emit(env, ctx, "weatherUpstreamFail", `${eventId} bad-kickoff-date`);
		return json({ v: 1, mode: "unavailable", reason: "upstream-error" }, CC_ERROR);
	}

	// A LIVE game (`in`) whose kickoff hour has settled takes the SAME historical path as a finished
	// match, so the immutable kickoff temp is captured mid-match and is already in KV at the post flip.
	const liveSettled = liveWeatherSettled(state, kickoffMs, nowMs);

	// FORECAST path — a pre-match (not `post`, not settled-live) game. An early LIVE game (`in`,
	// <30 min in) gets no card yet (`not-finished`, retried); only a genuinely future kickoff inside
	// the 10-day horizon forecasts.
	if (state !== "post" && !liveSettled) {
		if (state === "in") {
			return json({ v: 1, mode: "unavailable", reason: "not-finished" }, CC_NOT_FINISHED);
		}
		if (!withinForecastHorizon(kickoffMs, nowMs)) {
			return json({ v: 1, mode: "unavailable", reason: "too-far-out" }, CC_TOO_FAR);
		}
		if (coords.indoor) {
			return json({ v: 1, mode: "unavailable", reason: "indoor-venue" }, CC_FORECAST);
		}
		return forecastResponse(env, ctx, eventId, url, coords, kickoffMs, isoHour, emit);
	}

	// 3. Fetch Open-Meteo (chosen source, one fallback to the other if the hour is missing).
	const reading = await fetchReading(coords, kickoffMs, nowMs, isoHour);
	if (!reading) {
		emit(env, ctx, "weatherNoHourData", `${eventId} ${isoHour}`);
		return json({ v: 1, mode: "unavailable", reason: "upstream-error" }, CC_ERROR);
	}

	const record: Envelope = {
		v: 1,
		mode: "historical",
		tempF: reading.tempF,
		weatherCode: reading.weatherCode,
		isDay: reading.isDay,
		condition: conditionLabel(reading.weatherCode),
		asOf: isoHour + ":00Z",
	};

	// 4. Write-once: the kickoff-hour reading is final (the match is finished, or live and ≥30 min
	// past kickoff so the hour has settled), so no TTL. Don't block the response.
	ctx.waitUntil(env.FEED_TAGS.put(kvKey, JSON.stringify(record)));
	return json(record, CC_IMMUTABLE);
}

/**
 * The forecast half — EDGE-cached (not KV), because a forecast changes run-to-run and KV's
 * 1k-writes/day free cap is a real scaling wall. The edge Cache API is unlimited + free + TTL-based,
 * so Open-Meteo is hit at most once per match per 8h per colo — INDEPENDENT of user count (the whole
 * feature never approaches the 10k/day free limit at any scale). A `Cache-Control` header alone would
 * only cache client-side; a Worker response must be explicitly `cache.put()`-ed to live at the edge
 * (the same reason /scoreboard and /summary do it in proxyAndCache).
 */
async function forecastResponse(
	env: Env,
	ctx: ExecutionContext,
	eventId: string,
	url: URL,
	coords: { lat: number; lon: number; name: string },
	kickoffMs: number,
	isoHour: string,
	emit: EmitDiag,
): Promise<Response> {
	const cache = caches.default;
	// Key on a normalized URL (own origin + eventId) — never the Open-Meteo URL. Independent of any
	// extra query params the caller might add.
	const keyURL = new URL(url.origin + url.pathname);
	keyURL.searchParams.set("event", eventId);
	keyURL.searchParams.set("mode", "forecast");
	// Cache-shape version — bump when the forecast RESPONSE shape changes so the 8h edge cache doesn't keep
	// serving stale-shaped payloads across a deploy. cv=2 (2026-08-12): venue-local sunset + utcOffsetSeconds
	// + computed heat index.
	keyURL.searchParams.set("cv", "2");
	const cacheKey = new Request(keyURL.toString(), { method: "GET" });

	const hit = await cache.match(cacheKey);
	if (hit) return hit;

	let payload: unknown;
	try {
		const r = await fetch(buildForecastUrl(coords, kickoffMs), { headers: { Accept: "application/json" } });
		if (!r.ok) throw new Error(`open-meteo ${r.status}`);
		payload = await r.json();
	} catch (e) {
		emit(env, ctx, "weatherForecastFail", `${eventId} ${(e as Error).message.slice(0, 50)}`);
		return json({ v: 1, mode: "unavailable", reason: "upstream-error" }, CC_ERROR);
	}

	const hours = extractWindow(payload, isoHour);
	if (!hours) {
		emit(env, ctx, "weatherForecastNoWindow", `${eventId} ${isoHour}`);
		return json({ v: 1, mode: "unavailable", reason: "upstream-error" }, CC_ERROR);
	}

	const record: Envelope = {
		v: 1,
		mode: "forecast",
		venueName: coords.name,
		hours,
		sunset: nearestSunset(payload, kickoffMs),
		utcOffsetSeconds: utcOffsetSeconds(payload), // venue offset → app renders card times venue-local
		asOf: new Date(kickoffMs).toISOString(),
	};
	const response = json(record, CC_FORECAST);
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

/** Hit the age-appropriate Open-Meteo API; if the chosen source lacks the kickoff hour and the
 *  match is recent enough for the other source to cover it, try the other once. */
async function fetchReading(
	coords: { lat: number; lon: number },
	kickoffMs: number,
	nowMs: number,
	isoHour: string,
): Promise<HourReading | null> {
	const primary = pickApi(kickoffMs, nowMs);
	const order: Array<"forecast" | "archive"> =
		primary === "forecast" ? ["forecast", "archive"] : ["archive", "forecast"];
	const daysAgo = (nowMs - kickoffMs) / 86_400_000;
	for (const api of order) {
		// Only try the forecast API when the match is within its 92-day past window.
		if (api === "forecast" && daysAgo > FORECAST_PAST_MAX) continue;
		try {
			const r = await fetch(buildOpenMeteoUrl(api, coords, kickoffMs, nowMs), {
				headers: { Accept: "application/json" },
			});
			if (!r.ok) continue;
			const reading = extractHour(await r.json(), isoHour);
			if (reading) return reading;
		} catch {
			/* try the next source */
		}
	}
	return null;
}
