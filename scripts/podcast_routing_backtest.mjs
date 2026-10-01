// Podcast routing backtest (QA, not a gate). Pulls each seed show's FULL RSS (all episodes the feed
// carries, typically ~3 months), runs the deterministic router, and reports per-club counts, a random
// sample of matches to eyeball precision, and the zero-match (league) pile. Roster = the live
// /feed/players directory (the featured-player list — the production fallback when social:nwsl-names
// is cold). Usage: node scripts/podcast_routing_backtest.mjs [https://origin]
import { PODCAST_SEED, parsePodcastRSS, normalizeDuration, normalizeForMatch, routeEpisode, CLUB_MATCH_NAMES } from "../src/podcasts.ts";

const ORIGIN = process.argv[2] || "http://localhost:8799";
const UA = "Mozilla/5.0 (podcast-backtest)";

function stripHtml(s) {
	return (s || "").replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function loadRoster() {
	try {
		const r = await fetch(`${ORIGIN}/feed/players`);
		const players = await r.json();
		const map = new Map();
		for (const p of players) {
			const k = normalizeForMatch(p.name);
			if (k.includes(" ")) map.set(k, p.team);
		}
		return map;
	} catch (e) {
		console.error("roster load failed:", e.message);
		return new Map();
	}
}

const sample = (arr, n) => {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a.slice(0, n);
};

const roster = await loadRoster();
console.log(`roster: ${roster.size} full player names\n`);

const perClub = {};
const allMatches = [];
let leaguePile = 0;
let totalEpisodes = 0;
const leagueShows = PODCAST_SEED.filter((s) => s.scope === "league");

for (const show of leagueShows) {
	let xml;
	try {
		const r = await fetch(show.rss, { headers: { "User-Agent": UA } });
		if (!r.ok) {
			console.log(`  [skip] ${show.name}: HTTP ${r.status}`);
			continue;
		}
		xml = await r.text();
	} catch (e) {
		console.log(`  [skip] ${show.name}: ${e.message}`);
		continue;
	}
	const { episodes } = parsePodcastRSS(xml);
	for (const ep of episodes) {
		if (show.titleMatch && !ep.title.toLowerCase().includes(show.titleMatch.toLowerCase())) continue;
		totalEpisodes++;
		const title = stripHtml(ep.title);
		const desc = stripHtml(ep.description).slice(0, 240);
		const { clubs, matched } = routeEpisode(title, desc, roster);
		if (clubs.length === 0) leaguePile++;
		for (const c of clubs) perClub[c] = (perClub[c] ?? 0) + 1;
		if (clubs.length) allMatches.push({ show: show.name, title: title.slice(0, 60), clubs, matchedTerms: matched.map((m) => m.term) });
	}
}

console.log(`league-show episodes scanned: ${totalEpisodes}`);
console.log(`routed to >=1 club: ${allMatches.length} | zero-match (league pile): ${leaguePile} (${Math.round((leaguePile / totalEpisodes) * 100)}%)\n`);
console.log("per-club routed counts:");
for (const abbr of Object.keys(CLUB_MATCH_NAMES)) console.log(`  ${abbr}: ${perClub[abbr] ?? 0}`);
console.log("\n25 random matches (eyeball precision):");
for (const m of sample(allMatches, 25)) console.log(`  [${m.clubs.join(",")}] ${m.show} — ${m.title}  <= ${m.matchedTerms.join(", ")}`);
