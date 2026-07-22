// Pure-logic tests for the code-generated Know Her Game stat questions. Run with the Node test runner
// (vitest-pool-workers can't boot workerd on Node 26 — see CLAUDE.md):
//   node --test test/knowher-stat-questions.test.ts
//
// No network, no fixtures: buildStatQuestions / injectStatQuestions are pure given a player's stats.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatQuestions, spreadOptions } from "../scripts/knowher-stat-questions.mjs";
import { injectStatQuestions } from "../scripts/inject_stat_questions.mjs";

/** Terse builder — a /knowher/todo player. Overrides carry whatever the case under test needs. */
function p(over: Record<string, unknown> = {}) {
	return {
		name: "Test Player", position: "F", starts: 12, minutes: 1035, appearances: 14,
		goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, cleanSheets: 0, saves: 0, ...over,
	};
}

/** Every question must satisfy the pool schema load_knowher.mjs enforces. */
function assertSchema(q: any) {
	assert.equal(q.category, "herGame");
	assert.ok(typeof q.id === "string" && q.id.trim(), "id must be a non-blank string");
	assert.ok(typeof q.prompt === "string" && q.prompt.trim(), "prompt must be a non-blank string");
	assert.equal(q.options.length, 4, "MC needs exactly 4 options");
	assert.ok(q.options.every((o: unknown) => typeof o === "string" && (o as string).trim()), "options must be non-blank strings");
	assert.equal(new Set(q.options).size, 4, "options must be distinct");
	assert.ok(Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4, "correctIndex must be 0–3");
	assert.ok(typeof q.revealFact === "string" && q.revealFact.trim(), "revealFact must be a non-blank string");
}

const answerOf = (q: any) => Number(q.options[q.correctIndex]);

test("always exactly 2 questions, schema-valid, with the true value as the answer", () => {
	const qs = buildStatQuestions("WAS", p({ goals: 3, shots: 36, shotsOnTarget: 14, assists: 4 }));
	assert.equal(qs.length, 2);
	qs.forEach(assertSchema);
	assert.equal(answerOf(qs[0]), 3, "goals answer is the real number");
	assert.equal(answerOf(qs[1]), 14, "shots-on-target answer is the real number");
});

test("selection by archetype: keeper → saves + clean sheets", () => {
	const qs = buildStatQuestions("KC", p({ position: "G", saves: 44, cleanSheets: 6, minutes: 1260, appearances: 14 }));
	assert.deepEqual(qs.map((q) => q.id), ["kc-stat-saves", "kc-stat-cleansheets"]);
	assert.equal(answerOf(qs[0]), 44);
	assert.equal(answerOf(qs[1]), 6);
});

test("selection by archetype: a scorer → goals + shots on target", () => {
	const qs = buildStatQuestions("POR", p({ goals: 7, shots: 30, shotsOnTarget: 12 }));
	assert.deepEqual(qs.map((q) => q.id), ["por-stat-goals", "por-stat-shotsontarget"]);
});

test("selection by archetype: a non-scorer → minutes + assists (never a zero-valued stat)", () => {
	const qs = buildStatQuestions("NC", p({ goals: 0, assists: 2, shots: 0 }));
	assert.deepEqual(qs.map((q) => q.id), ["nc-stat-minutes", "nc-stat-assists"]);
	// A stat she has none of is never asked about ("how many goals? 0" is not a question).
	const noZeroAnswers = buildStatQuestions("SEA", p({ goals: 0, assists: 0, shots: 0, starts: 9, appearances: 11 }));
	noZeroAnswers.forEach((q) => assert.ok(answerOf(q) > 0, `${q.id} must not have 0 as its answer`));
});

test("minutes options read as season-share, not a math test (the banned 858/906/932/971 spread)", () => {
	const q = buildStatQuestions("BAY", p({ minutes: 1035, appearances: 16, starts: 14 }))[0];
	assert.equal(q.id, "bay-stat-minutes");
	assert.equal(answerOf(q), 1035);
	const vals = q.options.map(Number);
	const gaps = vals.slice(1).map((v, i) => v - vals[i]);
	assert.ok(Math.min(...gaps) >= 250, `minutes options must be far apart, got gaps ${gaps.join("/")}`);
	// Ruling out the specific failure the AI produced: options a couple of minutes apart.
	assert.ok(Math.min(...gaps) > 90, "options must never sit ~one match apart for a full-season player");
});

test("minutes: an every-minute player's total lands at the top (nothing plausible sits above the ceiling)", () => {
	const q = buildStatQuestions("ORL", p({ minutes: 1440, appearances: 16, starts: 16 }))[0];
	assert.equal(q.correctIndex, 3);
	assert.equal(answerOf(q), 1440);
	assert.ok(q.options.map(Number).every((v) => v <= 1440), "no option may exceed what she could have played");
});

test("minutes: a near-ceiling total gets a 'played every minute' option above it, not the top slot", () => {
	// 1290 of a possible 1440 — the spread can't grow past the ceiling, so without the swap the answer
	// would sit at the top of every such set ("pick the biggest" becomes a free hint for most starters).
	const q = buildStatQuestions("NC", p({ minutes: 1290, appearances: 16, starts: 15 }))[0];
	assert.equal(answerOf(q), 1290);
	assert.notEqual(q.correctIndex, 3, "the answer must not be the largest option when she missed minutes");
	assert.equal(Number(q.options[3]), 1440, "the top option is every minute of every match");
});

test("minutes are skipped when too few to support a season-share read", () => {
	const qs = buildStatQuestions("HOU", p({ minutes: 180, appearances: 4, starts: 1, assists: 1, shots: 5 }));
	assert.ok(!qs.some((q) => q.id.endsWith("-minutes")), "a 2-match minutes total is not a season-share question");
});

test("distractors stay plausible: never negative, never more than the season allows", () => {
	const low = buildStatQuestions("CHI", p({ goals: 1, shots: 4, shotsOnTarget: 2 }));
	low.forEach((q) => q.options.forEach((o) => assert.ok(Number(o) >= 0, `${q.id}: negative option ${o}`)));

	const keeper = buildStatQuestions("LOU", p({ position: "G", saves: 30, cleanSheets: 5, appearances: 12, starts: 12 }));
	const cs = keeper.find((q) => q.id.endsWith("-cleansheets"))!;
	cs.options.forEach((o) => assert.ok(Number(o) <= 12, `clean sheets ${o} exceeds her 12 appearances`));

	const sot = buildStatQuestions("SD", p({ goals: 2, shots: 20, shotsOnTarget: 9 })).find((q) => q.id.endsWith("-shotsontarget"))!;
	sot.options.forEach((o) => assert.ok(Number(o) <= 20, `shots on target ${o} exceeds her 20 shots`));
});

test("the answer's slot varies across stats (it is not always the same index)", () => {
	const slots = new Set<number>();
	for (const goals of [1, 2, 3, 4, 5, 6, 7, 8]) {
		slots.add(buildStatQuestions("UTA", p({ goals, shots: 30, shotsOnTarget: 12 }))[0].correctIndex);
	}
	assert.ok(slots.size >= 3, `the correct option must move around, saw slots ${[...slots].join(",")}`);
});

test("ids are stable, namespaced by club, and unique within a player", () => {
	const a = buildStatQuestions("GFC", p({ goals: 5, shotsOnTarget: 11 }));
	const b = buildStatQuestions("GFC", p({ goals: 5, shotsOnTarget: 11 }));
	assert.deepEqual(a.map((q) => q.id), b.map((q) => q.id), "same input ⇒ same ids (re-runnable)");
	assert.deepEqual(a, b, "generation is fully deterministic");
	assert.equal(new Set(a.map((q) => q.id)).size, 2);
	assert.ok(a.every((q) => q.id.startsWith("gfc-stat-")));
});

test("a player with no usable stats throws rather than publishing a short quiz", () => {
	assert.throws(() => buildStatQuestions("DEN", p({ minutes: 0, starts: 0, appearances: 0 })), /buildable/);
	assert.throws(() => buildStatQuestions("DEN", undefined as any), /no stats/);
});

test("spreadOptions: returns null instead of a malformed set when the rails can't fit four values", () => {
	assert.equal(spreadOptions(2, 1, 2, 3, 1), null); // only 2 and 3 available
	const ok = spreadOptions(10, 5, 0, Infinity, 2);
	assert.deepEqual(ok, { options: ["0", "5", "10", "15"], correctIndex: 2 });
});

const human = (abbr: string, count: number) =>
	Array.from({ length: count }, (_, i) => ({ id: `${abbr}-x-${i}`, category: "herWorld" }));

test("injection: merges by athlete id and keeps the human questions in order", () => {
	const pool = {
		weekKey: "2026-W30", season: 2026,
		players: [
			{ teamAbbreviation: "WAS", espnAthleteId: "317423", playerName: "A", questions: human("was", 8) },
			{ teamAbbreviation: "KC", espnAthleteId: "999", playerName: "B", questions: human("kc", 9) },
		],
	};
	const stats = {
		"317423": p({ name: "A", goals: 3, shots: 30, shotsOnTarget: 11 }),
		"999": p({ name: "B", position: "G", saves: 40, cleanSheets: 4, appearances: 12, starts: 12 }),
	};
	const res = injectStatQuestions(pool as any, stats as any);
	assert.deepEqual(res, { injected: 4, players: 2 });
	assert.equal(pool.players[0].questions.length, 10, "8 human + 2 stat clears the app's 10-question floor");
	assert.equal(pool.players[1].questions.length, 11);
	// The human run keeps its authored order — weaving only inserts.
	const humanIds = (pl: any) => pl.questions.filter((q: any) => q.category !== "herGame").map((q: any) => q.id);
	assert.deepEqual(humanIds(pool.players[0]), human("was", 8).map((q) => q.id));
	assert.deepEqual(pool.players[1].questions.filter((q: any) => q.category === "herGame").map((q: any) => q.id), ["kc-stat-saves", "kc-stat-cleansheets"]);
});

test("injection: stat questions are woven in, never dumped at the end", () => {
	for (const count of [8, 9, 10, 13]) {
		const pool = { players: [{ teamAbbreviation: "WAS", espnAthleteId: "1", playerName: "A", questions: human("was", count) }] };
		injectStatQuestions(pool as any, { "1": p({ goals: 3, shots: 30, shotsOnTarget: 11 }) } as any);
		const qs = pool.players[0].questions as any[];
		const at = qs.map((q, i) => (q.category === "herGame" ? i : -1)).filter((i) => i >= 0);
		assert.equal(at.length, 2, `${count} human: both stat questions present`);
		assert.notEqual(qs[qs.length - 1].category, "herGame", `${count} human: the quiz must end on a human question`);
		assert.ok(at[0] > 0, `${count} human: it must not open on a stat question`);
		assert.ok(at[1] - at[0] >= 2, `${count} human: the two stat questions must not be adjacent`);
	}
});

test("injection fails LOUD on an unmatched athlete id or a colliding question id", () => {
	const stats = { "317423": p({ goals: 3, shots: 30, shotsOnTarget: 11 }) };
	assert.throws(
		() => injectStatQuestions({ players: [{ teamAbbreviation: "WAS", espnAthleteId: "000", playerName: "Ghost", questions: [] }] } as any, stats as any),
		/not in the stats sidecar/,
	);
	assert.throws(
		() => injectStatQuestions({ players: [{ teamAbbreviation: "WAS", espnAthleteId: "317423", playerName: "A", questions: [{ id: "was-stat-goals" }] }] } as any, stats as any),
		/duplicate question id/,
	);
	assert.throws(() => injectStatQuestions({ players: [] } as any, stats as any), /no players/);
});
