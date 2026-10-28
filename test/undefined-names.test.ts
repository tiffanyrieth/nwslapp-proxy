// Guard (2026-10-21): wrangler bundles with esbuild, which does NOT type-check — a name that was never imported
// ships and only throws at runtime. That's how the match-analytics scheduler went live failing with
// "STATS_REFRESH_AFTER_KICKOFF_MS is not defined" (caught in `wrangler tail` an hour after deploy). The project's
// tsc run isn't configured with the Workers types, so it reports hundreds of runtime globals as missing; this test
// keeps only "Cannot find name" errors that are NOT Workers/Web globals and fails on any of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

/** Workers / Web platform globals tsc doesn't know without the runtime types. */
const RUNTIME = new Set([
	"AbortController", "AbortSignal", "atob", "Blob", "btoa", "BufferSource", "Cache", "caches", "clearTimeout", "CompressionStream",
	"crypto", "CryptoKey", "DecompressionStream", "DurableObjectNamespace", "DurableObjectState", "DurableObjectStub",
	"ExecutionContext", "ExportedHandler", "fetch", "Fetcher", "Headers", "JsonWebKey", "KVNamespace", "Request",
	"RequestInit", "Response", "setTimeout", "TextDecoder", "TextEncoder", "URL", "URLSearchParams",
]);

/** Names tsc can't see but that are deliberately defined at runtime (none today). Add one only with a reason. */
const KNOWN = new Set<string>([]);

test("no undefined identifiers in src/ (esbuild doesn't type-check)", () => {
	let out = "";
	try {
		execSync("npx tsc --noEmit -p .", { encoding: "utf8", stdio: "pipe" });
	} catch (e) {
		out = String((e as { stdout?: string }).stdout ?? "");
	}
	const missing = [...out.matchAll(/^(src\/[^(]+)\(\d+,\d+\): error TS2304: Cannot find name '(\w+)'/gm)]
		.filter((m) => !RUNTIME.has(m[2]) && !KNOWN.has(m[2]))
		.map((m) => `${m[1]}: ${m[2]}`);
	assert.deepEqual([...new Set(missing)], []);
});
