// Pure-logic tests for the SIWA client_secret JWT builder. Run with the Node test
// runner (vitest-pool-workers can't boot workerd on Node 26 — see CLAUDE.md):
//   node --test test/apple-auth.test.ts
//
// We never hit Apple's network here — we generate a throwaway P-256 key, sign a
// client_secret with it, then decode + cryptographically verify the JWT. This locks
// down the exact shape Apple requires: ES256 + kid header, and iss/sub/aud/exp claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appleClientSecret } from "../src/apple-auth.ts";

const TEAM_ID = "24BGA36VVW";
const KEY_ID = "K5C7P5KSGX";
const CLIENT_ID = "com.tiffanyrieth.nwslapp.NWSLApp";

/** Generate a P-256 keypair and return the private key as PKCS#8 PEM (the .p8 shape). */
async function generateP8(): Promise<{ pem: string; publicKey: CryptoKey }> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	let b64 = "";
	for (const byte of pkcs8) b64 += String.fromCharCode(byte);
	b64 = btoa(b64);
	const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
	const pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
	return { pem, publicKey: pair.publicKey };
}

function decodeSegment(seg: string): any {
	const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
	return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

// One shared keypair across the two signing tests: appleClientSecret caches the first
// token module-scoped (~1h reuse), so a second key would mismatch on verify. Sharing the
// key keeps the cached token consistent — which is the real production behaviour anyway.
const shared = await generateP8();

test("appleClientSecret builds a well-formed ES256 client_secret JWT", async () => {
	const jwt = await appleClientSecret({
		SIWA_PRIVATE_KEY: shared.pem,
		SIWA_KEY_ID: KEY_ID,
		APPLE_TEAM_ID: TEAM_ID,
	});

	const [h, p, s] = jwt.split(".");
	assert.ok(h && p && s, "JWT has three segments");

	const header = decodeSegment(h);
	assert.equal(header.alg, "ES256", "alg is ES256");
	assert.equal(header.kid, KEY_ID, "kid is the SIWA Key ID");

	const payload = decodeSegment(p);
	assert.equal(payload.iss, TEAM_ID, "iss is the Team ID");
	assert.equal(payload.sub, CLIENT_ID, "sub is the bundle/client_id");
	assert.equal(payload.aud, "https://appleid.apple.com", "aud is Apple");
	assert.equal(typeof payload.iat, "number", "iat present");
	assert.equal(payload.exp - payload.iat, 180 * 24 * 60 * 60, "exp is 180 days out");
});

test("the signature verifies against the matching public key (raw r‖s, ES256)", async () => {
	const jwt = await appleClientSecret({
		SIWA_PRIVATE_KEY: shared.pem,
		SIWA_KEY_ID: KEY_ID,
		APPLE_TEAM_ID: TEAM_ID,
	});
	const [h, p, s] = jwt.split(".");
	const signingInput = new TextEncoder().encode(`${h}.${p}`);
	const sigB64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const sig = Uint8Array.from(Buffer.from(sigB64, "base64"));

	const ok = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		shared.publicKey,
		sig,
		signingInput,
	);
	assert.equal(ok, true, "JWS ES256 signature verifies");
});

test("appleClientSecret throws when SIWA secrets are missing", async () => {
	await assert.rejects(() => appleClientSecret({ SIWA_KEY_ID: KEY_ID, APPLE_TEAM_ID: TEAM_ID }), /not configured/);
});
