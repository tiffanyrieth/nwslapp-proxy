// Pure-logic tests for the /weather helpers. Run with the Node test runner
// (vitest-pool-workers can't boot workerd on Node 26 — see CLAUDE.md):
//   node --test test/weather.test.ts
//
// No network: every helper here is pure (venue lookup, WMO label mapping, kickoff-hour
// rounding, Open-Meteo source selection + URL building, hourly extraction). The network
// path (fetchReading / handleWeather) is exercised live via wrangler dev + curl and the
// health check, not mocked here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	venueCoords,
	conditionLabel,
	kickoffHourUtc,
	pickApi,
	buildOpenMeteoUrl,
	extractHour,
	VENUE_COORDS,
	withinForecastHorizon,
	buildForecastUrl,
	extractWindow,
	nearestSunset,
	FORECAST_MAX_DAYS,
	liveWeatherSettled,
	WEATHER_LIVE_SETTLE_MS,
} from "../src/weather.ts";

test("venueCoords resolves a known ESPN venue id and rejects unknown/empty", () => {
	assert.equal(venueCoords("7605")?.name, "BMO Stadium");
	assert.ok(Math.abs(venueCoords("7605").lat - 34.0126) < 1e-6);
	assert.equal(venueCoords("999999"), null);
	assert.equal(venueCoords(null), null);
	assert.equal(venueCoords(undefined), null);
	assert.equal(venueCoords(""), null);
});

test("VENUE_COORDS has every 2026 season venue with plausible US coordinates", () => {
	// 22 venues enumerated from the live full-season scoreboard (clubs + alt/neutral sites).
	assert.equal(Object.keys(VENUE_COORDS).length, 22);
	for (const [id, v] of Object.entries(VENUE_COORDS)) {
		assert.ok(v.lat > 24 && v.lat < 49, `${id} lat in CONUS`);
		assert.ok(v.lon < -66 && v.lon > -125, `${id} lon in CONUS`);
		assert.ok(v.name.length > 0, `${id} has a name`);
	}
});

test("conditionLabel maps each WMO group time-neutrally", () => {
	assert.equal(conditionLabel(0), "Clear");        // never "Sunny" — night-neutral
	assert.equal(conditionLabel(1), "Partly cloudy");
	assert.equal(conditionLabel(2), "Partly cloudy");
	assert.equal(conditionLabel(3), "Cloudy");
	assert.equal(conditionLabel(45), "Fog");
	assert.equal(conditionLabel(48), "Fog");
	assert.equal(conditionLabel(53), "Drizzle");
	assert.equal(conditionLabel(63), "Rain");
	assert.equal(conditionLabel(75), "Snow");
	assert.equal(conditionLabel(81), "Showers");
	assert.equal(conditionLabel(86), "Snow showers");
	assert.equal(conditionLabel(95), "Thunderstorm");
	assert.equal(conditionLabel(99), "Thunderstorm");
	assert.equal(conditionLabel(123), ""); // unmapped → app falls back to a neutral icon
	assert.equal(conditionLabel(null), "");
	assert.equal(conditionLabel(undefined), "");
});

test("kickoffHourUtc rounds to the nearest UTC hour and rolls the date", () => {
	assert.equal(kickoffHourUtc("2026-07-04T02:10:00Z"), "2026-07-04T02:00"); // floor side
	assert.equal(kickoffHourUtc("2026-07-04T02:30:00Z"), "2026-07-04T03:00"); // ceil at :30
	assert.equal(kickoffHourUtc("2026-07-04T02:49:00Z"), "2026-07-04T03:00");
	assert.equal(kickoffHourUtc("2026-07-04T23:40:00Z"), "2026-07-05T00:00"); // date roll
	assert.equal(kickoffHourUtc("2026-12-31T23:40:00Z"), "2027-01-01T00:00"); // year roll
	assert.equal(kickoffHourUtc(undefined), null);
	assert.equal(kickoffHourUtc("not a date"), null);
});

test("liveWeatherSettled: a live match takes the historical path only ≥30 min past kickoff", () => {
	const now = Date.parse("2026-08-16T02:00:00Z"); // 10pm ET
	const minsAgo = (m) => now - m * 60_000;
	// Live and settled → historical kickoff temp is captured mid-match.
	assert.equal(liveWeatherSettled("in", minsAgo(30), now), true); // boundary inclusive
	assert.equal(liveWeatherSettled("in", minsAgo(75), now), true); // deep into the match
	// Live but too early → still `not-finished`, retried (don't lock an unsettled reading).
	assert.equal(liveWeatherSettled("in", minsAgo(29), now), false);
	assert.equal(liveWeatherSettled("in", minsAgo(1), now), false); // fabricated-kickoff edge
	// Only the live state uses this gate; post/pre are decided elsewhere.
	assert.equal(liveWeatherSettled("post", minsAgo(120), now), false);
	assert.equal(liveWeatherSettled("pre", minsAgo(-60), now), false);
	assert.equal(liveWeatherSettled(undefined, minsAgo(120), now), false);
	assert.equal(liveWeatherSettled("in", NaN, now), false); // bad kickoff date
	assert.equal(WEATHER_LIVE_SETTLE_MS, 30 * 60_000);
});

test("pickApi chooses forecast for recent matches, archive for older", () => {
	const now = Date.parse("2026-07-04T00:00:00Z");
	const daysAgo = (n) => now - n * 86_400_000;
	assert.equal(pickApi(daysAgo(1), now), "forecast");
	assert.equal(pickApi(daysAgo(3), now), "forecast");
	assert.equal(pickApi(daysAgo(7), now), "forecast");  // boundary inclusive
	assert.equal(pickApi(daysAgo(8), now), "archive");
	assert.equal(pickApi(daysAgo(30), now), "archive");
});

test("buildOpenMeteoUrl builds the right host + params per source", () => {
	const now = Date.parse("2026-07-04T00:00:00Z");
	const coords = { lat: 34.0126, lon: -118.2843 };
	const kickoff = Date.parse("2026-07-01T02:00:00Z"); // 3 days ago

	const fc = buildOpenMeteoUrl("forecast", coords, kickoff, now);
	assert.ok(fc.startsWith("https://api.open-meteo.com/v1/forecast?"));
	assert.ok(fc.includes("temperature_unit=fahrenheit"));
	assert.ok(fc.includes("timezone=UTC"));
	assert.ok(fc.includes("is_day"));
	assert.ok(/past_days=\d+/.test(fc));

	const ar = buildOpenMeteoUrl("archive", coords, kickoff, now);
	assert.ok(ar.startsWith("https://archive-api.open-meteo.com/v1/archive?"));
	assert.ok(ar.includes("start_date=2026-07-01"));
	assert.ok(ar.includes("end_date=2026-07-01"));
});

test("extractHour pulls the reading at the kickoff hour, null when missing", () => {
	const payload = {
		hourly: {
			time: ["2026-07-03T18:00", "2026-07-03T19:00", "2026-07-03T20:00"],
			temperature_2m: [72.4, 70.0, 66.7],
			weather_code: [0, 3, 3],
			is_day: [1, 1, 0],
		},
	};
	const r = extractHour(payload, "2026-07-03T19:00");
	assert.deepEqual(r, { tempF: 70, weatherCode: 3, isDay: 1 });

	const night = extractHour(payload, "2026-07-03T20:00");
	assert.equal(night.isDay, 0); // night kickoff → moon icon app-side

	assert.equal(extractHour(payload, "2026-07-03T21:00"), null); // hour not present
	assert.equal(extractHour({}, "2026-07-03T19:00"), null);      // no hourly
	assert.equal(extractHour(null, "2026-07-03T19:00"), null);
});

test("extractHour returns null when the temperature reading itself is null", () => {
	const payload = {
		hourly: { time: ["2026-07-03T19:00"], temperature_2m: [null], weather_code: [3], is_day: [1] },
	};
	assert.equal(extractHour(payload, "2026-07-03T19:00"), null);
});

// ── Forecast mode (game-time weather strip) ──────────────────────────────────────

test("withinForecastHorizon: future & inside 10 days only", () => {
	const now = Date.parse("2026-08-11T12:00:00Z");
	const inDays = (d) => now + d * 86_400_000;
	assert.equal(withinForecastHorizon(inDays(3), now), true);
	assert.equal(withinForecastHorizon(inDays(FORECAST_MAX_DAYS), now), true); // exactly 10d
	assert.equal(withinForecastHorizon(inDays(11), now), false); // past the horizon
	assert.equal(withinForecastHorizon(inDays(-1), now), false); // already in the past
	assert.equal(withinForecastHorizon(now, now), false);        // "now" is not future
});

test("buildForecastUrl spans the window's UTC dates and requests the full field set", () => {
	const coords = { lat: 38.8687, lon: -77.0126 };
	const kickoff = Date.parse("2026-08-14T23:00:00Z"); // window +2h crosses into the 15th UTC
	const url = buildForecastUrl(coords, kickoff);
	assert.ok(url.startsWith("https://api.open-meteo.com/v1/forecast?"));
	assert.match(url, /start_date=2026-08-14/);
	assert.match(url, /end_date=2026-08-15/); // kickoff+2h = 01:00Z next day
	for (const field of ["temperature_2m", "apparent_temperature", "weather_code", "is_day", "wind_speed_10m", "precipitation_probability"]) {
		assert.match(url, new RegExp(field), `hourly has ${field}`);
	}
	assert.match(url, /daily=sunset/);
	assert.match(url, /wind_speed_unit=mph/);
	assert.doesNotMatch(url, /forecast_days/); // explicit dates, not a day block
});

test("extractWindow pulls the 4 window hours with kickoff at index 1", () => {
	// Hours 6 PM..9 PM UTC on the match date; kickoff 7 PM.
	const t = (h) => `2026-08-14T${String(h).padStart(2, "0")}:00`;
	const payload = {
		hourly: {
			time: [t(17), t(18), t(19), t(20), t(21)],
			temperature_2m: [80, 82, 84, 83, 81],
			apparent_temperature: [85, 88, 90, 89, 86],
			weather_code: [1, 2, 3, 3, 61],
			is_day: [1, 1, 1, 0, 0],
			wind_speed_10m: [5, 6, 7, 8, 9],
			precipitation_probability: [0, 10, 20, 40, 60],
		},
	};
	const w = extractWindow(payload, "2026-08-14T19:00"); // kickoff 7 PM
	assert.equal(w.length, 4);
	assert.equal(w[1].time, "2026-08-14T19:00Z"); // kickoff at index 1
	assert.equal(w[0].tempF, 82); // kickoff −1h = 6 PM
	assert.equal(w[1].tempF, 84);
	assert.equal(w[1].feelsLikeF, 90);
	assert.equal(w[2].precipPct, 40);
	assert.equal(w[3].isDay, 0);
	assert.equal(w[1].windMph, 7);
});

test("extractWindow handles a window crossing UTC midnight", () => {
	const payload = {
		hourly: {
			time: ["2026-08-14T22:00", "2026-08-14T23:00", "2026-08-15T00:00", "2026-08-15T01:00"],
			temperature_2m: [78, 77, 76, 75],
			apparent_temperature: [78, 77, 76, 75],
			weather_code: [0, 0, 0, 0],
			is_day: [0, 0, 0, 0],
			wind_speed_10m: [3, 3, 3, 3],
			precipitation_probability: [0, 0, 0, 0],
		},
	};
	const w = extractWindow(payload, "2026-08-14T23:00"); // kickoff 11 PM UTC
	assert.equal(w.length, 4);
	assert.equal(w[1].time, "2026-08-14T23:00Z");
	assert.equal(w[3].time, "2026-08-15T01:00Z"); // +2h rolled the date
});

test("extractWindow returns null if any window hour is missing (no partial strip)", () => {
	const payload = {
		hourly: {
			time: ["2026-08-14T18:00", "2026-08-14T19:00", "2026-08-14T20:00"], // missing 21:00
			temperature_2m: [82, 84, 83],
			apparent_temperature: [85, 90, 89],
			weather_code: [2, 3, 3],
			is_day: [1, 1, 0],
			wind_speed_10m: [6, 7, 8],
			precipitation_probability: [10, 20, 40],
		},
	};
	assert.equal(extractWindow(payload, "2026-08-14T19:00"), null);
	assert.equal(extractWindow({}, "2026-08-14T19:00"), null);
	assert.equal(extractWindow(null, "2026-08-14T19:00"), null);
});

test("extractWindow tolerates missing optional fields (feels-like defaults to temp)", () => {
	const t = (h) => `2026-08-14T${String(h).padStart(2, "0")}:00`;
	const payload = {
		hourly: {
			time: [t(18), t(19), t(20), t(21)],
			temperature_2m: [82, 84, 83, 81],
			// no apparent_temperature / wind / precip arrays
			weather_code: [2, 3, 3, 1],
			is_day: [1, 1, 0, 0],
		},
	};
	const w = extractWindow(payload, "2026-08-14T19:00");
	assert.equal(w[1].feelsLikeF, 84); // falls back to actual temp
	assert.equal(w[1].windMph, 0);
	assert.equal(w[1].precipPct, 0);
});

test("nearestSunset picks the sunset closest to kickoff and returns a UTC instant", () => {
	const payload = { daily: { sunset: ["2026-08-14T00:12", "2026-08-15T00:10"] } };
	const kickoff = Date.parse("2026-08-14T23:00:00Z");
	const s = nearestSunset(payload, kickoff);
	assert.equal(s, "2026-08-15T00:10:00.000Z"); // the 15th's sunset is nearer to an 11 PM/14th kickoff
	assert.equal(nearestSunset({}, kickoff), null);
	assert.equal(nearestSunset({ daily: { sunset: [] } }, kickoff), null);
});
