#!/usr/bin/env node
//
// load_knowher.mjs — validate (and optionally load) the Know Her Game weekly pool document.
//
// The app's Fan Zone "Know Her Game" fetches GET /knowher?teams=…, which serves the pool
// document stored at KV key `knowher-pool-v1` (binding FEED_TAGS), filtered to followed
// teams. This script validates a local pool file against the shared schema (mirrors
// src/knowher.ts validateKnowHerPool + the app's KnowHerGame model) PLUS a set of
// CONTENT-QUALITY lints (below) and writes it to KV.
//
// ⚠️ QUALITY LINTS — added 2026-07 after the first fully-automated round degraded (uniform
// 8-question players, ~80% of True/False answers "True"). The weekly routine's human curator
// used to be the quality gate; now that it's automated, these lints ARE the gate: they fail the
// dry-run so the routine's built-in "regenerate once" self-corrects (a missed week is safe;
// last week's pool stays live). Schema errors + quality FAILs both exit non-zero; softer smells
// print as ⚠️ warnings without failing. Tunable thresholds are the CONSTANTS below.
//
// The admin page (GET /knowher/admin) does the same paste→KV write interactively; this
// script is the file-based / scriptable path.
//
// ⚠️ LEDGER BYPASS — do NOT use this for weekly publishing. This writes KV directly, so it
// SKIPS markFeatured: the pool's players never enter the once-per-season featured ledger and
// /knowher/todo keeps re-picking them (the rotation stalls). Weekly publishing goes through
// POST /knowher/ingest (the automation) or the admin pasteContent op — both run the ONE
// validate→KV→markFeatured path. This script remains for --dry-run VALIDATION (the weekly
// routine uses exactly that) and manual emergency restores.
//
// USAGE:
//   node scripts/load_knowher.mjs [path]            # validate + upload (default: knowher-pool.json)
//   node scripts/load_knowher.mjs [path] --dry-run  # validate + print summary only, no upload
//

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const KV_KEY = "knowher-pool-v1";
const KV_BINDING = "FEED_TAGS";

const CATEGORIES = new Set(["herGame", "herStory", "herWorld", "trueOrFalse"]);
const HUMAN_CATEGORIES = new Set(["herStory", "herWorld", "trueOrFalse"]); // "story/personality" questions
const MIN_QUESTIONS = 10; // the FLOOR (owner intent) — a thin-coverage player fills to 10 with hard stat Qs
const MAX_QUESTIONS = 25; // 10 is the FLOOR, not a cap — rich players can go higher (owner)
// Content-quality thresholds (the automation's replacement for the human curator):
const MAX_STAT_QUESTIONS = 5;   // herGame ≤ 5 per player — the prompt allows 5-human/5-stat at worst
const MIN_HUMAN_QUESTIONS = 5;  // human ≥ 5 per player (fail); < 6 is a warn (the ~6 target)
const TARGET_HUMAN_QUESTIONS = 6;
const TF_MIN_SAMPLE = 6;        // only judge the True/False balance once the pool has this many T/F
const TF_TRUE_MAX_RATIO = 0.65; // > this share of T/F answering "True" ⇒ the banned "obviously-true" pattern

/**
 * Validate a pool document. Pure: returns { errors, warnings } instead of exiting, so the CLI
 * wrapper AND the unit tests share one code path. `errors` non-empty ⇒ do not publish.
 */
export function validatePool(doc) {
  const errors = [];
  const warnings = [];
  const fail = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  // --- Schema (same rules as src/knowher.ts) ---
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    fail("pool must be a JSON object");
    return { errors, warnings };
  }
  if (typeof doc.weekKey !== "string" || !doc.weekKey.trim()) fail("missing/blank weekKey");
  if (!Number.isInteger(doc.season)) fail("season must be an integer year");
  if (!Array.isArray(doc.players) || doc.players.length === 0) {
    fail("players must be a non-empty array");
    return { errors, warnings };
  }

  const teamsSeen = new Set();
  let tfTotal = 0;
  let tfTrue = 0;

  doc.players.forEach((p, i) => {
    const at = `players[${i}] (${p?.playerName ?? "?"})`;
    if (typeof p?.teamAbbreviation !== "string" || !p.teamAbbreviation.trim()) fail(`${at}: missing teamAbbreviation`);
    const abbr = (p?.teamAbbreviation ?? "").toUpperCase();
    if (abbr) {
      if (teamsSeen.has(abbr)) fail(`${at}: duplicate team ${abbr} (one player per team)`);
      teamsSeen.add(abbr);
    }
    if (typeof p?.espnAthleteId !== "string" || !p.espnAthleteId.trim()) fail(`${at}: missing espnAthleteId`);
    if (typeof p?.playerName !== "string" || !p.playerName.trim()) fail(`${at}: missing playerName`);
    if (!Number.isInteger(p?.jerseyNumber) || p.jerseyNumber < 0) fail(`${at}: jerseyNumber must be a non-negative integer`);
    if (typeof p?.position !== "string" || !p.position.trim()) fail(`${at}: missing position`);
    if (typeof p?.tagline !== "string" || !p.tagline.trim()) fail(`${at}: missing tagline`);

    if (!Array.isArray(p?.questions) || p.questions.length < MIN_QUESTIONS || p.questions.length > MAX_QUESTIONS) {
      fail(`${at}: must have ${MIN_QUESTIONS}–${MAX_QUESTIONS} questions (has ${p?.questions?.length ?? 0})`);
      return; // can't lint questions we don't have
    }

    const qids = new Set();
    let human = 0;
    let stat = 0;
    let playerTf = 0;
    let playerTfTrue = 0;

    p.questions.forEach((q, j) => {
      const qat = `${at} question ${j} (id=${q?.id ?? "?"})`;
      if (typeof q?.id !== "string" || !q.id.trim()) fail(`${qat}: missing/blank id`);
      else if (qids.has(q.id)) fail(`${qat}: duplicate question id`);
      else qids.add(q.id);
      if (!CATEGORIES.has(q?.category)) fail(`${qat}: invalid category "${q?.category}"`);
      if (typeof q?.prompt !== "string" || !q.prompt.trim()) fail(`${qat}: missing/blank prompt`);
      const tf = q?.category === "trueOrFalse";
      const wantOpts = tf ? 2 : 4;
      if (!Array.isArray(q?.options) || q.options.length !== wantOpts) fail(`${qat}: ${tf ? "trueOrFalse" : "MC"} needs exactly ${wantOpts} options`);
      else if (q.options.some((o) => typeof o !== "string" || !o.trim())) fail(`${qat}: every option must be a non-blank string`);
      if (!Number.isInteger(q?.correctIndex) || q.correctIndex < 0 || q.correctIndex >= wantOpts) fail(`${qat}: correctIndex must be 0–${wantOpts - 1}`);
      if (q?.revealFact !== undefined && typeof q.revealFact !== "string") fail(`${qat}: revealFact must be a string`);

      // Quality tallies
      if (HUMAN_CATEGORIES.has(q?.category)) human++;
      if (q?.category === "herGame") stat++;
      if (tf) {
        playerTf++;
        tfTotal++;
        if (q?.correctIndex === 0) { playerTfTrue++; tfTrue++; } // index 0 = "True"
      }
    });

    // Per-player content-quality lints (human-first, not a stat sheet)
    if (stat > MAX_STAT_QUESTIONS) fail(`${at}: ${stat} stat (herGame) questions — max ${MAX_STAT_QUESTIONS}; Know Her Game is human-first, not a stat sheet`);
    if (human < MIN_HUMAN_QUESTIONS) fail(`${at}: only ${human} human (story/personality) questions — need ≥ ${MIN_HUMAN_QUESTIONS}`);
    else if (human < TARGET_HUMAN_QUESTIONS) warn(`${at}: ${human} human questions (aim ≥ ${TARGET_HUMAN_QUESTIONS})`);
    if (playerTf >= 3 && playerTfTrue === playerTf) warn(`${at}: all ${playerTf} True/False answers are "True" — vary them (some plausibly FALSE), a lone true fact should be an MC "which has she actually done?"`);
  });

  // Pool-level True/False balance — the banned "hyper-specific claim, obviously True" pattern
  if (tfTotal >= TF_MIN_SAMPLE) {
    const ratio = tfTrue / tfTotal;
    if (ratio > TF_TRUE_MAX_RATIO) {
      fail(`True/False answers are ${Math.round(ratio * 100)}% "True" (${tfTrue}/${tfTotal}) — over ${Math.round(TF_TRUE_MAX_RATIO * 100)}%. That's the banned "obviously-true" pattern; mix in plausibly-FALSE statements or convert lone facts to MC "which has she actually done?"`);
    }
  }

  return { errors, warnings };
}

// --- CLI (only when run directly, so tests can import validatePool without side effects) ---
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((a) => !a.startsWith("--")) ?? "knowher-pool.json";

  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`✗ could not read/parse ${path}: ${e.message}`);
    process.exit(1);
  }

  const { errors, warnings } = validatePool(doc);
  warnings.forEach((w) => console.error(`⚠️  ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.error(`✗ ${e}`));
    process.exit(1);
  }

  const totalQs = doc.players.reduce((n, p) => n + p.questions.length, 0);
  console.log(`✓ ${doc.weekKey} · season ${doc.season} · ${doc.players.length} players, ${totalQs} questions valid`);
  doc.players.forEach((p) => console.log(`    ${p.teamAbbreviation.padEnd(4)} ${p.playerName} — ${p.questions.length} Qs`));

  if (dryRun) {
    console.log("Dry run — not uploading.");
    process.exit(0);
  }

  console.log(`Uploading to KV ${KV_BINDING}/${KV_KEY} (--remote)…`);
  try {
    execFileSync("npx", ["wrangler", "kv", "key", "put", KV_KEY, "--binding", KV_BINDING, "--path", path, "--remote"], { stdio: "inherit" });
  } catch (e) {
    console.error(`✗ wrangler upload failed: ${e.message}`);
    process.exit(1);
  }
  console.log(`✓ Loaded. The /knowher route serves the new pool after its 6h edge cache expires.`);
}
