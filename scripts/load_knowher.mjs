#!/usr/bin/env node
//
// load_knowher.mjs — load the Know Her Game weekly pool document into Cloudflare KV.
//
// The app's Fan Zone "Know Her Game" fetches GET /knowher?teams=…, which serves the pool
// document stored at KV key `knowher-pool-v1` (binding FEED_TAGS), filtered to followed
// teams. This script validates a local pool file against the shared schema (mirrors
// src/knowher.ts validateKnowHerPool + the app's KnowHerGame model) and writes it to KV.
//
// The admin page (GET /knowher/admin) does the same paste→KV write interactively; this
// script is the file-based / scriptable path (and what the deferred auto generator emulates).
//
// USAGE:
//   node scripts/load_knowher.mjs [path]            # validate + upload (default: knowher-pool.json)
//   node scripts/load_knowher.mjs [path] --dry-run  # validate + print summary only, no upload
//

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const KV_KEY = "knowher-pool-v1";
const KV_BINDING = "FEED_TAGS";
const CATEGORIES = new Set(["herGame", "herStory", "herWorld", "trueOrFalse"]);
const MIN_QUESTIONS = 8;
const MAX_QUESTIONS = 25; // 10 is the FLOOR, not a cap — rich players can go higher (owner)

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const path = args.find((a) => !a.startsWith("--")) ?? "knowher-pool.json";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// --- Read ---
let doc;
try {
  doc = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  fail(`could not read/parse ${path}: ${e.message}`);
}

// --- Validate (same rules as src/knowher.ts) ---
if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail("pool must be a JSON object");
if (typeof doc.weekKey !== "string" || !doc.weekKey.trim()) fail("missing/blank weekKey");
if (!Number.isInteger(doc.season)) fail("season must be an integer year");
if (!Array.isArray(doc.players) || doc.players.length === 0) fail("players must be a non-empty array");

const teamsSeen = new Set();
doc.players.forEach((p, i) => {
  const at = `players[${i}] (${p?.playerName ?? "?"})`;
  if (typeof p?.teamAbbreviation !== "string" || !p.teamAbbreviation.trim()) fail(`${at}: missing teamAbbreviation`);
  const abbr = p.teamAbbreviation.toUpperCase();
  if (teamsSeen.has(abbr)) fail(`${at}: duplicate team ${abbr} (one player per team)`);
  teamsSeen.add(abbr);
  if (typeof p.espnAthleteId !== "string" || !p.espnAthleteId.trim()) fail(`${at}: missing espnAthleteId`);
  if (typeof p.playerName !== "string" || !p.playerName.trim()) fail(`${at}: missing playerName`);
  if (!Number.isInteger(p.jerseyNumber) || p.jerseyNumber < 0) fail(`${at}: jerseyNumber must be a non-negative integer`);
  if (typeof p.position !== "string" || !p.position.trim()) fail(`${at}: missing position`);
  if (typeof p.tagline !== "string" || !p.tagline.trim()) fail(`${at}: missing tagline`);
  if (!Array.isArray(p.questions) || p.questions.length < MIN_QUESTIONS || p.questions.length > MAX_QUESTIONS) {
    fail(`${at}: must have ${MIN_QUESTIONS}–${MAX_QUESTIONS} questions (has ${p.questions?.length ?? 0})`);
  }
  const qids = new Set();
  p.questions.forEach((q, j) => {
    const qat = `${at} question ${j} (id=${q?.id ?? "?"})`;
    if (typeof q?.id !== "string" || !q.id.trim()) fail(`${qat}: missing/blank id`);
    if (qids.has(q.id)) fail(`${qat}: duplicate question id`);
    qids.add(q.id);
    if (!CATEGORIES.has(q.category)) fail(`${qat}: invalid category "${q.category}"`);
    if (typeof q.prompt !== "string" || !q.prompt.trim()) fail(`${qat}: missing/blank prompt`);
    const tf = q.category === "trueOrFalse";
    const wantOpts = tf ? 2 : 4;
    if (!Array.isArray(q.options) || q.options.length !== wantOpts) fail(`${qat}: ${tf ? "trueOrFalse" : "MC"} needs exactly ${wantOpts} options`);
    if (q.options.some((o) => typeof o !== "string" || !o.trim())) fail(`${qat}: every option must be a non-blank string`);
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= wantOpts) fail(`${qat}: correctIndex must be 0–${wantOpts - 1}`);
    if (q.revealFact !== undefined && typeof q.revealFact !== "string") fail(`${qat}: revealFact must be a string`);
  });
});

const totalQs = doc.players.reduce((n, p) => n + p.questions.length, 0);
console.log(`✓ ${doc.weekKey} · season ${doc.season} · ${doc.players.length} players, ${totalQs} questions valid`);
doc.players.forEach((p) => console.log(`    ${p.teamAbbreviation.padEnd(4)} ${p.playerName} — ${p.questions.length} Qs`));

if (dryRun) {
  console.log("Dry run — not uploading.");
  process.exit(0);
}

// --- Upload to KV (wrangler v4 syntax) ---
console.log(`Uploading to KV ${KV_BINDING}/${KV_KEY} (--remote)…`);
try {
  execFileSync("npx", ["wrangler", "kv", "key", "put", KV_KEY, "--binding", KV_BINDING, "--path", path, "--remote"], { stdio: "inherit" });
} catch (e) {
  fail(`wrangler upload failed: ${e.message}`);
}
console.log(`✓ Loaded. The /knowher route serves the new pool after its 6h edge cache expires.`);
