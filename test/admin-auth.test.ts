// Part B hardening (2026-08-24): the pure/crypto halves of admin-auth — constant-time compare,
// Access-JWT claims validation, and a full RS256 sign→verify round-trip with a generated key
// (node's WebCrypto matches workerd's for RSASSA-PKCS1-v1_5). The fetch/limiter wiring is
// exercised live (deploy + portal). Run: node --test test/admin-auth.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEqual, validateAccessClaims, verifyJwtWithKeys } from "../src/admin-auth.ts";

test("safeEqual: equal, unequal, and length-mismatch", () => {
	assert.equal(safeEqual("secret-key-123", "secret-key-123"), true);
	assert.equal(safeEqual("secret-key-123", "secret-key-124"), false);
	assert.equal(safeEqual("short", "much-longer-value"), false);
	assert.equal(safeEqual("", ""), true);
});

const TEAM = "example.cloudflareaccess.com";
const AUD = "aud-tag-abc123";
const NOW = 1_800_000_000;

test("validateAccessClaims: accepts a good payload; rejects each bad claim", () => {
	const good = { iss: `https://${TEAM}`, aud: [AUD], exp: NOW + 3600 };
	assert.equal(validateAccessClaims(good, TEAM, AUD, NOW), null);
	assert.equal(validateAccessClaims({ ...good, iss: "https://evil.example" }, TEAM, AUD, NOW), "bad iss");
	assert.equal(validateAccessClaims({ ...good, aud: ["other"] }, TEAM, AUD, NOW), "bad aud");
	assert.equal(validateAccessClaims({ ...good, exp: NOW - 10 }, TEAM, AUD, NOW), "expired");
	assert.equal(validateAccessClaims({ ...good, nbf: NOW + 3600 }, TEAM, AUD, NOW), "not yet valid");
	// aud may also arrive as a bare string
	assert.equal(validateAccessClaims({ iss: `https://${TEAM}`, aud: AUD, exp: NOW + 60 }, TEAM, AUD, NOW), null);
});

// ── full sign→verify round-trip ────────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array | ArrayBuffer): string => {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = "";
	for (const b of u8) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function makeToken(payload: object, kid: string, key: CryptoKey): Promise<string> {
	const enc = new TextEncoder();
	const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
	const body = b64url(enc.encode(JSON.stringify(payload)));
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`));
	return `${head}.${body}.${b64url(sig)}`;
}

test("verifyJwtWithKeys: valid token passes; tampering/expiry/kid/alg all reject", async () => {
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true, ["sign", "verify"]);
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid?: string };
	jwk.kid = "test-kid";
	const keys = [jwk];
	const claims = { iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600 };

	const good = await makeToken(claims, "test-kid", pair.privateKey);
	assert.equal(await verifyJwtWithKeys(good, keys, TEAM, AUD), null);

	// Tampered payload → bad signature
	const parts = good.split(".");
	const tampered = `${parts[0]}.${b64url(new TextEncoder().encode(JSON.stringify({ ...claims, aud: [AUD], admin: true })))}.${parts[2]}`;
	assert.equal(await verifyJwtWithKeys(tampered, keys, TEAM, AUD), "bad signature");

	// Expired
	const expired = await makeToken({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, "test-kid", pair.privateKey);
	assert.equal(await verifyJwtWithKeys(expired, keys, TEAM, AUD), "expired");

	// Unknown kid (two keys registered so the single-key fallback can't apply)
	assert.equal(await verifyJwtWithKeys(await makeToken(claims, "other-kid", pair.privateKey),
		[jwk, { ...jwk, kid: "second" }], TEAM, AUD), "unknown kid");

	// alg "none" forgery shape
	const noneHead = b64url(new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "test-kid" })));
	const noneBody = b64url(new TextEncoder().encode(JSON.stringify(claims)));
	assert.equal(await verifyJwtWithKeys(`${noneHead}.${noneBody}.`, keys, TEAM, AUD), "bad alg");

	// Garbage
	assert.equal(await verifyJwtWithKeys("not-a-jwt", keys, TEAM, AUD), "malformed");
});
