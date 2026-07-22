#!/usr/bin/env node
// Merge the code-generated STAT questions into the routine's human-only pool.
//
// Pipeline position (scripts/knowher-weekly-routine.md):
//   1. assemble_knowher_prompt.mjs  → the human-only prompt + /tmp/knowher-stats.json (the sidecar)
//   2. the model                    → /tmp/knowher-pool.json with ~8–9 HUMAN questions per player
//   3. THIS SCRIPT                  → appends 2 `herGame` questions per player, in place
//   4. load_knowher.mjs --dry-run   → validates the COMPLETE pool (≥10 Qs, ≥6 human, ≤5 stat, T/F balance)
//
// Running BEFORE validation is the point: if the model under-delivers on human questions, the merged pool
// lands under the 10-question floor and the dry-run stops the routine — no thin pool ever publishes.
//
// Usage:
//   node scripts/inject_stat_questions.mjs [pool.json] [stats.json]     # defaults to the /tmp pair
//
// Exit codes: 0 = pool rewritten with stat questions; 1 = nothing written (see stderr). Fails LOUD on a
// missing sidecar, an unmatched athlete id, or a duplicate question id — a half-merged pool is worse than
// a skipped week, because last week's content stays live either way.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildStatQuestions } from "./knowher-stat-questions.mjs";

/**
 * Weave the 2 stat questions INTO the human run at roughly the one-third and two-thirds marks, rather than
 * appending them.
 *
 * The app plays a player's questions in pool order (NWSLApp KnowHerGameViewModel — no shuffle), and the
 * prompt's long-standing flow rule is that the dry questions must never be dumped at the end. Appending
 * would end every quiz on two stat questions — its weakest possible finish. Splitting the human run in
 * three puts a stat question at each seam and keeps the LAST question human.
 */
function weave(human, stat) {
  const h = human.length;
  const a = Math.max(1, Math.round(h / 3));
  const b = Math.min(Math.max(a + 1, Math.round((2 * h) / 3)), Math.max(a + 1, h - 1));
  return [...human.slice(0, a), stat[0], ...human.slice(a, b), stat[1], ...human.slice(b)];
}

/**
 * Merge the stat questions into every player in `pool`, in place. Pure apart from the mutation — no I/O —
 * so the merge rules are unit-testable.
 * @returns {{injected: number, players: number}}
 * @throws on a missing stats entry or a duplicate question id
 */
export function injectStatQuestions(pool, statsByAthleteId) {
  if (!pool || !Array.isArray(pool.players) || pool.players.length === 0) {
    throw new Error("pool has no players array — the model wrote something other than the pool document");
  }

  let injected = 0;
  for (const player of pool.players) {
    const abbr = String(player?.teamAbbreviation ?? "").trim();
    const id = String(player?.espnAthleteId ?? "").trim();
    const label = `${abbr || "?"} (${player?.playerName ?? "?"})`;
    if (!id) throw new Error(`${label}: missing espnAthleteId — can't match it to verified stats`);

    const stats = statsByAthleteId[id];
    if (!stats) {
      throw new Error(
        `${label}: espnAthleteId ${id} is not in the stats sidecar. Either the model invented/renamed a ` +
          `player, or the pool was generated against a different week's prompt. Regenerate — do not publish.`,
      );
    }

    const questions = buildStatQuestions(abbr, stats);
    const existing = new Set((player.questions ?? []).map((q) => q?.id));
    for (const q of questions) {
      if (existing.has(q.id)) {
        throw new Error(`${label}: duplicate question id "${q.id}" — the model already used a reserved stat id`);
      }
      existing.add(q.id);
    }

    player.questions = weave(player.questions ?? [], questions);
    injected += questions.length;
  }
  return { injected, players: pool.players.length };
}

function main() {
  const poolPath = process.argv[2] ?? "/tmp/knowher-pool.json";
  const statsPath = process.argv[3] ?? "/tmp/knowher-stats.json";

  let pool;
  let stats;
  try {
    pool = JSON.parse(readFileSync(poolPath, "utf8"));
  } catch (e) {
    console.error(`❌ Could not read/parse the pool at ${poolPath} — ${e.message}`);
    process.exit(1);
  }
  try {
    stats = JSON.parse(readFileSync(statsPath, "utf8"));
  } catch (e) {
    console.error(`❌ Could not read/parse the stats sidecar at ${statsPath} — ${e.message}. It is written by scripts/assemble_knowher_prompt.mjs in step 1; re-run that step in the same session.`);
    process.exit(1);
  }

  let result;
  try {
    result = injectStatQuestions(pool, stats);
  } catch (e) {
    console.error(`❌ Stat-question injection failed — ${e.message}`);
    console.error("   Nothing written. Do NOT publish a human-only pool; last edition's content stays live.");
    process.exit(1);
  }

  try {
    writeFileSync(poolPath, JSON.stringify(pool, null, 2));
  } catch (e) {
    console.error(`❌ Could not write the merged pool back to ${poolPath} — ${e.message}`);
    process.exit(1);
  }

  console.error(`✅ Injected ${result.injected} stat questions across ${result.players} players → ${poolPath}`);
  for (const p of pool.players) {
    const stat = p.questions.filter((q) => q.category === "herGame").length;
    console.error(`   ${String(p.teamAbbreviation).padEnd(4)} ${p.playerName} — ${p.questions.length} Qs (${p.questions.length - stat} human + ${stat} stat)`);
  }
}

// Entry-script guard (same pattern as assemble_knowher_prompt.mjs) — the tests import injectStatQuestions
// and must not trigger a file read/write as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
