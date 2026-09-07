#!/usr/bin/env node
// Merge the FUN routine's fun-only pool INTO the staged BIO partial — deterministically, in CODE (never model
// judgment). The 2026-09-07 3-routine split runs the bio pass then the fun pass as ISOLATED generators; this
// joins their output per player so neither routine ever has to re-emit the other's questions (which keeps each
// routine's output-token budget low and its context on one job). For each player:
//     combined.questions = bioPartial.questions ++ funOnly.questions   (matched by espnAthleteId)
// The result is the COMBINED human pool the fun routine stages at /knowher/candidate for the verify gate.
//
// Usage:
//   node scripts/merge_knowher_fun.mjs --bio /tmp/knowher-bio.json --fun /tmp/knowher-fun.json \
//        --out /tmp/knowher-pool.json
//
// Exit 0 = merged (per-player bio+fun counts on stderr). Exit 1 = a structural problem that must fail LOUD:
//   a missing file, a weekKey mismatch (bio and fun editions differ), or a fun player with no bio match
//   (roster drift — her facts would be silently dropped). No dependencies, Node ≥ 18.

import { readFileSync, writeFileSync } from "node:fs";

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const BIO = arg("--bio");
const FUN = arg("--fun");
const OUT = arg("--out", "/tmp/knowher-pool.json");
if (!BIO || !FUN) {
  console.error("❌ usage: node scripts/merge_knowher_fun.mjs --bio <bio partial> --fun <fun-only pool> [--out <combined>]");
  process.exit(1);
}

let bio, fun;
try { bio = JSON.parse(readFileSync(BIO, "utf8")); }
catch (e) { console.error(`❌ Could not read/parse the bio partial ${BIO} — ${e.message}`); process.exit(1); }
try { fun = JSON.parse(readFileSync(FUN, "utf8")); }
catch (e) { console.error(`❌ Could not read/parse the fun pool ${FUN} — ${e.message}`); process.exit(1); }

// Refuse to merge two different editions — a mismatch means the fun pass ran against the wrong bio partial.
if (bio.weekKey && fun.weekKey && bio.weekKey !== fun.weekKey) {
  console.error(`❌ weekKey mismatch: bio "${bio.weekKey}" vs fun "${fun.weekKey}" — refusing to merge mismatched editions.`);
  process.exit(1);
}

// Match on the stable athlete id; fall back to the team abbreviation only if an id is somehow blank.
const key = (p) => String(p.espnAthleteId ?? "").trim() || `team:${String(p.teamAbbreviation ?? "").toUpperCase()}`;
const funByKey = new Map((Array.isArray(fun.players) ? fun.players : []).map((p) => [key(p), p]));

const bioPlayers = Array.isArray(bio.players) ? bio.players : [];
if (bioPlayers.length === 0) {
  console.error(`❌ The bio partial ${BIO} has no players — nothing to merge onto.`);
  process.exit(1);
}

const players = bioPlayers.map((bp) => {
  const fp = funByKey.get(key(bp));
  const funQs = Array.isArray(fp?.questions) ? fp.questions : [];
  funByKey.delete(key(bp));
  return { ...bp, questions: [...(Array.isArray(bp.questions) ? bp.questions : []), ...funQs] };
});

// A fun player with no bio match is roster drift — her fun facts would vanish. Fail loud rather than drop them.
if (funByKey.size > 0) {
  console.error(`❌ ${funByKey.size} fun player(s) had no matching bio player: ${[...funByKey.keys()].join(", ")}. Roster drift — not merged.`);
  process.exit(1);
}

const combined = { weekKey: bio.weekKey, season: bio.season, players };
try {
  writeFileSync(OUT, JSON.stringify(combined, null, 2));
} catch (e) {
  console.error(`❌ Could not write the combined pool to ${OUT} — ${e.message}`);
  process.exit(1);
}

for (const p of players) {
  const bioN = (bioPlayers.find((b) => key(b) === key(p))?.questions ?? []).length;
  console.error(`  ${p.teamAbbreviation}: ${bioN} bio + ${p.questions.length - bioN} fun = ${p.questions.length}`);
}
console.error(`✅ Merged ${players.length} players → ${OUT} (weekKey ${combined.weekKey}, season ${combined.season}).`);
