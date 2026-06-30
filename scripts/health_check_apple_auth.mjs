#!/usr/bin/env node
// Sign in with Apple token-exchange health check — NO SILENT FAILURES gate (App Store
// guideline 5.1.1(v): revoke the SIWA credential on account deletion).
//
// At sign-in the app POSTs Apple's authorizationCode to /auth/apple-token-exchange, which
// exchanges it for a refresh_token (stored on profiles) so account deletion can later
// revoke. If that route is undeployed, or the SIWA_* / SUPABASE_* secrets are missing, no
// token is ever stored — and revocation silently never happens. This gate catches that.
//
// Probe: POST /auth/apple-token-exchange with NO Authorization header. The handler checks
// secrets BEFORE auth, so the tokenless response distinguishes:
//   • 401  → route deployed AND all secrets present (ready)              → PASS
//   • 404  → route not deployed                                          → FAIL
//   • 500  → route deployed but SIWA_* / SUPABASE_* secret is missing     → FAIL
// We send no token, so this NEVER exchanges or stores anything — it only checks wiring.
//
// Usage:
//   PROXY_BASE=https://…workers.dev node scripts/health_check_apple_auth.mjs
//   npm run healthcheck   (runs the chain)

const BASE = (process.env.PROXY_BASE || "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");

console.log(`\nSIWA token-exchange health check — ${BASE}\n`);

try {
  const r = await fetch(`${BASE}/auth/apple-token-exchange`, { method: "POST" });
  if (r.status === 401) {
    console.log("  ✅ Route deployed and SIWA + Supabase secrets present (tokenless probe → 401).\n");
    process.exit(0);
  }
  if (r.status === 404) {
    console.error("  ❌ /auth/apple-token-exchange is NOT deployed (404). SIWA tokens would never be stored.\n");
    process.exit(1);
  }
  if (r.status === 500) {
    console.error("  ❌ Route deployed but a SIWA_* / SUPABASE_* secret is missing (500).\n");
    process.exit(1);
  }
  console.error(`  ❌ Unexpected status ${r.status} from tokenless probe (expected 401).\n`);
  process.exit(1);
} catch (e) {
  console.error(`  ❌ Probe failed to reach the Worker: ${e.message}\n`);
  process.exit(1);
}
