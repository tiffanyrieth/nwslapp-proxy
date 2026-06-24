#!/usr/bin/env node
// Account-deletion health check — NO SILENT FAILURES gate (App Store "delete account"
// requirement / GDPR right-to-be-forgotten).
//
// The app's Delete Account button calls POST /account/delete on the Worker, which
// service-role deletes the caller's auth user (cascading every per-user row). If that
// route is undeployed, or the SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secrets are
// missing, the button would fail — and a half-wired delete that LOOKS like it worked is
// exactly the silent failure this gate exists to catch.
//
// Probe: POST /account/delete with NO Authorization header. The handler checks secrets
// BEFORE auth, so the tokenless response distinguishes:
//   • 401  → route deployed AND secrets present (ready)         → PASS
//   • 404  → route not deployed                                  → FAIL
//   • 500  → route deployed but Supabase secrets missing         → FAIL
// We deliberately send no token, so this NEVER deletes anything — it only checks wiring.
//
// Usage:
//   PROXY_BASE=https://…workers.dev node scripts/health_check_account_delete.mjs
//   npm run healthcheck   (runs the chain)

const BASE = (process.env.PROXY_BASE || "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");

console.log(`\nAccount-deletion health check — ${BASE}\n`);

try {
  const r = await fetch(`${BASE}/account/delete`, { method: "POST" });
  if (r.status === 401) {
    console.log("  ✅ Route deployed and Supabase secrets present (tokenless probe → 401).\n");
    process.exit(0);
  }
  if (r.status === 404) {
    console.error("  ❌ /account/delete is NOT deployed (404). The Delete Account button would fail.\n");
    process.exit(1);
  }
  if (r.status === 500) {
    console.error("  ❌ Route deployed but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secret is missing (500).\n");
    process.exit(1);
  }
  console.error(`  ❌ Unexpected status ${r.status} from tokenless probe (expected 401).\n`);
  process.exit(1);
} catch (e) {
  console.error(`  ❌ Probe failed to reach the Worker: ${e.message}\n`);
  process.exit(1);
}
