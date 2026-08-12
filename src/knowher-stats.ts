// Know Her Game — the per-player STAT (`herGame`) questions, generated in CODE, IN-WORKER.
//
// This is the TypeScript twin of `scripts/knowher-stat-questions.mjs` + the weave from
// `scripts/inject_stat_questions.mjs`. Why a twin instead of importing the .mjs: those scripts pull in
// Node built-ins (fs/url) and can't run inside the Worker. The generation logic itself is pure, so it
// ports cleanly — and `test/knowher-stats-parity.test.ts` asserts this file produces byte-identical
// questions to the .mjs for the same inputs, so the two copies can never silently drift.
//
// Live path (2026-08-12, the weekend/Monday split): the WEEKEND verify gate stages a HUMAN-ONLY pool; the
// MONDAY `publishVerifiedPool` (knowher.ts) injects fresh stats via THIS module so the numbers reflect
// Sunday-night games, then publishes. `buildStatQuestionsN` also backs **Lever 1** — a short player gets
// EXTRA deterministic stats (up to a cap) to reach the app's 10-question floor rather than holding the run.
//
// Owner rule the distractor math honors: options must be GETTABLE — a fan who roughly knows the player can
// reason to the answer ("she played about half the season"). Every set is an evenly-spaced run whose step
// scales with the stat's magnitude; for minutes the step is a fraction of what she COULD have played.

import type { KnowHerQuestion } from "./knowher.ts";

/** The stat shape `buildStatQuestions` reads — the /knowher/todo player numbers plus name+position. */
export interface StatInput {
  name?: string;
  playerName?: string;
  position?: string;
  starts?: number;
  minutes?: number;
  appearances?: number;
  goals?: number;
  assists?: number;
  shots?: number;
  shotsOnTarget?: number;
  cleanSheets?: number;
  saves?: number;
}

/** Coerce a possibly-absent stat to a truthful number (never NaN, never the string "undefined"). */
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const s = (v: number): string => (v === 1 ? "" : "s");
const matches = (v: number): string => `${v} full match${v === 1 ? "" : "es"}`;

// Position → role map, replicated from scripts/assemble_knowher_prompt.mjs (POSITION_WORD/isKeeper). The
// parity test guards against drift; expand BOTH copies together if ESPN adds a position code.
const POSITION_WORD: Record<string, string> = {
  F: "Forward", CF: "Forward", ST: "Forward", S: "Forward", W: "Forward", RW: "Forward", LW: "Forward", FW: "Forward",
  M: "Midfielder", CM: "Midfielder", DM: "Midfielder", AM: "Midfielder", MF: "Midfielder",
  D: "Defender", CB: "Defender", RB: "Defender", LB: "Defender", WB: "Defender", FB: "Defender",
  G: "Goalkeeper", GK: "Goalkeeper",
};
const isKeeper = (pos: string | undefined): boolean => POSITION_WORD[pos ?? ""] === "Goalkeeper";

/** Minutes below this don't support a "how much of the season did she play" read — a bench player's
 *  total is better asked as starts/appearances, so the selector skips minutes under ~3 full matches. */
const MIN_MINUTES_QUESTION = 270;

/** Preference order per player archetype. Buildable keys are taken in order (a key is skipped when its
 *  value is 0/absent — "how many goals? 0" is not a question — or when its options can't be built). */
const KEEPER_PREF = ["saves", "cleanSheets", "minutes", "starts", "appearances"];
const SCORER_PREF = ["goals", "shotsOnTarget", "assists", "minutes", "shots", "starts", "appearances"];
const GRINDER_PREF = ["minutes", "assists", "shots", "starts", "shotsOnTarget", "appearances"];

/** Keeper test. Reuses the same position map, and also accepts the spelled-out word, because the pool
 *  carries "Goalkeeper" where /knowher/todo carries "G". */
function isKeeperPosition(position: string | undefined): boolean {
  return isKeeper(position) || String(position ?? "").toLowerCase().startsWith("goalkeep");
}

/** Minutes she COULD have played — appearances × a full match, floored at what she actually played. */
function ceilingMinutes(player: StatInput): number {
  const apps = Math.max(n(player.appearances), n(player.starts), 1);
  return Math.max(n(player.minutes), apps * 90);
}

/** Gap between adjacent options, scaled to the stat's magnitude so every set is gettable, not a math test. */
function stepFor(key: string, correct: number, player: StatInput): number {
  if (key === "minutes") return Math.max(90, Math.round(ceilingMinutes(player) / 25) * 5);
  if (key === "saves") return Math.max(3, Math.round(correct * 0.13));
  if (key === "shots") return Math.max(2, Math.round(correct * 0.18));
  return Math.max(1, Math.round(correct * 0.22)); // small counting stats
}

/** Plausibility rails — a distractor must stay inside what the season allows. Always widened to include the true value. */
function boundsFor(key: string, correct: number, player: StatInput): { min: number; max: number } {
  const apps = Math.max(n(player.appearances), n(player.starts), 1);
  let min = 0;
  let max = Infinity;
  switch (key) {
    case "minutes":
      min = 90;
      max = ceilingMinutes(player);
      break;
    case "cleanSheets":
    case "starts":
    case "appearances":
      max = apps;
      break;
    case "shotsOnTarget":
      max = Math.max(n(player.shots), n(player.shotsOnTarget));
      break;
    default:
      break;
  }
  return { min: Math.min(min, correct), max: Math.max(max, correct) };
}

/**
 * Four evenly-spaced options containing `correct`, inside [min, max]. `belowTarget` (0–3) is how many
 * options sit BELOW the correct one — derived deterministically so the answer's slot varies across
 * questions. Returns null when the rails can't fit four distinct values (caller falls back to another stat).
 */
export function spreadOptions(
  correct: number, step: number, min: number, max: number, belowTarget: number,
): { options: string[]; correctIndex: number } | null {
  const below: number[] = [];
  const above: number[] = [];
  const want = Math.max(0, Math.min(3, belowTarget));

  for (let i = 1; below.length < want; i++) {
    const v = correct - i * step;
    if (v < min) break;
    below.push(v);
  }
  for (let i = 1; below.length + above.length < 3; i++) {
    const v = correct + i * step;
    if (v > max) break;
    above.push(v);
  }
  for (let i = below.length + 1; below.length + above.length < 3; i++) {
    const v = correct - i * step;
    if (v < min) break;
    below.push(v);
  }

  const all = [...below, correct, ...above].sort((a, b) => a - b);
  if (all.length !== 4 || new Set(all).size !== 4) return null;
  return { options: all.map(String), correctIndex: all.indexOf(correct) };
}

/** Prompt + reveal copy per stat. */
const STAT_COPY: Record<string, { prompt: (name: string) => string; reveal: (v: number) => string }> = {
  goals: {
    prompt: (name) => `How many goals has ${name} scored this season?`,
    reveal: (v) => (v === 1 ? "One goal this season — and it counted." : `${v} goals this season — every one of them earned.`),
  },
  assists: {
    prompt: (name) => `How many assists does ${name} have this season?`,
    reveal: (v) => `${v} assist${s(v)} this season — she's just as happy setting one up.`,
  },
  shots: {
    prompt: (name) => `How many shots has ${name} taken this season?`,
    reveal: (v) => (v >= 15
      ? `${v} shots this season — she isn't shy about pulling the trigger.`
      : `${v} shot${s(v)} this season — every one a look at goal.`),
  },
  shotsOnTarget: {
    prompt: (name) => `How many of ${name}'s shots have been on target this season?`,
    reveal: (v) => `${v} on target this season — she makes keepers work.`,
  },
  minutes: {
    prompt: (name) => `How many minutes has ${name} played this season?`,
    reveal: (v) => `${v} minutes this season — roughly ${matches(Math.round(v / 90))} of work.`,
  },
  saves: {
    prompt: (name) => `How many saves has ${name} made this season?`,
    reveal: (v) => `${v} save${s(v)} this season — a lot of trouble kept out.`,
  },
  cleanSheets: {
    prompt: (name) => `How many clean sheets does ${name} have this season?`,
    reveal: (v) => `${v} clean sheet${s(v)} this season — nights the goal stayed shut.`,
  },
  starts: {
    prompt: (name) => `How many matches has ${name} started this season?`,
    reveal: (v) => `${v} start${s(v)} this season — her name on the teamsheet.`,
  },
  appearances: {
    prompt: (name) => `In how many matches has ${name} appeared this season?`,
    reveal: (v) => `${v} appearance${s(v)} this season.`,
  },
};

/** Minutes only: swap the lowest option for the ceiling ("played every minute") so a near-ceiling total
 *  doesn't always land at the top of its set. Skipped when she genuinely played every minute or the gap is
 *  under a substitute's cameo. */
function withEveryMinuteOption(
  spread: { options: string[]; correctIndex: number }, correct: number, ceiling: number,
): { options: string[]; correctIndex: number } {
  if (spread.correctIndex !== spread.options.length - 1) return spread;
  if (ceiling - correct < 60) return spread;
  const vals = [...spread.options.slice(1).map(Number), ceiling].sort((a, b) => a - b);
  if (new Set(vals).size !== 4) return spread;
  return { options: vals.map(String), correctIndex: vals.indexOf(correct) };
}

/** Is this stat worth asking about at all? A zero has no interesting distractor set. */
function usable(key: string, player: StatInput): boolean {
  const v = n((player as Record<string, unknown>)[key]);
  if (key === "minutes") return v >= MIN_MINUTES_QUESTION;
  return v > 0;
}

/** Build one question, or null if the stat's rails can't produce four distinct plausible options. */
function buildOne(abbr: string, player: StatInput, key: string): KnowHerQuestion | null {
  const correct = n((player as Record<string, unknown>)[key]);
  const copy = STAT_COPY[key];
  if (!copy) return null;
  const { min, max } = boundsFor(key, correct, player);
  let spread = spreadOptions(correct, stepFor(key, correct, player), min, max, (correct + key.length) % 4);
  if (!spread) return null;
  if (key === "minutes") spread = withEveryMinuteOption(spread, correct, ceilingMinutes(player));

  const name = String(player.name ?? player.playerName ?? "she").trim();
  return {
    id: `${String(abbr).toLowerCase()}-stat-${key.toLowerCase()}`,
    category: "herGame",
    prompt: copy.prompt(name),
    options: spread.options,
    correctIndex: spread.correctIndex,
    revealFact: copy.reveal(correct),
  };
}

/**
 * Up to `max` deterministic `herGame` questions for one player, taken in archetype-preference order.
 * Returns as many as the player's stats can support (may be fewer than `max` for a thin bench player).
 * `buildStatQuestions` is the exactly-2 case for parity with the .mjs; `publishVerifiedPool` calls this
 * with a higher `max` for Lever 1's stat top-up.
 */
export function buildStatQuestionsN(abbr: string, player: StatInput, max: number): KnowHerQuestion[] {
  if (!player || typeof player !== "object") throw new Error(`buildStatQuestions(${abbr}): no stats for this player`);

  const pref = isKeeperPosition(player.position)
    ? KEEPER_PREF
    : n(player.goals) > 0
      ? SCORER_PREF
      : GRINDER_PREF;

  const questions: KnowHerQuestion[] = [];
  for (const key of pref) {
    if (questions.length >= max) break;
    if (!usable(key, player)) continue;
    const q = buildOne(abbr, player, key);
    if (q) questions.push(q);
  }
  return questions;
}

/**
 * Exactly 2 `herGame` questions for one player — the standard case, byte-identical to
 * `scripts/knowher-stat-questions.mjs`. Throws if the stats can't support 2 (caller must fail LOUD).
 */
export function buildStatQuestions(abbr: string, player: StatInput): KnowHerQuestion[] {
  const questions = buildStatQuestionsN(abbr, player, 2);
  if (questions.length < 2) {
    throw new Error(
      `${abbr} (${player?.name ?? "?"}): only ${questions.length} stat question(s) buildable from ` +
        `${JSON.stringify({ position: player.position, minutes: n(player.minutes), starts: n(player.starts), appearances: n(player.appearances), goals: n(player.goals), assists: n(player.assists), shots: n(player.shots), shotsOnTarget: n(player.shotsOnTarget), saves: n(player.saves), cleanSheets: n(player.cleanSheets) })}`,
    );
  }
  return questions;
}

/**
 * Weave `stat` questions INTO the `human` run at evenly-spaced interior seams, rather than appending —
 * the app plays questions in pool order and the flow rule is a quiz never ends on (or opens on) a dry
 * stat question. For 2 stats this reproduces the .mjs `weave` exactly (parity-tested); for more (Lever 1)
 * it distributes them through the run, still keeping the first and last slots human.
 */
export function weaveStats(human: KnowHerQuestion[], stat: KnowHerQuestion[]): KnowHerQuestion[] {
  const h = human.length;
  const k = stat.length;
  if (k === 0) return [...human];
  if (h === 0) return [...stat];

  // Walk the human run, emitting each stat once ~i/(k+1) of the humans are placed. For the standard 2-stat
  // case this reproduces the .mjs `weave` seams exactly (⅓ and ⅔ marks, parity-tested). One human is
  // reserved for the tail so the quiz ends human, and the first stat always has ≥1 human before it — so
  // both ends stay human. When k ≥ h (only reachable at Lever-1's 5+5 cap) the run is too dense to keep
  // every stat non-adjacent; the walk still keeps the ends human and packs adjacency as late as possible.
  const out: KnowHerQuestion[] = [];
  let hi = 0;
  for (let i = 0; i < k; i++) {
    const target = i === 0 ? Math.max(1, Math.round(h / (k + 1))) : Math.round(((i + 1) * h) / (k + 1));
    const availBeforeTail = Math.max(0, h - hi - 1); // keep 1 human for after the last stat
    let take = Math.max(0, target - hi);
    take = Math.min(take, availBeforeTail);
    if (i === 0) take = Math.max(1, take); // never open on a stat (needs ≥1 human up front)
    out.push(...human.slice(hi, hi + take));
    hi += take;
    out.push(stat[i]);
  }
  out.push(...human.slice(hi));
  return out;
}
