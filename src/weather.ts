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
export const VENUE_COORDS: Record<string, { lat: number; lon: number; name: string }> = {
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

export function venueCoords(venueId: string | undefined | null): { lat: number; lon: number; name: string } | null {
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
type Envelope =
	| { v: 1; mode: "historical"; tempF: number; weatherCode: number; isDay: number; condition: string; asOf: string }
	| { v: 1; mode: "unavailable"; reason: "not-finished" | "unknown-venue" | "upstream-error" };

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
	if (state !== "post") {
		// Future/live — forecast mode isn't built yet. Not an error; expected-silent for the app.
		return json({ v: 1, mode: "unavailable", reason: "not-finished" }, CC_NOT_FINISHED);
	}

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

	// 4. Write-once: a finished match's weather is final, so no TTL. Don't block the response.
	ctx.waitUntil(env.FEED_TAGS.put(kvKey, JSON.stringify(record)));
	return json(record, CC_IMMUTABLE);
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
