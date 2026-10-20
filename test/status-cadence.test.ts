// Admin status rows judge each snapshot against ITS OWN cadence (2026-10-20: feeds moved hourly → 4h and the
// rows still warned at 75 min — "refreshed 77 min ago (hourly)").
import { test } from "node:test";
import assert from "node:assert/strict";
import { cadenceCheck, backoffNote } from "../src/index.ts";

const H = 3600_000;

test("a 4-hourly snapshot is OK at 77 min and at 4h, warns past 4h30, fails past 8h30", () => {
	assert.equal(cadenceCheck("Podcasts snapshot", 77 * 60_000, 4 * H, "every 4h").status, "ok");
	assert.equal(cadenceCheck("Podcasts snapshot", 4 * H + 5 * 60_000, 4 * H, "every 4h").status, "ok");
	assert.equal(cadenceCheck("Podcasts snapshot", 5 * H, 4 * H, "every 4h").status, "warn");
	assert.equal(cadenceCheck("Podcasts snapshot", 9 * H, 4 * H, "every 4h").status, "fail");
	assert.match(cadenceCheck("x", 77 * 60_000, 4 * H, "every 4h").detail, /refreshed 1h ago \(every 4h\)/);
});

test("a failing feed's row says it's backing off and when it tries next", () => {
	const now = Date.now();
	assert.equal(backoffNote(undefined, now), "");
	assert.match(backoffNote({ failStreak: 3, nextAttemptAt: now + 20 * H, failingSince: now - 3 * 86_400_000 }, now), /backing off \(3× in a row, failing 3d; next try in 20h\)/);
});
