#!/usr/bin/env node
//
// load_trivia.mjs — load the Daily Trivia question pool into Cloudflare KV.
//
// The app's Fan Zone Daily Trivia game fetches its questions from the proxy's
// GET /trivia route, which serves the array stored at KV key `trivia-pool-v1`
// (binding FEED_TAGS). This script validates a local pool file against the app's
// `TriviaQuestion` shape and writes it to KV.
//
// USAGE:
//   node scripts/load_trivia.mjs [path]            # validate + upload (default path: trivia-pool.json)
//   node scripts/load_trivia.mjs [path] --dry-run  # validate + print histogram only, no upload
//
// REFRESH: regenerate a vetted batch (e.g. on Claude Max), overwrite the pool
// file, and re-run this script. The live route picks up the new pool after its
// 6h edge cache expires. No app release needed.
//

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const KV_KEY = "trivia-pool-v1";
const KV_BINDING = "FEED_TAGS";
const CATEGORIES = new Set(["leagueHistory", "playerFacts", "venues", "rules", "records", "teamHistory"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const path = args.find((a) => !a.startsWith("--")) ?? "trivia-pool.json";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// --- Read ---
let pool;
try {
  pool = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  fail(`could not read/parse ${path}: ${e.message}`);
}
if (!Array.isArray(pool)) fail(`${path} must be a JSON array of questions`);
if (pool.length === 0) fail(`${path} is empty`);

// --- Validate ---
const ids = new Set();
const byCat = {};
const byDiff = {};
pool.forEach((q, i) => {
  const at = `question ${i} (id=${q?.id ?? "?"})`;
  if (typeof q?.id !== "string" || !q.id.trim()) fail(`${at}: missing/blank id`);
  if (ids.has(q.id)) fail(`${at}: duplicate id`);
  ids.add(q.id);
  if (typeof q.question !== "string" || !q.question.trim()) fail(`${at}: missing/blank question`);
  if (!Array.isArray(q.options) || q.options.length !== 4) fail(`${at}: options must be exactly 4`);
  if (q.options.some((o) => typeof o !== "string" || !o.trim())) fail(`${at}: every option must be a non-blank string`);
  if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) fail(`${at}: correctIndex must be an integer 0–3`);
  if (!CATEGORIES.has(q.category)) fail(`${at}: invalid category "${q.category}"`);
  if (!DIFFICULTIES.has(q.difficulty)) fail(`${at}: invalid difficulty "${q.difficulty}"`);
  byCat[q.category] = (byCat[q.category] || 0) + 1;
  byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1;
});

console.log(`✓ ${pool.length} questions valid (${ids.size} unique ids)`);
console.log(`  by category:   ${JSON.stringify(byCat)}`);
console.log(`  by difficulty: ${JSON.stringify(byDiff)}`);

if (dryRun) {
  console.log("Dry run — not uploading.");
  process.exit(0);
}

// --- Upload to KV (wrangler v4 syntax) ---
console.log(`Uploading to KV ${KV_BINDING}/${KV_KEY} (--remote)…`);
try {
  execFileSync(
    "npx",
    ["wrangler", "kv", "key", "put", KV_KEY, "--binding", KV_BINDING, "--path", path, "--remote"],
    { stdio: "inherit" },
  );
} catch (e) {
  fail(`wrangler upload failed: ${e.message}`);
}
console.log(`✓ Loaded ${pool.length} questions. The /trivia route serves them after its 6h edge cache expires.`);
