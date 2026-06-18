#!/usr/bin/env node
//
// build_asset_manifest.mjs — write the crest + flag version manifest to KV (`asset:manifest`),
// served by the Worker at GET /crest/manifest.
//
// The app (AssetRefreshService) bundles every crest + flag and ships BundledAssetManifest with
// the hash of each one's SOURCE MASTER. This script hashes the SAME masters — the NWSL crest
// SVG/PNG (Cloudinary t_w_480, by GUID) and the flagcdn flag SVG (by slug) — so a freshly
// installed app's bundled hashes equal this manifest and nothing re-downloads. A hash only
// changes when NWSL/flagcdn changes a master (a rebrand), which is exactly when the app should
// pull the new artwork as a cache override (without an app release).
//
// Hash = sha256(sourceBytes) truncated to 16 hex — must stay identical to the app side
// (NWSLApp BundledAssetManifest.swift). Re-run alongside load_crests.mjs whenever a crest
// master changes; run on a cadence (or cron) to catch flag changes.
//
// USAGE:
//   node scripts/build_asset_manifest.mjs            # hash all masters + upload the manifest
//   node scripts/build_asset_manifest.mjs --dry-run  # print the manifest, do not upload
//

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KV_BINDING = "FEED_TAGS";
const UA = "Mozilla/5.0 Chrome/120";

// abbreviation → NWSL team GUID (same table as load_crests.mjs — keep in sync).
const TEAM_GUIDS = {
	CHI: "269e825b853f4b43a9d38390aa92bf6e", KC: "2c1699409ff84c9eb491aeaca3d3edde",
	BOS: "d2d8efe548734dfd8bc667b5a52a079a", ORL: "c3e9513e280b41e5bfbb8230076e8c43",
	LOU: "ac29701756da44a08457762380c10733", POR: "96ba7b37bd8544a1a7329183459150ff",
	NC: "fb41ef4439dd495098cb6d40415767cc", DEN: "cbfcacbef5bc4a278442c00926ac9ebc",
	HOU: "ca3f464d6b794a9087d441d75961403f", LA: "9587b8ce40624165903b6bc9fd252634",
	SEA: "1151140adfc24339ba1c93cb0b6b0238", SD: "ca719042b34443c4bcfe380ca4850eaf",
	WAS: "c31d72afc09f42ee86418633aa41390a", GFC: "c83f2ca05aa84c738b5373f0d2a31b39",
	BAY: "19674698cec24f53af8866cd21abaf8f", UTA: "acffc559cf7d485a9c05fa23ab57054b",
};

// FIFA code → flagcdn slug. Only the FEATURED set is bundled (and thus manifested) — the
// browse-all flags are download-and-cache, not bundled, so they aren't refresh-managed here.
// Keep in sync with NWSLApp NationalTeam.featured + BundledAssetManifest.flags.
const FLAG_SLUGS = {
	USA: "us", MEX: "mx", CAN: "ca", BRA: "br", COL: "co", ENG: "gb-eng", JAM: "jm", JPN: "jp",
};

const crestURL = (guid) =>
	`https://images.nwslsoccer.com/image/private/t_w_480/prd/assets/widgets/teams/${guid}`;
const flagURL = (slug) => `https://flagcdn.com/${slug}.svg`;

const dryRun = process.argv.slice(2).includes("--dry-run");

// Hash the SOURCE MASTER and note whether it's vector (an SVG). `v` drives the app's
// no-downgrade rule: a vector-bundled asset is only ever replaced by a raster override when
// the new master is itself raster-only (v === false).
async function entryFor(url) {
	const res = await fetch(url, { headers: { "User-Agent": UA } });
	if (!res.ok) throw new Error(`${res.status} ${url}`);
	const buf = Buffer.from(await res.arrayBuffer());
	const h = createHash("sha256").update(buf).digest("hex").slice(0, 16);
	const v = (res.headers.get("content-type") || "").includes("svg");
	return { h, v };
}

async function entryMap(entries, toURL) {
	const out = {};
	for (const [key, val] of Object.entries(entries)) {
		try {
			out[key] = await entryFor(toURL(val));
			console.log(`✓ ${key.padEnd(4)} ${out[key].h} ${out[key].v ? "vector" : "raster"}`);
		} catch (e) {
			console.error(`✗ ${key}: ${e.message}`);
		}
	}
	return out;
}

console.log("Hashing crest masters…");
const crests = await entryMap(TEAM_GUIDS, crestURL);
console.log("Hashing flag masters…");
const flags = await entryMap(FLAG_SLUGS, flagURL);

const manifest = { generatedAt: new Date().toISOString(), crests, flags };
const json = JSON.stringify(manifest);
console.log(`\nManifest: ${Object.keys(crests).length} crests, ${Object.keys(flags).length} flags`);

if (dryRun) {
	console.log(JSON.stringify(manifest, null, 2));
	console.log("Dry run — not uploaded.");
} else {
	const dir = mkdtempSync(join(tmpdir(), "manifest-"));
	const file = join(dir, "asset-manifest.json");
	writeFileSync(file, json);
	execFileSync(
		"npx",
		["wrangler", "kv", "key", "put", "asset:manifest", "--binding", KV_BINDING, "--path", file, "--remote"],
		{ stdio: "inherit" },
	);
	console.log("Uploaded asset:manifest to KV.");
}
