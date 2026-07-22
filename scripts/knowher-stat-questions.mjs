// Know Her Game — the per-player STAT (`herGame`) questions, generated in CODE (not by the model).
//
// WHY this is code and not AI: a stat question is 100% derivable from the verified ESPN numbers the
// proxy already serves at /knowher/todo — the answer IS the number and the distractors are just values
// around it. Handing that to the weekly routine spent tokens and attention on distractor tuning (which it
// did inconsistently — the banned "858 / 906 / 932 / 971" minutes spread is a mental-arithmetic test, not
// a quiz) instead of the HUMAN questions, which is the only place the model adds value. The routine now
// writes human-only; scripts/inject_stat_questions.mjs merges these in before validation.
//
// Pure + dependency-free so it unit-tests without network or fixtures:
//   node --test test/knowher-stat-questions.test.ts
//
// Owner rule the distractor math exists to honor: options must be GETTABLE — a fan who roughly knows the
// player should be able to reason to the answer ("she played about half the season"). Options that sit a
// few units apart make the quiz a memory test of an exact number nobody knows. So every option set is an
// evenly-spaced run whose step scales with the stat's magnitude, and for minutes the step is a fraction of
// what she COULD have played, so the four options read as visibly different shares of the season.

import { isKeeper } from "./assemble_knowher_prompt.mjs";

/** Coerce a possibly-absent stat to a truthful number (never NaN, never the string "undefined"). */
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const s = (v) => (v === 1 ? "" : "s");
const matches = (v) => `${v} full match${v === 1 ? "" : "es"}`;

/** Minutes below this don't support a "how much of the season did she play" read — a bench player's
 *  total is better asked as starts/appearances, so the selector skips minutes under ~3 full matches. */
const MIN_MINUTES_QUESTION = 270;

/** Preference order per player archetype. The FIRST TWO buildable keys win (a key is skipped when its
 *  value is 0/absent — "how many goals? 0" is not a question — or when its options can't be built). */
const KEEPER_PREF = ["saves", "cleanSheets", "minutes", "starts", "appearances"];
const SCORER_PREF = ["goals", "shotsOnTarget", "assists", "minutes", "shots", "starts", "appearances"];
const GRINDER_PREF = ["minutes", "assists", "shots", "starts", "shotsOnTarget", "appearances"];

/** Keeper test. Reuses the assembler's position map (single source of truth for abbreviation → role) and
 *  also accepts the spelled-out word, because the pool carries "Goalkeeper" where /knowher/todo carries "G". */
function isKeeperPosition(position) {
  return isKeeper(position) || String(position ?? "").toLowerCase().startsWith("goalkeep");
}

/** Minutes she COULD have played — appearances × a full match, floored at what she actually played (an
 *  ESPN appearances gap must never produce a ceiling below the truth). Anchors the minutes distractors. */
function ceilingMinutes(player) {
  const apps = Math.max(n(player.appearances), n(player.starts), 1);
  return Math.max(n(player.minutes), apps * 90);
}

/** Gap between adjacent options, scaled to the stat's magnitude so every set is gettable, not a math test. */
function stepFor(key, correct, player) {
  // Minutes: a fifth of the ceiling ⇒ the four options span ~80% of her possible season and read as
  // clearly different chunks of it (e.g. a 16-game ceiling ⇒ 290-minute steps ≈ 3+ matches apart).
  if (key === "minutes") return Math.max(90, Math.round(ceilingMinutes(player) / 25) * 5);
  if (key === "saves") return Math.max(3, Math.round(correct * 0.13));
  if (key === "shots") return Math.max(2, Math.round(correct * 0.18));
  return Math.max(1, Math.round(correct * 0.22)); // small counting stats
}

/** Plausibility rails — a distractor must stay inside what the season allows (no "20 clean sheets" in a
 *  16-game campaign, no negative shots). Always widened to include the true value. */
function boundsFor(key, correct, player) {
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
 * Four evenly-spaced options containing `correct`, inside [min, max].
 *
 * `belowTarget` (0–3) is how many options should sit BELOW the correct one — derived deterministically
 * from the stat so the answer's slot VARIES across questions. Without it every set would put the answer
 * in the same position and "it's never the first or last option" becomes a free hint. A side that runs
 * into a rail spills to the other side, which is exactly what makes a true every-minute player's total
 * land at the TOP of her set (nothing plausible sits above "played every minute").
 *
 * Even spacing is deliberate: an arithmetic run leaks nothing about WHICH value is the answer.
 * Returns null when the rails can't fit four distinct values — the caller falls back to another stat.
 */
export function spreadOptions(correct, step, min, max, belowTarget) {
  const below = [];
  const above = [];
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
  // Above hit its rail too — top the set up from underneath (continuing past what `below` already took).
  for (let i = below.length + 1; below.length + above.length < 3; i++) {
    const v = correct - i * step;
    if (v < min) break;
    below.push(v);
  }

  const all = [...below, correct, ...above].sort((a, b) => a - b);
  if (all.length !== 4 || new Set(all).size !== 4) return null;
  return { options: all.map(String), correctIndex: all.indexOf(correct) };
}

/** Prompt + reveal copy per stat. Deliberately terse and factual-warm — the HUMAN questions carry the
 *  personality; a stat reveal just needs to land the number and give it a little meaning. */
const STAT_COPY = {
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

/**
 * Minutes only. When her true total sits within one step of her ceiling the spread has nowhere to grow, so
 * the answer lands at the TOP of every such set — and most regular starters are in that band, which makes
 * "pick the biggest" a learnable free hint. It also wastes the single most meaningful distractor there is.
 * Swap the lowest option for the ceiling itself — "she played every minute of every match" — which pushes
 * the answer off the top and turns the question into a real either/or a fan can actually reason about.
 *
 * Skipped when she genuinely DID play every minute (the ceiling IS the answer, and nothing plausible sits
 * above it — that set SHOULD top out at the truth), or when the gap is under a substitute's cameo, where
 * the two top options would read as the same thing.
 */
function withEveryMinuteOption(spread, correct, ceiling) {
  if (spread.correctIndex !== spread.options.length - 1) return spread;
  if (ceiling - correct < 60) return spread;
  const vals = [...spread.options.slice(1).map(Number), ceiling].sort((a, b) => a - b);
  if (new Set(vals).size !== 4) return spread;
  return { options: vals.map(String), correctIndex: vals.indexOf(correct) };
}

/** Is this stat worth asking about at all? A zero has no interesting distractor set. */
function usable(key, player) {
  const v = n(player[key]);
  if (key === "minutes") return v >= MIN_MINUTES_QUESTION;
  return v > 0;
}

/** Build one question, or null if the stat's rails can't produce four distinct plausible options. */
function buildOne(abbr, player, key) {
  const correct = n(player[key]);
  const copy = STAT_COPY[key];
  if (!copy) return null;
  const { min, max } = boundsFor(key, correct, player);
  // Deterministic slot variation: same inputs ⇒ same question every run (re-runnable, testable), but the
  // answer's index moves around across stats and players.
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
 * The 2 `herGame` questions for one player.
 *
 * @param abbr   team abbreviation (namespaces the question ids)
 * @param player the /knowher/todo player: { name, position, starts, minutes, appearances, goals,
 *               assists, shots, shotsOnTarget, cleanSheets, saves }
 * @returns exactly 2 question objects in the pool's schema
 * @throws  if the player's stats can't support 2 questions (caller must fail LOUD, never publish silently)
 */
export function buildStatQuestions(abbr, player) {
  if (!player || typeof player !== "object") throw new Error(`buildStatQuestions(${abbr}): no stats for this player`);

  const pref = isKeeperPosition(player.position)
    ? KEEPER_PREF
    : n(player.goals) > 0
      ? SCORER_PREF
      : GRINDER_PREF;

  const questions = [];
  const skipped = [];
  for (const key of pref) {
    if (questions.length === 2) break;
    if (!usable(key, player)) continue;
    const q = buildOne(abbr, player, key);
    if (q) questions.push(q);
    else skipped.push(key); // rails too tight for 4 distinct options — try the next stat, loudly
  }

  if (skipped.length > 0) {
    console.error(`⚠️  ${abbr} (${player.name ?? "?"}): skipped stat(s) ${skipped.join(", ")} — couldn't build 4 distinct plausible options; used the next stat instead.`);
  }
  if (questions.length < 2) {
    throw new Error(
      `${abbr} (${player.name ?? "?"}): only ${questions.length} stat question(s) buildable from ` +
        `${JSON.stringify({ position: player.position, minutes: n(player.minutes), starts: n(player.starts), appearances: n(player.appearances), goals: n(player.goals), assists: n(player.assists), shots: n(player.shots), shotsOnTarget: n(player.shotsOnTarget), saves: n(player.saves), cleanSheets: n(player.cleanSheets) })}`,
    );
  }
  return questions;
}
