// Watcher batch-summaries helpers (2026-10-13). Pure. Run: node --test test/watch-summaries.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildWatchSummariesEnvelope, looksLikeJsonObject, parseWatchSummaryEntries, summaryUrlFor, WATCH_SUMMARIES_MAX,
} from "../src/watch-summaries.ts";

const LEAGUES = new Set(["usa.nwsl", "fifa.friendly.w", "fifa.wworldq.uefa"]);
const enc = (s: string) => new TextEncoder().encode(s);

test("parses entries with and without the bust flag", () => {
	const r = parseWatchSummaryEntries("401:usa.nwsl,402:fifa.friendly.w:1", LEAGUES);
	assert.deepEqual(r, { entries: [
		{ id: "401", league: "usa.nwsl", bust: false, unknownLeague: false },
		{ id: "402", league: "fifa.friendly.w", bust: true, unknownLeague: false },
	], skipped: [] });
});

test("an unknown league fails only its own entry", () => {
	const r = parseWatchSummaryEntries("401:evil.league,402:usa.nwsl", LEAGUES);
	assert.ok("entries" in r);
	assert.deepEqual(r.entries.map((e) => e.unknownLeague), [true, false]);
});

test("malformed entries are skipped, never sinking the real ones beside them", () => {
	const r = parseWatchSummaryEntries("fakematch-1791929352530:usa.nwsl,401:usa.nwsl,402:usa.nwsl:2,403,404:,405:usa.nwsl:1:x,406:usa.nwsl:1", LEAGUES);
	assert.ok("entries" in r);
	assert.deepEqual(r.entries.map((e) => e.id), ["401", "406"]);
	assert.equal(r.skipped.length, 5);
});

test("only a missing / empty / oversized list rejects the whole request", () => {
	for (const raw of ["", null, ","]) assert.ok("error" in parseWatchSummaryEntries(raw, LEAGUES), `expected error for ${raw}`);
	const many = Array.from({ length: WATCH_SUMMARIES_MAX + 1 }, (_, i) => `${i + 1}:usa.nwsl`).join(",");
	assert.ok("error" in parseWatchSummaryEntries(many, LEAGUES));
});

test("dedupes ids", () => {
	const dup = parseWatchSummaryEntries("7:usa.nwsl,7:usa.nwsl:1", LEAGUES);
	assert.ok("entries" in dup && dup.entries.length === 1);
});

test("summaryUrlFor reproduces the watcher's old per-match URL exactly", () => {
	assert.equal(summaryUrlFor({ id: "9", league: "usa.nwsl", bust: false, unknownLeague: false }, 5), "https://proxy/summary?event=9");
	assert.equal(summaryUrlFor({ id: "9", league: "usa.nwsl", bust: true, unknownLeague: false }, 5), "https://proxy/summary?event=9&_lc=5");
	assert.equal(summaryUrlFor({ id: "9", league: "fifa.friendly.w", bust: true, unknownLeague: false }, 5),
		"https://proxy/summary?event=9&league=fifa.friendly.w&_lc=5");
});

test("looksLikeJsonObject accepts objects (with whitespace) and rejects html/empty/arrays", () => {
	assert.ok(looksLikeJsonObject(enc(' \n{"a":1}\n ')));
	for (const s of ["", "   ", "<html></html>", "[1]", "{", '{"a":1'] ) assert.ok(!looksLikeJsonObject(enc(s)), s);
});

test("envelope inlines good bodies raw and emits status-only entries for failures", () => {
	const out = buildWatchSummariesEnvelope([
		{ id: "1", status: 200, body: enc('{"keyEvents":[{"x":"é"}]}') },
		{ id: "2", status: 404, body: null },
		{ id: "3", status: 200, body: enc("<html>oops</html>") },
		{ id: "4", status: 0, body: null },
	]);
	const parsed = JSON.parse(new TextDecoder().decode(out));
	assert.deepEqual(parsed, [
		{ id: "1", status: 200, body: { keyEvents: [{ x: "é" }] } },
		{ id: "2", status: 404 },
		{ id: "3", status: 502 },
		{ id: "4", status: 0 },
	]);
});

test("empty batch is a valid empty array", () => {
	assert.deepEqual(JSON.parse(new TextDecoder().decode(buildWatchSummariesEnvelope([]))), []);
});
