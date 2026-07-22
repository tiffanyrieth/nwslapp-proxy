#!/usr/bin/env node
// Assemble the week's Know Her Game generation prompt — deterministically, in CODE.
//
// The query wording is DELICATE (the fine-tuned Rodman-WORKING template): assembly must never be
// model judgment, so this script fetches this week's eligible pick for each of the 16 clubs from the
// proxy's /knowher/todo (verified ESPN stats attached), computes the ISO weekKey, and substitutes the
// template's three placeholders (<<WEEK_KEY>>, <<SEASON>>, <<PLAYER_LIST>>). Everything else in the
// printed prompt is byte-identical to scripts/knowher-weekly-TEMPLATE.md (minus the operator comment).
//
// Usage:
//   node scripts/assemble_knowher_prompt.mjs            # prompt → stdout, diagnostics → stderr
//   node scripts/assemble_knowher_prompt.mjs --base https://nwslapp-proxy.tiffany-rieth.workers.dev
//
// Exit codes: 0 = prompt printed (any per-team gaps are WARNED on stderr, the prompt covers the rest);
//             1 = nothing to generate (no team returned a pick — offseason or a hard upstream failure).
//
// Node ≥ 18 (built-in fetch), zero dependencies — runnable by the weekly routine and by hand.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASE = (() => {
  const i = process.argv.indexOf("--base");
  return i > -1 && process.argv[i + 1]
    ? process.argv[i + 1].replace(/\/$/, "")
    : "https://nwslapp-proxy.tiffany-rieth.workers.dev";
})();

// Where the stat sidecar lands (consumed by scripts/inject_stat_questions.mjs). Overridable for tests.
const STATS_PATH = (() => {
  const i = process.argv.indexOf("--stats");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "/tmp/knowher-stats.json";
})();

// The canonical 16 (matches src/index.ts TEAM list + DesignTeamColors in the app).
const CLUBS = [
  ["LA", "Angel City FC"],
  ["BAY", "Bay FC"],
  ["BOS", "Boston Legacy FC"],
  ["CHI", "Chicago Stars FC"],
  ["DEN", "Denver Summit FC"],
  ["GFC", "Gotham FC"],
  ["HOU", "Houston Dash"],
  ["KC", "Kansas City Current"],
  ["NC", "North Carolina Courage"],
  ["ORL", "Orlando Pride"],
  ["POR", "Portland Thorns FC"],
  ["LOU", "Racing Louisville FC"],
  ["SD", "San Diego Wave FC"],
  ["SEA", "Seattle Reign FC"],
  ["UTA", "Utah Royals"],
  ["WAS", "Washington Spirit"],
];

// Position abbreviation → the word the proven prompt format uses ("Forward, #2").
const POSITION_WORD = {
  F: "Forward", CF: "Forward", ST: "Forward", S: "Forward", W: "Forward", RW: "Forward", LW: "Forward", FW: "Forward",
  M: "Midfielder", CM: "Midfielder", DM: "Midfielder", AM: "Midfielder", MF: "Midfielder",
  D: "Defender", CB: "Defender", RB: "Defender", LB: "Defender", WB: "Defender", FB: "Defender",
  G: "Goalkeeper", GK: "Goalkeeper",
};
// Exported so scripts/knowher-stat-questions.mjs classifies keepers off the SAME position map (a second
// copy would drift the moment ESPN adds a position code).
export const isKeeper = (pos) => POSITION_WORD[pos] === "Goalkeeper";

/** ISO-8601 week (Monday-start) as "YYYY-Www" — matches the app's KnowHerGameStore week parsing and
 *  the Mon–Sun window the pool's weekKey stamps. The ISO YEAR can differ from the calendar year at
 *  the boundary (e.g. Dec 29 can be W01 of next year). */
export function isoWeekKey(date = new Date()) {
  // Work in UTC to keep the routine's result independent of where it runs.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // shift to the Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Monotonic count of Mondays since the Unix epoch for `date`'s ISO week — a comparable week ordinal. */
function mondayOrdinal(date) {
  const u = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = u.getUTCDay() || 7; // Mon=1 … Sun=7
  u.setUTCDate(u.getUTCDate() - (day - 1)); // back to this week's Monday
  return Math.round(u.getTime() / (7 * 86_400_000));
}

/** The Monday of regular-season Week 1 — the biweekly cadence anchor (Week 1 = Know Her Game). The 2026
 *  season opened Fri 2026-03-13, so Week 1 is the week of Mon 2026-03-09. COMMITTED here (not an env var)
 *  because the weekly Claude Routine runs this script from a repo checkout and its UI has no env-var field;
 *  the `KHG_SEASON_ANCHOR` env var stays as a test/CI override. ⚠️ Bump this each new season. */
export const SEASON_ANCHOR = "2026-03-09";

/** Biweekly cadence gate. Know Her Game runs on ALTERNATING ISO weeks (Season Weeks 1, 3, 5 …), sharing
 *  the Fan Zone quiz slot with NWSL Trivia (Weeks 2, 4, 6 …) so only one quiz game generates content in a
 *  given week. The anchor = the Monday of regular-season Week 1 (`SEASON_ANCHOR`; env var overrides for
 *  tests). Returns true on a KHG week (even offset from the anchor). FAILS OPEN (weekly, with a loud
 *  warning) when the anchor is unset/invalid, so a misconfig degrades to the old weekly cadence rather
 *  than silently halting the game. Exported for the lock-step test. */
export function isKnowHerWeek(now = new Date(), anchorRaw = process.env.KHG_SEASON_ANCHOR) {
  if (!anchorRaw) {
    console.error("⚠️  KHG_SEASON_ANCHOR unset — generating this week (fail-open to weekly). Set it to the Monday of regular-season Week 1 (e.g. 2026-03-23) for biweekly alternation.");
    return true;
  }
  const anchor = new Date(`${anchorRaw}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime())) {
    console.error(`⚠️  KHG_SEASON_ANCHOR="${anchorRaw}" is not a valid date — generating this week (fail-open).`);
    return true;
  }
  const offset = mondayOrdinal(now) - mondayOrdinal(anchor);
  return offset >= 0 && offset % 2 === 0; // Week 1 (offset 0) = KHG; odd offsets = NWSL Trivia weeks
}

/** One player block in the proven Rodman format:
 *  "- Name — Club (ABBR) — Position, #N — age A, Country — espnAthleteId X"
 *  "  YYYY season: … stats …" (keeper picks get a keeper stat line; absent bio fragments are dropped,
 *  never fabricated). */
function playerBlock(clubName, abbr, season, p) {
  const position = POSITION_WORD[p.position] ?? p.position ?? "Player";
  const head = [
    `${p.name} — ${clubName} (${abbr})`,
    p.jersey != null ? `${position}, #${p.jersey}` : position,
    [p.age != null ? `age ${p.age}` : null, p.country].filter(Boolean).join(", ") || null,
    `espnAthleteId ${p.athleteId}`,
  ].filter(Boolean).join(" — ");

  // Coerce every stat through Number(x ?? 0): a proxy that predates a field (or an ESPN gap) must
  // yield a truthful 0, never the string "undefined" inside the delicate prompt.
  const n = (v) => Number(v ?? 0);
  const stats = isKeeper(p.position)
    ? [
        `${n(p.starts)} starts`, `${n(p.minutes)} minutes`, `${n(p.appearances)} appearances`,
        `${n(p.cleanSheets)} clean sheets`, `${n(p.saves)} saves`,
      ]
    : [
        `${n(p.starts)} starts`, `${n(p.minutes)} minutes`, `${n(p.appearances)} appearances`,
        `${n(p.goals)} goal${n(p.goals) === 1 ? "" : "s"}`, `${n(p.assists)} assist${n(p.assists) === 1 ? "" : "s"}`,
        ...(n(p.shots) > 0 ? [`${n(p.shots)} shots (${n(p.shotsOnTarget)} on target)`] : []),
      ];

  return `- ${head}\n  ${season} season: ${stats.join(", ")}`;
}

async function fetchPick(abbr) {
  const res = await fetch(`${BASE}/knowher/todo?team=${abbr}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { team, year, season, player|null }
}

// Run the assembly ONLY when invoked as the entry script — test/knowher.test.ts imports this module
// for its isoWeekKey export, and an import must never fire 16 live fetches as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

async function main() {
// Biweekly cadence: on a NWSL Trivia week, emit no prompt and exit cleanly — the routine no-ops and the
// current 2-week KHG pool stays live. Checked BEFORE fetching 16 teams (no work on an off week). Anchor =
// env override ?? the committed SEASON_ANCHOR (the routine has no env-var UI, so the constant is the source).
if (!isKnowHerWeek(new Date(), process.env.KHG_SEASON_ANCHOR ?? SEASON_ANCHOR)) {
  console.error("⏸  Not a Know Her Game week (NWSL Trivia's turn in the quiz slot) — no prompt emitted; the current 2-week pool stays live.");
  process.exit(0);
}
const template = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "knowher-weekly-TEMPLATE.md"),
  "utf8",
).replace(/^<!--[\s\S]*?-->\s*/, ""); // strip the operator comment — the model sees only the query

const blocks = [];
const gaps = [];
const statsByAthleteId = {};
let season = null;

for (const [abbr, clubName] of CLUBS) {
  try {
    const { year, player } = await fetchPick(abbr);
    season ??= year;
    if (player) {
      blocks.push(playerBlock(clubName, abbr, year, player));
      // Sidecar for the stat-question injector: the SAME verified numbers the prompt shows, keyed by
      // athlete id so the merge can't mis-attach a player's stats. Written here because this is the only
      // place the /knowher/todo payload exists — the model never echoes stats back.
      statsByAthleteId[String(player.athleteId)] = { ...player, teamAbbr: abbr, season: year };
    } else {
      gaps.push(`${abbr}: no eligible pick (roster exhausted for the season, or upstream empty)`);
    }
  } catch (e) {
    gaps.push(`${abbr}: /knowher/todo failed — ${e.message}`);
  }
}

for (const g of gaps) console.error(`⚠️  GAP — ${g}`);

if (blocks.length === 0) {
  console.error("❌ No team returned a pick — nothing to generate (offseason, or the proxy/ESPN is down). No prompt emitted.");
  process.exit(1);
}
if (gaps.length > 0) {
  console.error(`⚠️  Assembling with ${blocks.length}/16 teams — the missing teams keep last week's player in the app.`);
}

// Write the sidecar BEFORE the prompt: if the disk write fails, fail here rather than after the routine
// has already spent a night generating against a prompt whose stat questions can never be injected.
try {
  writeFileSync(STATS_PATH, JSON.stringify(statsByAthleteId, null, 2));
} catch (e) {
  console.error(`❌ Could not write the stat sidecar to ${STATS_PATH} — ${e.message}. The stat questions are injected from this file, so generation would produce an incomplete pool. No prompt emitted.`);
  process.exit(1);
}
console.error(`📊 Wrote stats for ${Object.keys(statsByAthleteId).length} players to ${STATS_PATH} (stat questions are generated in code, not by the model).`);

const weekKey = isoWeekKey();
process.stdout.write(
  template
    .replaceAll("<<WEEK_KEY>>", weekKey)
    .replaceAll("<<SEASON>>", String(season ?? new Date().getUTCFullYear()))
    .replace("<<PLAYER_LIST>>", blocks.join("\n")),
);
console.error(`✅ Assembled ${blocks.length}-player prompt for ${weekKey} (season ${season}).`);
}
