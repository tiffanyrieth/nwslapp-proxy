import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PODCAST_SEED,
	CLUB_ABBRS,
	parsePodcastRSS,
	normalizeDuration,
	normalizeForMatch,
	routeEpisode,
	podcastProblem,
	isValidPodcastList,
	applyPodcastChanges,
	showLinks,
	type PodcastShow,
} from "../src/podcasts.ts";

test("seed: every show validates, ids unique, 23 shows, 16 club + 7 league", () => {
	assert.equal(PODCAST_SEED.length, 23);
	for (const s of PODCAST_SEED) { assert.equal(podcastProblem(s), null, s.id); assert.ok(s.producer === "fan" || s.producer === "media", s.id); }
	const ids = PODCAST_SEED.map((s) => s.id);
	assert.equal(new Set(ids).size, ids.length);
	const league = PODCAST_SEED.filter((s) => s.scope === "league");
	const club = PODCAST_SEED.filter((s) => s.scope !== "league");
	assert.equal(league.length, 7);
	assert.equal(club.length, 16);
	for (const s of club) assert.ok(CLUB_ABBRS.has(s.scope), s.scope);
	assert.ok(isValidPodcastList(PODCAST_SEED));
	// Mixed feeds that need a title filter carry one.
	assert.equal(PODCAST_SEED.find((s) => s.id === "league-soccerwise")?.titleMatch, "NWSL Soccerwise |");
	assert.equal(PODCAST_SEED.find((s) => s.id === "uta-royal-riot")?.titleMatch, "URFC:");
});

test("parsePodcastRSS: channel artwork + items with guid, duration, description", () => {
	const xml =
		`<rss><channel><title>Hey Spirits</title>` +
		`<itunes:image href="https://img.example/art.jpg?v=2&amp;x=1"/>` +
		`<itunes:author>Sounder at Heart</itunes:author>` +
		`<item><title><![CDATA[Three 6 Midfield [Spirit v. Angel City Review]]]></title>` +
		`<guid isPermaLink="false">abc-123</guid>` +
		`<link>https://pod.example/ep/1</link>` +
		`<pubDate>Sun, 28 Sep 2026 12:00:00 GMT</pubDate>` +
		`<itunes:duration>01:03:18</itunes:duration>` +
		`<description>A Spirit recap</description></item>` +
		`<item><title>No guid, has enclosure</title>` +
		`<enclosure url="https://cdn.example/2.mp3" type="audio/mpeg"/>` +
		`<itunes:duration>2083</itunes:duration></item>` +
		`</channel></rss>`;
	const p = parsePodcastRSS(xml);
	assert.equal(p.artwork, "https://img.example/art.jpg?v=2&x=1");
	assert.equal(p.author, "Sounder at Heart");
	assert.equal(p.episodes.length, 2);
	assert.equal(p.episodes[0].guid, "abc-123");
	assert.equal(p.episodes[0].title, "Three 6 Midfield [Spirit v. Angel City Review]");
	assert.equal(p.episodes[0].link, "https://pod.example/ep/1");
	assert.equal(p.episodes[0].durationRaw, "01:03:18");
	assert.equal(p.episodes[1].guid, "https://cdn.example/2.mp3"); // falls back to enclosure url
});

test("normalizeDuration: seconds and colon forms", () => {
	assert.equal(normalizeDuration("2083"), "34:43");
	assert.equal(normalizeDuration("54:59"), "54:59");
	assert.equal(normalizeDuration("01:03:18"), "1:03:18");
	assert.equal(normalizeDuration("0"), undefined);
	assert.equal(normalizeDuration("garbage"), undefined);
	assert.equal(normalizeDuration(undefined), undefined);
});

test("routeEpisode: full club names match, bare nicknames/cities do NOT", () => {
	const roster = new Map<string, string>();
	// Full club name hits.
	assert.deepEqual(routeEpisode("Washington Spirit stun KC Current", "", roster).clubs.sort(), ["KC", "WAS"]);
	// Bare nickname / city must NOT match.
	assert.deepEqual(routeEpisode("Pride Month at the stadium", "", roster).clubs, []);
	assert.deepEqual(routeEpisode("The current standings are wild", "", roster).clubs, []);
	assert.deepEqual(routeEpisode("A big wave of signings", "", roster).clubs, []);
	// Zero match → league-wide.
	assert.deepEqual(routeEpisode("USWNT roster reaction", "", roster).clubs, []);
});

test("routeEpisode: full player name matches, surname alone does not", () => {
	const roster = new Map<string, string>([
		[normalizeForMatch("Trinity Rodman"), "WAS"],
		[normalizeForMatch("André Carlisle"), "WAS"], // accent-folded key
	]);
	const hit = routeEpisode("Trinity Rodman is back", "", roster);
	assert.deepEqual(hit.clubs, ["WAS"]);
	assert.ok(hit.matched.some((m) => m.term === "trinity rodman" && m.abbr === "WAS"));
	// Surname alone must not match.
	assert.deepEqual(routeEpisode("Rodman watch", "", roster).clubs, []);
	// Accent folding: the episode text has the accent, the roster key is folded.
	assert.deepEqual(routeEpisode("André Carlisle breaks it down", "", roster).clubs, ["WAS"]);
});

test("routeEpisode: a player's club is tagged even without the club name", () => {
	const roster = new Map<string, string>([[normalizeForMatch("Temwa Chawinga"), "KC"]]);
	assert.deepEqual(routeEpisode("Temwa Chawinga is the best in the world", "", roster).clubs, ["KC"]);
});

test("podcastProblem / validation", () => {
	assert.match(podcastProblem({ id: "x", name: "n", rss: "https://a.b", scope: "league" })!, /id/); // too short
	assert.match(podcastProblem({ id: "ok-id", name: "n", rss: "http://a.b", scope: "league" })!, /rss/);
	assert.match(podcastProblem({ id: "ok-id", name: "n", rss: "https://a.b", scope: "NYC" })!, /scope/);
	assert.equal(podcastProblem({ id: "ok-id", name: "n", rss: "https://a.b", scope: "WAS" }), null);
	assert.equal(isValidPodcastList([{ id: "bad" } as PodcastShow]), false);
	assert.equal(isValidPodcastList([]), false);
});

test("applyPodcastChanges: drop/add, dedupe, per-club rail, no mutation", () => {
	const base: PodcastShow[] = [
		{ id: "was-a", name: "A", rss: "https://a.example/f", scope: "WAS", blurb: "x", producer: "fan" },
		{ id: "league-b", name: "B", rss: "https://b.example/f", scope: "league", blurb: "x", producer: "media" },
	];
	const frozen = JSON.stringify(base);
	const r = applyPodcastChanges(base, {
		drop: ["league-b", "nope"],
		add: [{ id: "was-c", name: "C", rss: "https://c.example/f", scope: "was", blurb: "y" }],
	});
	assert.deepEqual(r.dropped, ["league-b"]);
	assert.deepEqual(r.added, ["was-c"]);
	assert.equal(r.rejected[0].reason, "not on the list");
	assert.equal(r.list.find((s) => s.id === "was-c")?.scope, "WAS"); // upper-cased
	assert.equal(JSON.stringify(base), frozen); // input not mutated

	const dup = applyPodcastChanges(base, { add: [{ id: "was-a", name: "dup", rss: "https://z", scope: "WAS", blurb: "x" }] });
	assert.equal(dup.rejected[0].reason, "id already on the list");
	const dupFeed = applyPodcastChanges(base, { add: [{ id: "was-z", name: "z", rss: "https://a.example/f", scope: "WAS", blurb: "x" }] });
	assert.equal(dupFeed.rejected[0].reason, "same feed already on the list");

	const full = [...Array(6)].map((_, i) => ({ id: `was-${i}`, name: `n${i}`, rss: `https://f${i}.example`, scope: "WAS", blurb: "x", producer: "fan" }) as PodcastShow);
	const rail = applyPodcastChanges(full, { add: [{ id: "was-over", name: "o", rss: "https://over.example", scope: "WAS", blurb: "x" }] });
	assert.match(rail.rejected[0].reason, /per-club rail/);
});

test("showLinks: derives Apple/Overcast/Pocket Casts from the Apple id; Spotify from the stored url", () => {
	const links = showLinks({ id: "x", name: "n", rss: "https://a.b", scope: "WAS", appleId: "1674466647", spotifyUrl: "https://open.spotify.com/show/abc", blurb: "x", producer: "fan" });
	assert.equal(links.apple, "https://podcasts.apple.com/podcast/id1674466647");
	assert.equal(links.overcast, "https://overcast.fm/itunes1674466647");
	assert.equal(links.pocketcasts, "https://pca.st/itunes/1674466647");
	assert.equal(links.spotify, "https://open.spotify.com/show/abc");
	const noApple = showLinks({ id: "x", name: "n", rss: "https://a.b", scope: "WAS", blurb: "x", producer: "fan" });
	assert.equal(noApple.apple, undefined);
});
