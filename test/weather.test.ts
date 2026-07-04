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
