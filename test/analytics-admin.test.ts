// Analytics dashboard helpers (owner's 2026-09-05 relabel + "last completed week" headline). Pure and
// deterministic (no Intl), so node --test pins the exact strings the admin page renders.
// Run: node --test test/analytics-admin.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { isoWeekDateRange, isoWeekMonday, monthLabel, onlyLiveFilters, pickHeadline } from "../src/analytics-admin.ts";

test("isoWeekMonday: ISO week 1 contains Jan 4; W36 of 2026 starts Mon Aug 31", () => {
  assert.equal(isoWeekMonday("2026-W01").toISOString().slice(0, 10), "2025-12-29");
  assert.equal(isoWeekMonday("2026-W36").toISOString().slice(0, 10), "2026-08-31");
});

test("isoWeekDateRange: same-month and cross-month weeks read as humans write them", () => {
  assert.equal(isoWeekDateRange("2026-W35"), "Aug 24–30");
  assert.equal(isoWeekDateRange("2026-W36"), "Aug 31 – Sep 6");   // crosses the month boundary
  assert.equal(isoWeekDateRange("2026-W01"), "Dec 29 – Jan 4");   // crosses the year boundary
});

test("monthLabel: YYYY-MM → month name; unknown input passes through", () => {
  assert.equal(monthLabel("2026-09"), "September");
  assert.equal(monthLabel("2026-01"), "January");
  assert.equal(monthLabel("garbage"), "garbage");
});

const weeks = [
  { week: "2026-W36", wau: 1, new: 0, returning: 1 },   // current (partial) week
  { week: "2026-W35", wau: 2, new: 1, returning: 1 },   // last completed
  { week: "2026-W34", wau: 2, new: 2, returning: 0 },
];
const months = [
  { month: "2026-09", mau: 1, new: 0, returning: 1 },
  { month: "2026-08", mau: 3, new: 2, returning: 1 },
];

test("pickHeadline: last COMPLETED week is the newest key strictly before the current one", () => {
  const h = pickHeadline(weeks, months, "2026-09-04");
  assert.equal(h.currentWeekKey, "2026-W36");
  assert.equal(h.lastCompletedWeek?.week, "2026-W35");
  assert.equal(h.currentWeekSoFar?.week, "2026-W36");
  assert.equal(h.monthToDate?.month, "2026-09");
});

test("pickHeadline: no data yet this week → so-far is null, last completed still resolves", () => {
  const h = pickHeadline(weeks.slice(1), months, "2026-09-04");
  assert.equal(h.currentWeekSoFar, null);
  assert.equal(h.lastCompletedWeek?.week, "2026-W35");
});

test("pickHeadline: first week ever (nothing completed) and a month with no rows → nulls, never a crash", () => {
  const h = pickHeadline([{ week: "2026-W36", wau: 1, new: 1, returning: 0 }], [], "2026-09-04");
  assert.equal(h.lastCompletedWeek, null);
  assert.equal(h.monthToDate, null);
});

test("pickHeadline: year rollover — 2025-W52 counts as completed relative to 2026-W01", () => {
  const h = pickHeadline([{ week: "2026-W01", wau: 1, new: 0, returning: 1 }, { week: "2025-W52", wau: 4, new: 1, returning: 3 }], [], "2026-01-02");
  assert.equal(h.currentWeekKey, "2026-W01");
  assert.equal(h.lastCompletedWeek?.week, "2025-W52");
});

test("onlyLiveFilters: the removed 'clubs' chip is hidden; live filters pass through", () => {
  assert.deepEqual(onlyLiveFilters({ players: 53, reporters: 35, all: 26, clubs: 8 }), { players: 53, reporters: 35, all: 26 });
});
