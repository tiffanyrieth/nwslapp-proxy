// Shared operator-admin auth — used by every per-game admin surface (Bracket Battle,
// Know Her Game, and future unified /admin tabs). Extracted from bracket-engine so a
// single implementation gates them all.
//
// A GET page navigation authenticates via HTTP Basic (the browser's native password
// prompt — username ignored, password = the key), so once the browser has the credential
// it auto-attaches the same Authorization header to the page's same-origin fetch() calls.
// The `x-admin-key` header is also accepted so curl/scripts work unchanged.
//
// ── 2026-08-24 hardening (Part B — owner MSP-grade bar) ─────────────────────────────────────────
// Three additions, all fail-open when unconfigured so they deploy independently:
//   1. CONSTANT-TIME key compares (a `===` on a secret is a timing side-channel).
//   2. Per-IP throttle on FAILED auth attempts (`ADMIN_LIMITER`, 10/60s) — a brute-forcer gets ten
//      guesses a minute then 429s; AUTHENTICATED requests never touch the limiter, so the Status
//      tab's parallel section fetches can never rate-limit the owner.
//   3. Cloudflare Access JWT verification (`verifyAccessJwt`) — defense-in-depth behind the Zero
//      Trust Access app on the human portal paths. UNARMED until BOTH `ACCESS_TEAM_DOMAIN` +
//      `ACCESS_AUD` are set, so this ships before the dashboard app exists without locking anyone
//      out. Once armed, portal requests must carry a valid `Cf-Access-Jwt-Assertion` (RS256 against
//      the team's JWKS, iss/aud/exp checked) IN ADDITION to the key — a leaked password alone no
//      longer opens the portal, and a misconfigured/disabled Access app fails CLOSED here.
// Machine lanes (KHG/Trivia ingest, adjudication, audits, the watcher's service binding) use their
// own scoped keys on non-portal paths and are untouched by all of this.

/** The env slice this module reads — matches the house per-module cast pattern. */
export interface AdminAuthEnv {
  BRACKET_ADMIN_KEY?: string;
  ADMIN_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  ACCESS_TEAM_DOMAIN?: string; // e.g. "example.cloudflareaccess.com" — arms the JWT check
  ACCESS_AUD?: string;         // the Access application's audience (aud) tag — arms the JWT check
}

/** Constant-time string equality (JS best-effort: single pass, bitwise accumulate — no early
 *  exit on the first differing byte). Length inequality returns false immediately; leaking the
 *  LENGTH of a high-entropy key is acceptable, leaking a matched PREFIX is not. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** True when the request carries the admin key — either as HTTP Basic auth (password = key,
 *  username ignored) or the `x-admin-key` header. False if no key is configured. */
export function adminAuthed(request: Request, key: string | undefined): boolean {
  if (!key) return false;
  const headerKey = request.headers.get("x-admin-key");
  if (headerKey !== null && safeEqual(headerKey, key)) return true;
  const m = /^Basic\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!m) return false;
  let decoded = "";
  try {
    decoded = atob(m[1].trim());
  } catch {
    return false;
  }
  return safeEqual(decoded.slice(decoded.indexOf(":") + 1), key); // "user:pass" → compare pass
}

/** WWW-Authenticate value for a given realm — a 401 with this triggers the browser's
 *  native password dialog (and re-prompts on a stale credential). */
export function adminRealm(realm: string): string {
  return `Basic realm="${realm}", charset="UTF-8"`;
}

// ── Cloudflare Access JWT (defense-in-depth behind the Zero Trust app) ──────────────────────────

const ACCESS_CERTS_TTL_S = 3600; // JWKS re-fetch cadence (Access rotates keys infrequently)

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Pure claims validation, split out for unit tests. `now` in SECONDS. */
export function validateAccessClaims(
  payload: { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown },
  teamDomain: string,
  aud: string,
  now: number,
): string | null {
  if (payload.iss !== `https://${teamDomain}`) return "bad iss";
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return "bad aud";
  if (typeof payload.exp !== "number" || payload.exp < now) return "expired";
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return "not yet valid";
  return null;
}

/** Verify a JWT against a JWKS key set (RS256 — what Access issues). Split from the fetch so
 *  tests can inject generated keys. Returns null on success, else a short reject reason. */
export async function verifyJwtWithKeys(
  token: string,
  keys: Array<JsonWebKey & { kid?: string }>,
  teamDomain: string,
  aud: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed";
  let header: { kid?: string; alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as typeof header;
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as typeof payload;
  } catch {
    return "undecodable";
  }
  if (header.alg !== "RS256") return "bad alg"; // Access signs RS256; never accept e.g. "none"
  const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) return "unknown kid";
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch {
    return "bad jwk";
  }
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = b64urlToBytes(parts[2]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sig as BufferSource, data);
  if (!ok) return "bad signature";
  return validateAccessClaims(payload, teamDomain, aud, nowSec);
}

/** Fetch the Access team's JWKS, edge-cached for an hour (Cache API — no KV writes). */
async function fetchAccessKeys(teamDomain: string): Promise<Array<JsonWebKey & { kid?: string }>> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const doc = (await hit.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    if (Array.isArray(doc.keys)) return doc.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`certs fetch ${res.status}`);
  const body = await res.text();
  const doc = JSON.parse(body) as { keys?: Array<JsonWebKey & { kid?: string }> };
  if (!Array.isArray(doc.keys)) throw new Error("certs: no keys");
  const cached = new Response(body, {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ACCESS_CERTS_TTL_S}` },
  });
  await cache.put(cacheKey, cached);
  return doc.keys;
}

/** Cloudflare Access JWT check. UNARMED (both env vars unset) → "pass". Armed → the request must
 *  carry a valid `Cf-Access-Jwt-Assertion` header (Access attaches it after login). Returns null
 *  on pass, else a short reject reason for the diag. */
export async function verifyAccessJwt(request: Request, env: AdminAuthEnv): Promise<string | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!team || !aud) return null; // not armed yet — key-only auth stands (ships before the dashboard app)
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return "no Access JWT (request did not come through the Access app)";
  let keys: Array<JsonWebKey & { kid?: string }>;
  try {
    keys = await fetchAccessKeys(team);
  } catch (e) {
    // Fail CLOSED but say why: with Access armed, an unverifiable JWT must not open the portal.
    return `certs unavailable (${(e as Error).message})`;
  }
  return verifyJwtWithKeys(token, keys, team, aud);
}

// ── The one gate every human-admin handler calls ────────────────────────────────────────────────

/** Full admin gate: constant-time key auth + failed-attempt throttle + (portal paths) the Access
 *  JWT. Returns a ready error Response (401 with the Basic realm / 429 throttled / 403 Access),
 *  or null when the request passes. `jwt: true` = the human PORTAL surface (behind the Access
 *  app); `jwt: false` = curl-style key-only endpoints (scripts/tools, never behind Access). */
export async function adminGate(
  request: Request,
  env: AdminAuthEnv,
  opts: { jwt: boolean; realm?: string },
  diag?: (kind: string, detail: string) => void,
): Promise<Response | null> {
  if (!adminAuthed(request, env.BRACKET_ADMIN_KEY)) {
    // Failed attempt → consume throttle budget for this IP (fail-open when binding absent).
    const limiter = env.ADMIN_LIMITER;
    if (limiter) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await limiter.limit({ key: `adminauth:${ip}` });
      if (!success) {
        diag?.("adminAuthThrottled", `ip throttled after repeated failures`);
        return new Response("Too many attempts. Try again in a minute.", { status: 429 });
      }
    }
    return new Response("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": adminRealm(opts.realm ?? "NWSLApp Admin") },
    });
  }
  if (opts.jwt) {
    const reject = await verifyAccessJwt(request, env);
    if (reject) {
      diag?.("adminAccessJwtReject", reject.slice(0, 70));
      return new Response(`Access denied (Zero Trust): ${reject}`, { status: 403 });
    }
  }
  return null;
}
