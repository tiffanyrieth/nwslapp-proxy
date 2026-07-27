#!/usr/bin/env node
//
// backfill_knowher_ledger.mjs — record an already-published Know Her Game pool in the
// once-per-season featured ledger (KV `knowher:featured:{season}`, binding FEED_TAGS).
//
// WHY THIS EXISTS: the ledger is written only by markFeatured(), which runs on the ONE publish
// path (POST /knowher/ingest, or the admin pasteContent op). A pool loaded with
// load_knowher.mjs goes straight to KV and skips that step, so its players never become
// ineligible and /knowher/todo keeps re-picking them. That happened to the 2026-W27 test
// edition: Trinity Rodman (317423) was featured in W27, stayed off the ledger, and was picked
// again in 2026-W31. This script repairs that class of gap after the fact.
//
// It is a REPAIR TOOL, not a publishing path — it only touches the ledger, never the live pool
// (`knowher-pool-v1`). To publish content, use POST /knowher/ingest or the admin page.
//
// Semantics deliberately mirror markFeatured() in src/knowher.ts:
//   - idempotent: an athleteId already on the ledger is left alone (first weekKey wins), so
//     re-running is harmless and a player's original edition is never rewritten
//   - entries are { athleteId, teamAbbr, weekKey }; the doc is { season, featured: [...] }
// Season and weekKey come from the pool file itself unless overridden.
//
// ⚠️ Adding an entry makes that player INELIGIBLE for the rest of the season. To undo, use the
// admin `unfeature` op (POST /knowher/admin/api) — it removes one athleteId from the ledger.
//
// USAGE:
//   node scripts/backfill_knowher_ledger.mjs [poolPath] --dry-run   # preview the diff, no write
//   node scripts/backfill_knowher_ledger.mjs [poolPath]             # merge + write to KV
//   node scripts/backfill_knowher_ledger.mjs pool.json --week 2026-W27 --season 2026
//                                                                   # override the stamps
// Default poolPath: knowher-pool.json
//
// Requires wrangler auth (same as load_knowher.mjs). Reads/writes the REMOTE namespace.

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KV_BINDING = "FEED_TAGS";
const FEATURED_PREFIX = "knowher:featured:"; // + season — mirrors KNOWHER_FEATURED_PREFIX

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const poolPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--week" && args[i - 1] !== "--season") ?? "knowher-pool.json";

// --- Read the pool ------------------------------------------------------------
let pool;
try {
  pool = JSON.parse(readFileSync(poolPath, "utf8"));
} catch (e) {
  console.error(`✗ could not read/parse ${poolPath}: ${e.message}`);
  process.exit(1);
}

const season = Number(flagValue("--season") ?? pool.season);
const weekKey = String(flagValue("--week") ?? pool.weekKey ?? "").trim();
if (!Number.isInteger(season) || season < 2000) {
  console.error(`✗ bad season "${season}" — pass --season 2026 if the pool file doesn't carry one`);
  process.exit(1);
}
if (!weekKey) {
  console.error(`✗ bad weekKey — pass --week 2026-W27 if the pool file doesn't carry one`);
  process.exit(1);
}
if (!Array.isArray(pool.players) || pool.players.length === 0) {
  console.error(`✗ ${poolPath} has no players[]`);
  process.exit(1);
}

// Pool players use espnAthleteId/teamAbbreviation; ledger entries use athleteId/teamAbbr.
const incoming = [];
for (const [i, p] of pool.players.entries()) {
  const athleteId = String(p?.espnAthleteId ?? "").trim();
  const teamAbbr = String(p?.teamAbbreviation ?? "").trim().toUpperCase();
  if (!athleteId) {
    console.error(`✗ player ${i} (${p?.playerName ?? "?"}) has no espnAthleteId — cannot backfill a pool with unidentified players`);
    process.exit(1);
  }
  incoming.push({ athleteId, teamAbbr, weekKey, playerName: p?.playerName ?? "" });
}

const KEY = `${FEATURED_PREFIX}${season}`;

// --- Read the existing ledger -------------------------------------------------
// A missing key is normal (first edition of a season) — wrangler exits non-zero, so treat any
// read failure as "empty" but say so out loud rather than silently starting fresh.
let ledger = { season, featured: [] };
let existed = false;
try {
  const raw = execFileSync("npx", ["wrangler", "kv", "key", "get", KEY, "--binding", KV_BINDING, "--remote"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.featured)) throw new Error("ledger JSON has no featured[] array");
  ledger = { season: parsed.season ?? season, featured: parsed.featured };
  existed = true;
} catch (e) {
  console.error(`⚠️  could not read ${KEY} (${String(e.message).split("\n")[0]})`);
  console.error(`   Treating it as an EMPTY ledger. If that's wrong, stop now — writing would erase it.`);
  if (!dryRun) {
    console.error(`   Re-run with --dry-run first, or verify with:`);
    console.error(`     npx wrangler kv key get "${KEY}" --binding ${KV_BINDING} --remote`);
    process.exit(1);
  }
}

// --- Merge (idempotent, first weekKey wins) -----------------------------------
const seen = new Map(ledger.featured.map((f) => [String(f.athleteId), f]));
const added = [];
const skipped = [];
for (const entry of incoming) {
  const prior = seen.get(entry.athleteId);
  if (prior) {
    skipped.push({ ...entry, priorWeek: prior.weekKey });
    continue;
  }
  const { playerName, ...record } = entry; // playerName is for the console only, not the ledger
  ledger.featured.push(record);
  seen.set(entry.athleteId, record);
  added.push(entry);
}

// --- Report -------------------------------------------------------------------
console.log(`\nLedger backfill — ${KEY} (${existed ? "existing" : "NEW"}) from ${poolPath} [${weekKey}]\n`);
for (const a of added) console.log(`  + ${a.teamAbbr.padEnd(4)} ${a.playerName.padEnd(24)} id=${a.athleteId}`);
for (const s of skipped) console.log(`  · ${s.teamAbbr.padEnd(4)} ${s.playerName.padEnd(24)} id=${s.athleteId} — already on the ledger (${s.priorWeek}), left as-is`);
console.log(`\n  ${added.length} added, ${skipped.length} already present → ledger size ${ledger.featured.length}`);
console.log(`  distinct editions on the ledger: ${new Set(ledger.featured.map((f) => f.weekKey)).size} (this is the picker's "Round N")\n`);

if (added.length === 0) {
  console.log("Nothing to add — ledger already covers this pool. No write.\n");
  process.exit(0);
}
if (dryRun) {
  console.log("Dry run — not writing.\n");
  process.exit(0);
}

// --- Write --------------------------------------------------------------------
const tmp = join(tmpdir(), `knowher-featured-${season}-${Date.now()}.json`);
try {
  writeFileSync(tmp, JSON.stringify(ledger));
  execFileSync("npx", ["wrangler", "kv", "key", "put", KEY, "--binding", KV_BINDING, "--path", tmp, "--remote"], { stdio: "inherit" });
} catch (e) {
  console.error(`✗ wrangler write failed: ${e.message}`);
  process.exit(1);
} finally {
  try { unlinkSync(tmp); } catch { /* best effort */ }
}
console.log(`\n✓ Ledger updated — those ${added.length} player(s) are now ineligible for the rest of season ${season}.`);
console.log(`  Verify: npx wrangler kv key get "${KEY}" --binding ${KV_BINDING} --remote\n`);
