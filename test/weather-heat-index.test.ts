// The computed NWS heat index for the game-time weather card (#4 — Open-Meteo's apparent_temperature
// isn't the heat index; it nets humidity against wind and lands back near air temp on a hot windy day).
// Values checked against the NWS heat-index chart (Rothfusz regression, accurate to ~±1.3°F). Run:
//   node --test test/weather-heat-index.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { heatIndexF } from "../src/weather.ts";

const near = (got: number, want: number, tol = 2) =>
	assert.ok(Math.abs(got - want) <= tol, `expected ~${want}°F, got ${got.toFixed(1)}°F`);

test("heat index matches the NWS chart in the hot-humid regime", () => {
	near(heatIndexF(90, 70), 106); // classic muggy 90°
	near(heatIndexF(96, 45), 104); // the Houston-ish case that read "feels 96°" from Open-Meteo
	near(heatIndexF(100, 50), 118); // dangerous
	near(heatIndexF(93, 55), 104); // owner's Wunderground Houston line (~101–103 at that hour)
});

test("below ~80°F there is no meaningful heat index — returns ≈ the air temp", () => {
	assert.equal(heatIndexF(70, 50), 70); // well below the threshold
	near(heatIndexF(80, 40), 80, 1); // low-end Steadman check → ≈ temp
	near(heatIndexF(78, 90), 78, 2); // warm + very humid but under 80 → still ≈ temp
});

test("the dry + very-humid NWS adjustments apply", () => {
	// Very dry at high heat → the NWS dry adjustment pulls "feels like" BELOW the air temp (dry air feels
	// cooler). The card only shows the heat index when it's a BOOST (extractWindow: hi > temp), so this case
	// correctly falls back to Open-Meteo's apparent temp instead of surfacing a below-air "heat index".
	assert.ok(heatIndexF(100, 10) < 100, "very dry 100° feels cooler than the air temp");
	assert.ok(heatIndexF(100, 10) < heatIndexF(100, 50), "dry high heat feels cooler than humid high heat");
	// Very humid in the low-80s → adjustment nudges it above the air temp.
	assert.ok(heatIndexF(84, 90) > 84, "humid low-80s reads hotter than the air temp");
});

test("humidity is clamped to 0–100 (a bad upstream value never NaNs the card)", () => {
	assert.ok(Number.isFinite(heatIndexF(95, 140)));
	assert.ok(Number.isFinite(heatIndexF(95, -5)));
});
