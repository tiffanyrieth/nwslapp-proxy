// Content-quality lints for the Know Her Game pool validator (scripts/load_knowher.mjs). These are the
// automation's replacement for the human curator — each test pins a failure mode the first fully-automated
// round hit (uniform 8-question players, ~80% of True/False answers "True"). Run:
//   node --test test/load_knowher.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePool } from "../scripts/load_knowher.mjs";

// Build one question of a given category. T/F answer defaults to True (correctIndex 0).
function q(id: string, category: string, correctIndex = 0) {
	const tf = category === "trueOrFalse";
	return {
		id, category, prompt: `prompt ${id}`,
		options: tf ? ["True", "False"] : ["a", "b", "c", "d"],
		correctIndex, revealFact: "fact",
	};
}

// Build a player with `human` story questions (default: 2 T/F + the rest herStory) and `stat` herGame Qs.
function player(abbr: string, { human = 6, stat = 4, tfTrue = 1 }: { human?: number; stat?: number; tfTrue?: number } = {}) {
	const qs: ReturnType<typeof q>[] = [];
	// T/F first (tfTrue of them answer True, the rest False), then herStory to fill `human`.
	const tfCount = Math.min(2, human);
	for (let i = 0; i < tfCount; i++) qs.push(q(`${abbr}-tf${i}`, "trueOrFalse", i < tfTrue ? 0 : 1));
	for (let i = tfCount; i < human; i++) qs.push(q(`${abbr}-h${i}`, "herStory"));
	for (let i = 0; i < stat; i++) qs.push(q(`${abbr}-g${i}`, "herGame"));
	return {
		teamAbbreviation: abbr, espnAthleteId: `id-${abbr}`, playerName: `Player ${abbr}`,
		jerseyNumber: 7, position: "Defender", tagline: "warm one-liner", questions: qs,
	};
}

function pool(players: ReturnType<typeof player>[]) {
	return { weekKey: "2026-W30", season: 2026, players };
}

const ABBRS = ["WAS", "LA", "BAY", "BOS", "CHI", "DEN"];

test("a healthy pool (10 Qs/player, mixed T/F) passes clean", () => {
	const { errors, warnings } = validatePool(pool(ABBRS.map((a) => player(a, { human: 6, stat: 4, tfTrue: 1 }))));
	assert.deepEqual(errors, []);
	assert.deepEqual(warnings, []);
});

test("uniform 8-question players fail the 10-question floor", () => {
	const { errors } = validatePool(pool(ABBRS.map((a) => player(a, { human: 6, stat: 2 })))); // 8 total
	assert.ok(errors.some((e) => e.includes("must have 10")), errors.join(" | "));
});

test("too many stat (herGame) questions fails — human-first, not a stat sheet", () => {
	const { errors } = validatePool(pool(ABBRS.map((a) => player(a, { human: 5, stat: 6 }))));
	assert.ok(errors.some((e) => e.includes("stat (herGame)")), errors.join(" | "));
});

test("too few human questions fails", () => {
	const { errors } = validatePool(pool(ABBRS.map((a) => player(a, { human: 4, stat: 6 }))));
	assert.ok(errors.some((e) => e.includes("human")), errors.join(" | "));
});

test("a pool where >65% of True/False answers are 'True' fails (the banned obvious-true pattern)", () => {
	// Every player: 2 T/F both True → 100% True across the pool.
	const { errors } = validatePool(pool(ABBRS.map((a) => player(a, { human: 6, stat: 4, tfTrue: 2 }))));
	assert.ok(errors.some((e) => e.includes('"True"')), errors.join(" | "));
});

test("a balanced True/False pool passes the ratio check", () => {
	// Each player: 1 True + 1 False → 50% True.
	const { errors } = validatePool(pool(ABBRS.map((a) => player(a, { human: 6, stat: 4, tfTrue: 1 }))));
	assert.ok(!errors.some((e) => e.includes('"True"')), errors.join(" | "));
});
