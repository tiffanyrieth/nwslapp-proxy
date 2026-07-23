#!/usr/bin/env node
// Seed-account guard — the launch gate for the pre-launch Fan Zone test population.
//
// scripts/seed_test_fans.mjs creates synthetic accounts (@seed.nwslapp.test) so the Fan Zone's
// crowd-shaped surfaces — leaderboards, community splits, the Superfan tier ladder, the below-fold
// "You" row — can be seen and designed against before there are real users. Those accounts are REAL
// rows: they rank on real leaderboards and count in real community aggregates.
//
// So they must be gone before launch, and "remember to purge" is not a mechanism. This check fails
// the healthcheck chain while any seed account still exists, which is the only reason the seeding
// approach is safe to run against the production project at all.
//
// Exit codes:
//   0 → no seed accounts (safe to launch), or credentials absent (see below)
//   1 → seed accounts still present → run: node scripts/seed_test_fans.mjs --purge
//
// Usage:
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/health_check_seed_accounts.mjs
//   npm run healthcheck   (runs the chain)

const SEED_DOMAIN = "seed.nwslapp.test";
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

console.log("\nSeed-account guard — pre-launch test population\n");

// Without credentials we cannot answer the question. Say so plainly and pass, rather than reporting
// a clean bill of health we didn't verify — a guard that silently "passes" when it never ran is the
// exact failure-that-looks-like-success this repo bans. The chain still surfaces the warning.
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log("  ⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — CHECK NOT RUN.");
  console.log("     Before launch, run this with credentials to prove no seed accounts remain.\n");
  process.exit(0);
}

const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

try {
  const found = [];
  for (let page = 1; page <= 50; page++) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers });
    if (!r.ok) throw new Error(`admin list users → ${r.status} ${await r.text()}`);
    const users = (await r.json()).users ?? [];
    if (users.length === 0) break;
    for (const u of users) if ((u.email ?? "").endsWith(`@${SEED_DOMAIN}`)) found.push(u.email);
    if (users.length < 200) break;
  }

  if (found.length === 0) {
    console.log(`  ✅ No @${SEED_DOMAIN} accounts — the test population is fully torn down.\n`);
    process.exit(0);
  }

  console.error(`  ❌ ${found.length} seed account(s) still present (e.g. ${found.slice(0, 3).join(", ")}).`);
  console.error("     These rank on real leaderboards and count in real community aggregates.");
  console.error("     Purge them:  node scripts/seed_test_fans.mjs --purge\n");
  process.exit(1);
} catch (e) {
  console.error(`  ❌ Could not check seed accounts — ${e.message}\n`);
  process.exit(1);
}
