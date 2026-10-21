// New-device email decision (src/new-device-alert.ts). Run: node --test test/new-device-alert.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNewDeviceAlert, isoWeekStartDay, newDeviceAlertEnabled, newDeviceBaseline, type AnalyticsEvent } from "../src/new-device-alert.ts";

const ev = (event: string, param = ""): AnalyticsEvent => ({ event, param, n: 1 });

test("a first-ever install alerts, even before the week count is known", () => {
  const a = decideNewDeviceAlert([ev("session_start"), ev("active_week", "new"), ev("active_month", "new")], null, 2);
  assert.match(a?.subject ?? "", /new device/);
});

test("a tester returning after a skipped week does not alert (2 devices this week)", () => {
  assert.equal(decideNewDeviceAlert([ev("active_week", "returning")], 2, 2), null);
  assert.equal(decideNewDeviceAlert([ev("active_week", "returning")], 1, 2), null);
});

test("a 3rd device this week alerts even when it reports returning (reused review device)", () => {
  const a = decideNewDeviceAlert([ev("active_week", "returning")], 3, 2);
  assert.equal(a?.subject, "3 devices active this week");
});

test("a monthly-only counter never re-alerts an already-over-baseline week", () => {
  assert.equal(decideNewDeviceAlert([ev("active_month", "returning")], 3, 2), null);
});

test("batches without activity counters never alert", () => {
  assert.equal(decideNewDeviceAlert([ev("tab_opened", "home")], 9, 2), null);
});

test("switch is off unless explicitly on; baseline defaults to 2", () => {
  assert.equal(newDeviceAlertEnabled({}), false);
  assert.equal(newDeviceAlertEnabled({ NEW_DEVICE_ALERT: "0" }), false);
  assert.equal(newDeviceAlertEnabled({ NEW_DEVICE_ALERT: "1" }), true);
  assert.equal(newDeviceAlertEnabled({ NEW_DEVICE_ALERT: " On " }), true);
  assert.equal(newDeviceBaseline({}), 2);
  assert.equal(newDeviceBaseline({ NEW_DEVICE_ALERT_BASELINE: "3" }), 3);
  assert.equal(newDeviceBaseline({ NEW_DEVICE_ALERT_BASELINE: "x" }), 2);
});

test("isoWeekStartDay: the UTC Monday of the week", () => {
  assert.equal(isoWeekStartDay(new Date("2026-10-21T23:00:00Z")), "2026-10-19"); // Wed
  assert.equal(isoWeekStartDay(new Date("2026-10-19T00:00:00Z")), "2026-10-19"); // Mon
  assert.equal(isoWeekStartDay(new Date("2026-10-25T23:59:00Z")), "2026-10-19"); // Sun
});
