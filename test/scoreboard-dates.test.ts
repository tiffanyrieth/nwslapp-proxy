// ESPN scoreboard date-shape classification (2026-09-16 incident). Pure. Run:
//   node --test test/scoreboard-dates.test.ts
// ESPN broke hyphenated `dates=A-B` ranges (400); classifyScoreboardDates decides how to rewrite the
// shapes the app + watcher send into forms ESPN still accepts (year-only / single-day).

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyScoreboardDates, utcYmd, ymdToUTC } from "../src/scoreboard-dates.ts";

test("full-season range (the blank-schedule bug) → year-only", () => {
	assert.deepEqual(classifyScoreboardDates("20260101-20261231"), { mode: "year", year: "2026" });
});

test("live window <yesterday>-<tomorrow> → the UTC days it spans (per-day merge)", () => {
	assert.deepEqual(classifyScoreboardDates("20260915-20260917"), {
		mode: "window",
		days: ["20260915", "20260916", "20260917"],
	});
});

test("a single-day window range stays a one-day merge", () => {
	assert.deepEqual(classifyScoreboardDates("20260920-20260920"), { mode: "window", days: ["20260920"] });
});

test("the window merge crosses a UTC month boundary correctly", () => {
	assert.deepEqual(classifyScoreboardDates("20260930-20261002"), {
		mode: "window",
		days: ["20260930", "20261001", "20261002"],
	});
});

test("non-range shapes pass through untouched (ESPN accepts them)", () => {
	assert.deepEqual(classifyScoreboardDates("2026"), { mode: "passthrough" }); // already year-only
	assert.deepEqual(classifyScoreboardDates("20260920"), { mode: "passthrough" }); // single day
	assert.deepEqual(classifyScoreboardDates(null), { mode: "passthrough" }); // no dates → default window
	assert.deepEqual(classifyScoreboardDates(undefined), { mode: "passthrough" });
	assert.deepEqual(classifyScoreboardDates(""), { mode: "passthrough" });
});

test("malformed / inverted ranges pass through (never crash the route)", () => {
	assert.deepEqual(classifyScoreboardDates("2026-2027"), { mode: "passthrough" }); // not 8-8
	assert.deepEqual(classifyScoreboardDates("20261231-20260101"), { mode: "passthrough" }); // end < start
	assert.deepEqual(classifyScoreboardDates("garbage"), { mode: "passthrough" });
});

test("the 8-day threshold splits window vs season with margin (9 days → year)", () => {
	// 8 days stays a window; 9 days classifies as a season pull (year-only). Neither is a real app
	// shape, but the boundary must be unambiguous.
	assert.equal(classifyScoreboardDates("20260101-20260108").mode, "window"); // 8 days
	assert.equal(classifyScoreboardDates("20260101-20260109").mode, "year"); // 9 days
});

test("utcYmd / ymdToUTC round-trip in UTC", () => {
	assert.equal(utcYmd(ymdToUTC("20260916")), "20260916");
	// A West-Coast Saturday-night kickoff (7:30pm PT Sat = 02:30 UTC Sun) is dated the NEXT UTC day —
	// the reason the live window must fetch multiple UTC days.
	assert.equal(utcYmd(new Date("2026-09-20T02:30:00Z")), "20260920");
});
