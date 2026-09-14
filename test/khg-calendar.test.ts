// The schedule-derived Know Her Game calendar (2026-09-14). Pure. Run:
//   node --test test/khg-calendar.test.ts
// The 2026 fixture is the REAL ESPN season list (date + season slug only), captured 2026-09-14 — 240
// regular-season events, no playoffs loaded yet. Its 7 fixture-free weeks are the ones docs/fan-zone.md
// warns about (incl. the four-week June block).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeCalendar, deriveAnchor, isPausedMonday, mondayStart, fixtureKickoffs, ymd,
} from "../src/khg-calendar.ts";

const season2026 = JSON.parse(readFileSync(new URL("./fixtures/scoreboard-2026-compact.json", import.meta.url), "utf8")) as Array<{ date: string; seasonSlug: string }>;
const utc = (s: string) => new Date(`${s}T00:00:00Z`);

test("anchor derives from the first regular-season fixture (2026 → Mon 03-09, matching the compiled constant)", () => {
  assert.equal(deriveAnchor(season2026), "2026-03-09");
});

test("real 2026 schedule: the April window and the June block pause KHG drops; everything else is live", () => {
  const cal = computeCalendar(season2026, "2026-03-09", utc("2026-03-09"));
  // Fixture-free weeks: 04-06, 04-13, 06-01, 06-08, 06-15, 06-22, 10-05. KHG drops on even offsets from
  // 03-09; a drop is paused only when BOTH weeks of its window are empty → 04-06, 06-01, 06-15.
  // (10-05's round has games in the 10-12 week → live.)
  assert.deepEqual(cal.pausedMondays, ["2026-04-06", "2026-06-01", "2026-06-15"]);
  // No playoffs loaded yet: the last fixture is in the 10-26 week (a Trivia week) → the season "ends" at
  // the next KHG drop, 11-02.
  assert.equal(cal.seasonEnd, "2026-11-02");
  assert.equal(isPausedMonday(cal, "2026-03-23"), false);
  assert.equal(isPausedMonday(cal, "2026-06-01"), true);
  assert.equal(isPausedMonday(cal, "2026-11-23"), true);   // past the end
});

test("playoffs appearing later extend the season automatically", () => {
  const withPlayoffs = [
    ...season2026,
    { date: "2026-11-08T22:00Z", seasonSlug: "playoffs---quarterfinals" },
    { date: "2026-11-22T20:00Z", seasonSlug: "playoffs---championship" },
  ];
  const cal = computeCalendar(withPlayoffs, "2026-03-09", utc("2026-10-19"));
  assert.equal(isPausedMonday(cal, "2026-11-02"), false);   // 11-02 window holds the 11-08 quarterfinal
  assert.equal(isPausedMonday(cal, "2026-11-16"), false);   // 11-16 window holds the 11-22 final
  assert.equal(cal.seasonEnd, "2026-11-30");                 // first KHG drop after the final
});

test("no fixtures at all → nothing is live (offseason before ESPN loads the new schedule)", () => {
  const cal = computeCalendar([], "2026-03-09", utc("2026-12-14"));
  assert.equal(cal.seasonEnd, null);
  // Every drop in the horizon is paused because no window has a fixture.
  assert.ok(cal.pausedMondays.length > 20);
  assert.equal(isPausedMonday(cal, "2027-01-11"), true);
});

test("preseason fixtures never count; a fixture with no slug does (fail-open)", () => {
  const events = [
    { date: "2026-02-21T20:00Z", seasonSlug: "preseason" },
    { date: "2026-03-14T00:00Z", seasonSlug: null },
  ];
  assert.equal(fixtureKickoffs(events).length, 1);
  const cal = computeCalendar(events, "2026-03-09", utc("2026-03-09"));
  assert.equal(isPausedMonday(cal, "2026-03-09"), false);
});

test("owner overrides: forcePaused adds, forceLive wins even past the season end", () => {
  const cal = computeCalendar(season2026, "2026-03-09", utc("2026-03-09"),
    { forcePaused: ["2026-05-04"], forceLive: ["2026-06-01", "2026-11-23"] });
  assert.equal(isPausedMonday(cal, "2026-05-04"), true);
  assert.equal(isPausedMonday(cal, "2026-06-01"), false);
  assert.equal(isPausedMonday(cal, "2026-11-23"), false);
  assert.deepEqual(cal.overrides, { forcePaused: ["2026-05-04"], forceLive: ["2026-06-01", "2026-11-23"] });
});

test("mondayStart is Monday-based UTC (Sunday belongs to the PREVIOUS week)", () => {
  assert.equal(ymd(mondayStart(utc("2026-03-15"))), "2026-03-09");   // a Sunday
  assert.equal(ymd(mondayStart(utc("2026-03-09"))), "2026-03-09");   // a Monday
});
