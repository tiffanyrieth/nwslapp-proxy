#!/usr/bin/env node
//
// load_crests.mjs — rasterize the 16 NWSL team crests into Cloudflare KV as transparent PNGs.
//
// The app's TeamLogo prefers a crisp NWSL crest (GET /crest?team=WAS) over ESPN's raster PNG,
// falling back to ESPN when a team isn't loaded. NWSL serves crests on a named-transform-only
// Cloudinary CDN (arbitrary f_png → 401) and returns SVG for ~11 of 16 teams, which SwiftUI
// can't render — so we rasterize OFFLINE here (sharp handles both SVG and PNG sources) to a
// transparent PNG and store the bytes per team at KV key `crest:{ABBR}` (binding FEED_TAGS).
// The Worker's /crest route just serves those bytes.
//
// USAGE:
//   node scripts/load_crests.mjs              # rasterize + upload all 16
//   node scripts/load_crests.mjs --only WAS   # just one team (e.g. the Spirit-only spike)
//   node scripts/load_crests.mjs --dry-run    # rasterize to /tmp + report, no upload
//
// REFRESH: a crest changes ~never; re-run if a club rebrands. No app release needed (TeamLogo
// reads the live route; bump the route's `cv` lever or wait out the 30d edge cache).
//

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const KV_BINDING = "FEED_TAGS";
const OUT = 512; // px output canvas — sized so the crest ARTWORK below stays high-res (~430px,
//                  well above the largest in-app crest @3x ~192px) and the margin is added
//                  AROUND it, not by shrinking the crest. Bigger canvas, not a smaller logo.
const FILL = 0.84; // crest fills 84% of the canvas → a "modest" uniform margin (~8% each side),
//                    consistent across all 16 (unlike ESPN's per-logo padding). Tune freely.

// abbreviation → NWSL team GUID (from the SDP /teams feed; acronymName == the app's abbr).
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

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? "").toUpperCase() : null;

const teams = Object.keys(TEAM_GUIDS).filter((a) => !only || a === only);
if (teams.length === 0) {
	console.error(`✗ --only ${only}: not a known team (${Object.keys(TEAM_GUIDS).join(", ")})`);
	process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "crests-"));

// The NWSL source for a team: by GUID under widgets/teams. t_w_480 returns the source SVG for
// ~11 teams (resolution-independent) and a 480px PNG for the rest; sharp normalizes both.
const sourceURL = (guid) =>
	`https://images.nwslsoccer.com/image/private/t_w_480/prd/assets/widgets/teams/${guid}`;

let ok = 0;
for (const abbr of teams) {
	try {
		const res = await fetch(sourceURL(TEAM_GUIDS[abbr]), {
			headers: { "User-Agent": "Mozilla/5.0 Chrome/120" },
		});
		if (!res.ok) throw new Error(`source ${res.status}`);
		const src = Buffer.from(await res.arrayBuffer());

		// `density` only affects SVG inputs (rasterize at high DPI for crisp edges); ignored for
		// PNG sources. Fit the crest into FILL% of the frame, then extend with a transparent
		// border to OUT — a uniform "modest" margin around every crest. `contain` preserves the
		// crest's aspect ratio.
		const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
		const inner = Math.round(OUT * FILL);
		const margin = Math.round((OUT - inner) / 2);
		const png = await sharp(src, { density: 300 })
			.resize(inner, inner, { fit: "contain", background: transparent })
			.extend({ top: margin, bottom: margin, left: margin, right: margin, background: transparent })
			.png()
			.toBuffer();

		const file = join(dir, `crest_${abbr}.png`);
		writeFileSync(file, png);
		console.log(`✓ ${abbr.padEnd(4)} ${(png.length / 1024).toFixed(1)} KB → ${file}`);

		if (!dryRun) {
			execFileSync(
				"npx",
				["wrangler", "kv", "key", "put", `crest:${abbr}`, "--binding", KV_BINDING, "--path", file, "--remote"],
				{ stdio: "inherit" },
			);
		}
		ok++;
	} catch (e) {
		console.error(`✗ ${abbr}: ${e.message}`);
	}
}

console.log(`${dryRun ? "Dry run — " : ""}done: ${ok}/${teams.length} crests${dryRun ? " rasterized (not uploaded)" : " uploaded to KV"}.`);
