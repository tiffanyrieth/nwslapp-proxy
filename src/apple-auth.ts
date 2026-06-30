/**
 * Sign in with Apple (SIWA) server-side token handling — Apple guideline 5.1.1(v):
 * an app that supports account creation must let the user delete it AND revoke the
 * SIWA credential on Apple's side. Flow:
 *   1. At sign-in the app forwards Apple's short-lived `authorizationCode` (5-min TTL).
 *      We exchange it for a long-lived `refresh_token` and store it on the user's
 *      `profiles` row (POST /auth/apple-token-exchange).
 *   2. At account deletion we read that `refresh_token` and POST it to Apple's
 *      `/auth/revoke` BEFORE the Supabase cascade, so Apple no longer considers the
 *      user linked (else a re-signup returns "existing user").
 *
 * The Apple `client_secret` is an ES256 JWT signed with the SIWA `.p8` private key.
 * Same Web Crypto mechanics as the match-watcher's APNs JWT (no Node deps, no JWT lib):
 * ECDSA P-256 / SHA-256, and Web Crypto returns the raw r‖s signature JWS ES256 wants.
 *
 * Secrets (set via `wrangler secret put`, NEVER committed): SIWA_PRIVATE_KEY (the .p8
 * PEM text), SIWA_KEY_ID, APPLE_TEAM_ID. The client_id is the public bundle id (a const).
 */

/** The SIWA + Supabase config this module reads off `env`. All three SIWA fields are
 *  Worker secrets; SUPABASE_* are the same secrets the rest of the Worker uses. */
export type AppleAuthEnv = {
	SIWA_PRIVATE_KEY?: string; // the .p8 private key, full PEM text
	SIWA_KEY_ID?: string; // the .p8's 10-char Key ID
	APPLE_TEAM_ID?: string; // Apple Developer Team ID
	SUPABASE_URL?: string;
	SUPABASE_SERVICE_ROLE_KEY?: string;
};

/** The app's bundle id IS the SIWA client_id for a native app (not a secret). */
const APPLE_CLIENT_ID = "com.tiffanyrieth.nwslapp.NWSLApp";
const APPLE_AUTH_BASE = "https://appleid.apple.com";
/** client_secret lifetime — Apple caps it at 6 months; the brief specifies 180 days. */
const CLIENT_SECRET_TTL_SECONDS = 180 * 24 * 60 * 60; // 15_552_000

function base64UrlFromString(input: string): string {
	return base64UrlFromBytes(new TextEncoder().encode(input));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode the PEM .p8 to the DER bytes Web Crypto's pkcs8 import wants. */
function pkcs8FromPem(pem: string): ArrayBuffer {
	const body = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s+/g, "");
	const binary = atob(body);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

// Module-scoped reuse: the client_secret is valid for 180 days, but a fresh isolate
// starts cold so this is best-effort only — regenerate hourly to stay well clear of any
// clock skew. Correctness never depends on the cache.
let cached: { token: string; iat: number } | null = null;

/** Build (or reuse) the ES256 `client_secret` JWT Apple's token/revoke endpoints want.
 *  Header carries `kid` (the SIWA Key ID) — Apple requires it to pick the key. */
export async function appleClientSecret(env: AppleAuthEnv): Promise<string> {
	if (!env.SIWA_PRIVATE_KEY || !env.SIWA_KEY_ID || !env.APPLE_TEAM_ID) {
		throw new Error("SIWA secrets not configured");
	}
	const now = Math.floor(Date.now() / 1000);
	if (cached && now - cached.iat < 3600) return cached.token;

	const header = base64UrlFromString(JSON.stringify({ alg: "ES256", kid: env.SIWA_KEY_ID }));
	const payload = base64UrlFromString(
		JSON.stringify({
			iss: env.APPLE_TEAM_ID,
			iat: now,
			exp: now + CLIENT_SECRET_TTL_SECONDS,
			aud: APPLE_AUTH_BASE,
			sub: APPLE_CLIENT_ID,
		}),
	);
	const signingInput = `${header}.${payload}`;

	const key = await crypto.subtle.importKey(
		"pkcs8",
		pkcs8FromPem(env.SIWA_PRIVATE_KEY),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		new TextEncoder().encode(signingInput),
	);
	const token = `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
	cached = { token, iat: now };
	return token;
}

/** Exchange Apple's short-lived authorizationCode for a refresh_token. Throws (with
 *  Apple's status + a truncated body) on any non-2xx so the caller can log + 502. */
export async function exchangeAuthorizationCode(env: AppleAuthEnv, code: string): Promise<string> {
	const clientSecret = await appleClientSecret(env);
	const form = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		client_id: APPLE_CLIENT_ID,
		client_secret: clientSecret,
	});
	const resp = await fetch(`${APPLE_AUTH_BASE}/auth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: form.toString(),
	});
	if (!resp.ok) {
		throw new Error(`apple /auth/token ${resp.status} ${(await resp.text()).slice(0, 80)}`);
	}
	const json = (await resp.json()) as { refresh_token?: string };
	if (!json.refresh_token) {
		throw new Error("apple /auth/token: no refresh_token in response");
	}
	return json.refresh_token;
}

/** Revoke a SIWA refresh_token at Apple. Throws on non-2xx; the deletion caller logs
 *  and proceeds regardless (Apple being down must never strand a delete). */
export async function revokeRefreshToken(env: AppleAuthEnv, refreshToken: string): Promise<void> {
	const clientSecret = await appleClientSecret(env);
	const form = new URLSearchParams({
		token: refreshToken,
		token_type_hint: "refresh_token",
		client_id: APPLE_CLIENT_ID,
		client_secret: clientSecret,
	});
	const resp = await fetch(`${APPLE_AUTH_BASE}/auth/revoke`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: form.toString(),
	});
	if (!resp.ok) {
		throw new Error(`apple /auth/revoke ${resp.status} ${(await resp.text()).slice(0, 80)}`);
	}
}

// ── Supabase profiles I/O (service_role — bypasses RLS; needs the explicit
//    `grant … to service_role` from the apple_refresh_token migration) ───────────────

function sbHeaders(env: AppleAuthEnv, extra: Record<string, string> = {}): Record<string, string> {
	return {
		apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
		Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
		"Content-Type": "application/json",
		...extra,
	};
}

/** Upsert the refresh_token onto the user's profiles row. Upsert (not update) so a
 *  sign-in/exchange race where the row doesn't exist yet isn't a silent zero-row no-op. */
export async function storeAppleRefreshToken(env: AppleAuthEnv, userId: string, token: string): Promise<void> {
	const base = (env.SUPABASE_URL ?? "").replace(/\/$/, "");
	const resp = await fetch(`${base}/rest/v1/profiles?on_conflict=id`, {
		method: "POST",
		headers: sbHeaders(env, { Prefer: "resolution=merge-duplicates,return=minimal" }),
		body: JSON.stringify([{ id: userId, apple_refresh_token: token }]),
	});
	if (!resp.ok) {
		throw new Error(`supabase upsert profiles ${resp.status} ${(await resp.text()).slice(0, 80)}`);
	}
}

/** Read the stored refresh_token for a user (null if none / no row). */
export async function readAppleRefreshToken(env: AppleAuthEnv, userId: string): Promise<string | null> {
	const base = (env.SUPABASE_URL ?? "").replace(/\/$/, "");
	const resp = await fetch(
		`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=apple_refresh_token`,
		{ headers: sbHeaders(env) },
	);
	if (!resp.ok) {
		throw new Error(`supabase read profiles ${resp.status} ${(await resp.text()).slice(0, 80)}`);
	}
	const rows = (await resp.json()) as Array<{ apple_refresh_token?: string | null }>;
	return rows[0]?.apple_refresh_token ?? null;
}
