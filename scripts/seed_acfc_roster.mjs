#!/usr/bin/env node
//
// seed_acfc_roster.mjs — one-time warm of the last-known-good roster cache for Angel
// City FC (ESPN team id 21422) in Cloudflare KV (`roster:21422`, binding FEED_TAGS).
//
// WHY: ESPN's NWSL roster endpoint returns an implausibly small roster for ACFC (1
// player) for the current season, while every other team is full — a data-source gap
// on ESPN's side. The proxy's /roster route serves a cached last-known-good roster
// when ESPN comes back short, but the cache only warms on a *good* ESPN fetch, which
// ACFC never produces. This script seeds that cache from authoritative sources so ACFC
// shows a real, current squad immediately (labeled "Roster as of <date>" in the app).
//
// SOURCES (all current, not stale-season — so the date label is honest):
//   - angelcity.com/club/roster (official site): the CURRENT 25-player squad — per
//     player the position (card CSS class), jersey number (.player-num), and slug.
//   - ESPN 2025 ACFC roster (?season=2025): real ESPN athlete ids + bio (age/height/
//     citizenship) for RETURNING players, matched by name. New 2026 signings get a
//     stable synthetic id (acfc-<slug>); they render fine (headshot → monogram, stats
//     tap → empty, both already handled by the app).
//   - The live (broken) roster response: the CURRENT team profile (color / record /
//     standing) so the team header stays accurate.
//
// The output matches ESPN's roster JSON shape, so the app's RosterResponse decodes it
// unchanged. We wrap it as { fetchedAt, body } — the shape the /roster route expects in
// KV — and write with NO expiration, so it persists until ESPN restores ACFC (a real
// good fetch then overwrites it with a 90d TTL automatically).
//
// USAGE:
//   node scripts/seed_acfc_roster.mjs            # build + upload to KV (--remote)
//   node scripts/seed_acfc_roster.mjs --dry-run  # build + print the roster, no upload
//

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TEAM_ID = "21422";
const KV_KEY = `roster:${TEAM_ID}`;
const KV_BINDING = "FEED_TAGS";
const OFFICIAL_ROSTER = "https://angelcity.com/club/roster";
const ESPN_ROSTER = (season) =>
	`https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/teams/${TEAM_ID}/roster${season ? `?season=${season}` : ""}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const OUT = "acfc-roster-seed.json";
const POS = {
	// ACFC's site uses "attacker" for forwards; map both to ESPN's "Forward".
	attacker: { displayName: "Forward", abbreviation: "F" },
	forward: { displayName: "Forward", abbreviation: "F" },
	midfielder: { displayName: "Midfielder", abbreviation: "M" },
	defender: { displayName: "Defender", abbreviation: "D" },
	goalkeeper: { displayName: "Goalkeeper", abbreviation: "G" },
};

const dryRun = process.argv.includes("--dry-run");

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

// Normalize a name for matching: lowercase, strip diacritics + punctuation.
const norm = (s) =>
	(s ?? "")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z\s]/g, " ")
		.trim();

const titleCase = (slug) =>
	slug
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");

async function getText(url) {
	const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
	if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
	return r.text();
}
async function getJSON(url) {
	const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
	if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
	return r.json();
}

// --- 1. Parse the official site: current squad (slug, position, jersey) ---
function parseOfficial(html) {
	const players = [];
	const seen = new Set();
	// Each player card: <div class="card-item {position}…"> … <a href="/club/roster/{slug}…"> … <h3 class="player-num…">{num}</h3>
	// The trailing space after `card-item` is required so we don't match the `card-items`
	// CONTAINER div (plural) that wraps all the cards.
	const cardRe = /<div class="card-item ([^"]*)"[\s\S]*?href="\/club\/roster\/([a-z0-9-]+)\?[\s\S]*?<\/a>/g;
	let m;
	while ((m = cardRe.exec(html)) !== null) {
		const classes = m[1];
		const slug = m[2];
		if (seen.has(slug)) continue;
		const block = m[0];
		const posKey = Object.keys(POS).find((p) => new RegExp(`\\b${p}\\b`).test(classes));
		const numMatch = block.match(/player-num[^>]*>\s*(\d+)\s*</);
		seen.add(slug);
		players.push({
			slug,
			position: posKey ? POS[posKey] : null,
			jersey: numMatch ? numMatch[1] : undefined,
		});
	}
	return players;
}

// --- 2. Build the reconciled athletes array ---
function reconcile(official, espn2025) {
	return official.map((p) => {
		const first = p.slug.split("-")[0];
		const last = p.slug.split("-").slice(-1)[0];
		// Best ESPN match: normalized fullName contains both the slug's first + last token.
		const match = espn2025.find((a) => {
			const n = norm(a.fullName);
			return n.includes(first) && n.includes(last);
		});
		const athlete = {
			id: match?.id ?? `acfc-${p.slug}`,
			fullName: match?.fullName ?? titleCase(p.slug),
			jersey: p.jersey ?? match?.jersey,
			position: p.position ?? (match?.position ? { displayName: match.position.displayName, abbreviation: match.position.abbreviation } : undefined),
		};
		// Carry stable biographical fields from ESPN for returning players.
		if (match) {
			if (match.age != null) athlete.age = match.age;
			if (match.displayHeight) athlete.displayHeight = match.displayHeight;
			if (match.citizenship) athlete.citizenship = match.citizenship;
		}
		athlete._source = match ? "espn2025" : "synthetic";
		return athlete;
	});
}

// --- main ---
let officialHtml, espn2025, live;
try {
	[officialHtml, espn2025, live] = await Promise.all([
		getText(OFFICIAL_ROSTER),
		getJSON(ESPN_ROSTER(2025)).then((j) => j.athletes ?? []),
		getJSON(ESPN_ROSTER()).then((j) => j.team ?? null),
	]);
} catch (e) {
	fail(`fetch failed: ${e.message}`);
}

const official = parseOfficial(officialHtml);
if (official.length < 18) fail(`parsed only ${official.length} players from the official site — markup may have changed`);

const athletesWithSource = reconcile(official, espn2025);
const matched = athletesWithSource.filter((a) => a._source === "espn2025").length;
const synthetic = athletesWithSource.length - matched;
const noPos = athletesWithSource.filter((a) => !a.position).length;
const noNum = athletesWithSource.filter((a) => !a.jersey).length;

// Strip the _source debug field from the persisted athletes.
const athletes = athletesWithSource.map(({ _source, ...a }) => a);

// Team profile: current (from the live/broken response) so the header standing stays accurate.
const team = live
	? { color: live.color, standingSummary: live.standingSummary, recordSummary: live.recordSummary }
	: {};

const record = {
	fetchedAt: new Date().toISOString(),
	body: { team, athletes },
};

console.log(`\nACFC roster seed — ${athletes.length} players (${matched} ESPN-matched, ${synthetic} synthetic)`);
if (noPos) console.log(`  ⚠️  ${noPos} without a position (will fall into the "Other" group)`);
if (noNum) console.log(`  ⚠️  ${noNum} without a jersey number`);
console.log(`  team: color=${team.color ?? "—"} record=${team.recordSummary ?? "—"} standing=${team.standingSummary ?? "—"}`);
for (const a of athletesWithSource) {
	console.log(`  ${(a.jersey ?? "—").toString().padStart(2)} ${(a.position?.abbreviation ?? "?")} ${a.fullName.padEnd(26)} ${a.id}  [${a._source}]`);
}

writeFileSync(OUT, JSON.stringify(record, null, 2));
console.log(`\n✓ wrote ${OUT} (fetchedAt ${record.fetchedAt})`);

if (dryRun) {
	console.log("Dry run — not uploading.");
	process.exit(0);
}

// --- Upload to KV (no expiration — persists until a real good ESPN fetch overwrites it) ---
console.log(`Uploading to KV ${KV_BINDING}/${KV_KEY} (--remote, no expiration)…`);
try {
	execFileSync("npx", ["wrangler", "kv", "key", "put", KV_KEY, "--binding", KV_BINDING, "--path", OUT, "--remote"], {
		stdio: "inherit",
	});
} catch (e) {
	fail(`wrangler upload failed: ${e.message}`);
}
console.log(`✓ Seeded ${KV_KEY}. GET /roster?team=${TEAM_ID} now serves this squad (proxyCachedAsOf set) until ESPN restores ACFC.`);
