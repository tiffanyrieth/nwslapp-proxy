import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, {
	chooseSummaryTTL,
	dedupeByContent,
	parseOutletRSS,
	appearedPlayers,
	pickWeekly,
	seasonFormLabel,
	mapApifyInstagram,
	mapApifyTikTok,
} from "../src/index";

// A correctly-typed `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// These cover the route guards only — they return before any ESPN fetch, so
// they're deterministic and network-free. The live fetch + cache HIT/MISS/TTL
// behaviour is verified end-to-end with `wrangler dev` + curl.
describe("nwslapp-proxy route guards", () => {
	it("404s any unknown path", async () => {
		const request = new IncomingRequest("https://proxy.test/teams");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it("405s non-GET requests to /scoreboard", async () => {
		const response = await SELF.fetch("https://proxy.test/scoreboard", {
			method: "POST",
		});
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET");
	});

	it("405s non-GET requests to /summary", async () => {
		const response = await SELF.fetch("https://proxy.test/summary?event=123", {
			method: "POST",
		});
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET");
	});

	it("405s non-GET requests to /team-videos", async () => {
		const response = await SELF.fetch("https://proxy.test/team-videos?teams=WAS", {
			method: "POST",
		});
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET");
	});
});

// chooseSummaryTTL is pure: ArrayBuffer in, TTL out. Drives the cache lifetime
// for the /summary route off the match state nested in ESPN's summary JSON.
describe("chooseSummaryTTL", () => {
	const encode = (obj: unknown): ArrayBuffer =>
		new TextEncoder().encode(JSON.stringify(obj)).buffer;
	const summaryWithState = (state: string, date?: string) =>
		encode({ header: { competitions: [{ date, status: { type: { state } } }] } });

	it("caches finished matches ~forever (post -> 1yr)", () => {
		expect(chooseSummaryTTL(summaryWithState("post"))).toBe(31536000);
	});

	it("caches live matches briefly (in -> 30s)", () => {
		expect(chooseSummaryTTL(summaryWithState("in"))).toBe(30);
	});

	it("caches far-future matches until the next daily refresh (pre, no/distant kickoff -> dynamic, <=24h, >=60s)", () => {
		const ttl = chooseSummaryTTL(summaryWithState("pre"));
		expect(ttl).toBeGreaterThanOrEqual(60);
		expect(ttl).toBeLessThanOrEqual(86400);
		// A kickoff days out is further than the daily refresh, so the cap is a no-op:
		// same TTL as the no-date case.
		const far = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
		expect(chooseSummaryTTL(summaryWithState("pre", far))).toBe(ttl);
	});

	it("caps a pre-kickoff shell at kickoff so it can't be served stale all game (pre, imminent kickoff)", () => {
		// Kickoff in 10 min → TTL must not exceed 10min + the 120s buffer, so the
		// empty shell expires around kickoff and the next fetch (now 'in') gets live data.
		const soon = new Date(Date.now() + 600 * 1000).toISOString();
		const ttl = chooseSummaryTTL(summaryWithState("pre", soon));
		expect(ttl).toBeGreaterThanOrEqual(60);
		expect(ttl).toBeLessThanOrEqual(720);
	});

	it("polls ~every 10min in the final ~2h so the ~1h-pre lineup publish isn't missed (pre, T-90min)", () => {
		// At T-90min a stale-until-kickoff cache would sleep through the lineup drop; the lineup-window
		// tier caps the TTL at 10 min instead.
		const t90 = new Date(Date.now() + 90 * 60 * 1000).toISOString();
		const ttl = chooseSummaryTTL(summaryWithState("pre", t90));
		expect(ttl).toBeGreaterThanOrEqual(60);
		expect(ttl).toBeLessThanOrEqual(600);
	});

	it("re-checks quickly when kickoff has passed but ESPN still says pre (delayed start / status lag -> 30s)", () => {
		const past = new Date(Date.now() - 300 * 1000).toISOString();
		expect(chooseSummaryTTL(summaryWithState("pre", past))).toBe(30);
	});

	it("falls back to 1hr on an unknown state", () => {
		expect(chooseSummaryTTL(summaryWithState("weird"))).toBe(3600);
	});

	it("falls back to 1hr on unparseable bytes", () => {
		expect(chooseSummaryTTL(new TextEncoder().encode("not json").buffer)).toBe(3600);
	});
});

// dedupeByContent collapses identical-TEXT cards — the real nwslstat bug, where a
// bot double-posts the same recap under two different post ids.
describe("dedupeByContent", () => {
	it("collapses two cards with identical text but different ids, keeping the first", () => {
		const cards = [
			{ id: "bsky-newer", bodyText: "North Carolina Courage: 4 (2.08 xG)\nvs\nChicago Stars FC: 0 (0.64 xG)" },
			{ id: "bsky-older", bodyText: "North Carolina Courage: 4 (2.08 xG)\nvs\nChicago Stars FC: 0 (0.64 xG)" },
		];
		const out = dedupeByContent(cards) as Array<{ id: string }>;
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("bsky-newer"); // first occurrence (callers pass newest-first)
	});

	it("treats whitespace/case differences as the same content", () => {
		const out = dedupeByContent([
			{ id: "a", bodyText: "Match Day!  GO TEAM" },
			{ id: "b", bodyText: "match day! go team" },
		]);
		expect(out).toHaveLength(1);
	});

	it("keeps genuinely distinct posts", () => {
		const out = dedupeByContent([
			{ id: "a", bodyText: "NC Courage win 4-0" },
			{ id: "b", bodyText: "Gotham draw 1-1" },
		]);
		expect(out).toHaveLength(2);
	});

	it("keys off title/headline when there is no bodyText (YouTube / news cards)", () => {
		const out = dedupeByContent([
			{ id: "yt1", title: "Match Highlights" },
			{ id: "yt2", title: "Match Highlights" },
			{ id: "news1", headline: "Spirit sign new keeper" },
		]);
		expect(out).toHaveLength(2);
	});

	it("passes through cards with no text key untouched", () => {
		const out = dedupeByContent([{ id: "a" }, { id: "b" }]);
		expect(out).toHaveLength(2);
	});
});

// parseOutletRSS is pure: a standard RSS 2.0 string → items with the REAL article
// link, a plain-text (HTML-stripped) description, and an in-feed image when present.
// The allowlist/feed-list + Haiku relevance gate are exercised live via curl.
describe("parseOutletRSS", () => {
	const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
		<item>
			<title><![CDATA[Spirit edge Thorns 2-1 in late thriller]]></title>
			<link>https://equalizersoccer.com/2026/06/11/spirit-thorns/</link>
			<pubDate>Wed, 11 Jun 2026 18:30:00 GMT</pubDate>
			<description><![CDATA[<p>Washington&#8217;s late winner sealed it. <a href="x">Read on</a></p>]]></description>
			<media:content url="https://equalizersoccer.com/img/spirit.jpg" medium="image" />
		</item>
		<item>
			<title>Women&#8217;s football roundup</title>
			<link>https://www.theguardian.com/football/2026/jun/11/roundup</link>
			<pubDate>Tue, 10 Jun 2026 09:00:00 GMT</pubDate>
			<description>Plain summary text with no markup.</description>
			<content:encoded><![CDATA[<img src="https://i.guim.co.uk/lead.jpg"/><p>Body…</p>]]></content:encoded>
		</item>
	</channel></rss>`;

	it("parses the REAL link, strips HTML from the description, reads media:content image", () => {
		const items = parseOutletRSS(rss);
		expect(items).toHaveLength(2);
		expect(items[0].title).toBe("Spirit edge Thorns 2-1 in late thriller");
		expect(items[0].link).toBe("https://equalizersoccer.com/2026/06/11/spirit-thorns/");
		expect(items[0].description).toBe("Washington’s late winner sealed it. Read on");
		expect(items[0].image).toBe("https://equalizersoccer.com/img/spirit.jpg");
	});

	it("decodes entities and falls back to an <img> inside content:encoded", () => {
		const items = parseOutletRSS(rss);
		expect(items[1].title).toBe("Women’s football roundup");
		expect(items[1].description).toBe("Plain summary text with no markup.");
		expect(items[1].image).toBe("https://i.guim.co.uk/lead.jpg");
	});

	it("returns [] for input with no items", () => {
		expect(parseOutletRSS("<rss><channel></channel></rss>")).toEqual([]);
	});

	it("parses Atom feeds too (SB Nation / AllForXI: <entry>, link href, <published>)", () => {
		const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
			<entry>
				<title type="html"><![CDATA[San Diego Wave star Dudinha announces ACL injury]]></title>
				<link rel="alternate" type="text/html" href="https://www.allforxi.com/nwsl/15385/dudinha-acl" />
				<published>2026-06-10T19:41:20-04:00</published>
				<summary type="html"><![CDATA[<p>The forward will miss the rest of the season.</p>]]></summary>
			</entry>
		</feed>`;
		const items = parseOutletRSS(atom);
		expect(items).toHaveLength(1);
		expect(items[0].title).toBe("San Diego Wave star Dudinha announces ACL injury");
		expect(items[0].link).toBe("https://www.allforxi.com/nwsl/15385/dudinha-acl");
		expect(items[0].pubDate).toBe("2026-06-10T19:41:20-04:00");
		expect(items[0].description).toBe("The forward will miss the rest of the season.");
	});
});

// Spotlight (B2) pure helpers: matchday-squad → appeared-only filter, the
// deterministic weekly pick, and the form label. The full /spotlight route (ESPN
// fetches + Haiku narrative) is exercised live via `wrangler dev --remote` + curl.
describe("spotlight helpers", () => {
	const roster = {
		team: { abbreviation: "WAS" },
		roster: [
			{ starter: true, subbedIn: false, athlete: { id: "300", displayName: "Starter A" } },
			{ starter: false, subbedIn: true, athlete: { id: "100", displayName: "Sub B" } },
			{ starter: false, subbedIn: false, athlete: { id: "200", displayName: "Bench C" } }, // DNP
			{ starter: true, subbedIn: false, athlete: { id: "150" } }, // no name → dropped
		],
	};

	it("keeps only players who appeared, sorted by athlete id", () => {
		const out = appearedPlayers(roster);
		expect(out.map((p) => p.athlete?.id)).toEqual(["100", "300"]); // Bench C (DNP) + nameless dropped
	});

	it("returns [] for an undefined roster", () => {
		expect(appearedPlayers(undefined)).toEqual([]);
	});

	it("picks deterministically and stably for a given (team, week)", () => {
		const pool = appearedPlayers(roster);
		const a = pickWeekly(pool, "WAS", 2950);
		const b = pickWeekly(pool, "WAS", 2950);
		expect(a.athlete?.id).toBe(b.athlete?.id); // stable within a week
		expect(pool).toContainEqual(a); // always an in-pool player
	});

	it("can change the pick across weeks", () => {
		const pool = appearedPlayers(roster);
		const picks = new Set([2950, 2951, 2952, 2953].map((w) => pickWeekly(pool, "WAS", w).athlete?.id));
		expect(picks.size).toBeGreaterThan(1); // not frozen on one player
	});

	it("formats the season form label with correct pluralization", () => {
		expect(seasonFormLabel({ goals: 1, assists: 0, apps: 5 })).toBe("1 goal · 0 assists");
		expect(seasonFormLabel({ goals: 3, assists: 2, apps: 12 })).toBe("3 goals · 2 assists");
	});
});

// B3b — Apify IG/TikTok → ContentCard mappers. Pure (one scraped item + its
// handle in → one socialVideo card out); the field-name defensiveness + routing
// is the risky part, so it's the part we unit-test. Live shape is verified by curl
// against the deployed Worker (the cron populates KV).
describe("mapApifyInstagram", () => {
	const club = {
		handle: "washingtonspirit",
		platform: "instagram",
		kind: "team",
		abbr: "WAS",
		name: "Washington Spirit",
	};
	const player = {
		handle: "trinity_rodman",
		platform: "instagram",
		kind: "player",
		abbr: "WAS",
		name: "Trinity Rodman",
	};

	it("maps a club IG post to socialVideo, placement home, fractional seconds stripped", () => {
		const card = mapApifyInstagram(
			{
				shortCode: "ABC123",
				url: "https://www.instagram.com/p/ABC123/",
				timestamp: "2026-06-10T15:00:00.000Z",
				displayUrl: "https://img.example/ig.jpg",
				caption: "Matchday!",
				likesCount: 1200,
				ownerUsername: "washingtonspirit",
			},
			club,
		) as Record<string, unknown>;
		expect(card.layout).toBe("socialVideo");
		expect(card.platform).toBe("instagram");
		expect(card.placement).toBe("home");
		expect(card.teamAbbreviation).toBe("WAS");
		expect(card.id).toBe("ig-ABC123");
		expect(card.thumbnailURL).toBe("https://img.example/ig.jpg");
		expect(card.bodyText).toBe("Matchday!");
		expect(card.likes).toBe(1200);
		expect(card.timestamp).toBe("2026-06-10T15:00:00Z");
		expect(card.authorName).toBe("Washington Spirit");
		expect(card.ctaLabel).toBe("Open in Instagram");
	});

	it("routes a player post to placement feed", () => {
		const card = mapApifyInstagram(
			{ shortCode: "Z", url: "https://www.instagram.com/p/Z/", timestamp: "2026-06-10T15:00:00Z" },
			player,
		) as Record<string, unknown>;
		expect(card.placement).toBe("feed");
		expect(card.authorName).toBe("Trinity Rodman");
	});

	it("handles a unix-seconds timestamp, nested caption, and derives the url from the shortcode", () => {
		const card = mapApifyInstagram(
			{ code: "S1", taken_at: 1749567600, caption: { text: "hi" }, image_url: "https://img/x.jpg" },
			club,
		) as Record<string, unknown>;
		expect(card.url).toBe("https://www.instagram.com/p/S1/");
		expect(card.bodyText).toBe("hi");
		expect(card.thumbnailURL).toBe("https://img/x.jpg");
		expect(String(card.timestamp).endsWith("Z")).toBe(true);
	});

	it("maps the REAL sones lowcost output shape (code, taken_at unix, caption.text, image_url, post_url, like_count)", () => {
		const card = mapApifyInstagram(
			{
				code: "DZd8lRsSC3b",
				post_url: "https://www.instagram.com/p/DZd8lRsSC3b/",
				taken_at: 1781301094,
				caption: { text: "Happy World Cup! ⚽️" },
				image_url: "https://instagram.fna.fbcdn.net/x.jpg",
				like_count: 1234,
				scraped_username: "washingtonspirit",
			},
			club,
		) as Record<string, unknown>;
		expect(card.id).toBe("ig-DZd8lRsSC3b");
		expect(card.url).toBe("https://www.instagram.com/p/DZd8lRsSC3b/");
		expect(card.thumbnailURL).toBe("https://instagram.fna.fbcdn.net/x.jpg");
		expect(card.bodyText).toBe("Happy World Cup! ⚽️");
		expect(card.likes).toBe(1234);
		expect(String(card.timestamp).endsWith("Z")).toBe(true);
	});

	it("returns null when the post can't be dated (won't mis-sort to now)", () => {
		expect(mapApifyInstagram({ url: "https://www.instagram.com/p/X/" }, club)).toBeNull();
	});
});

describe("mapApifyTikTok", () => {
	const club = {
		handle: "washspirit",
		platform: "tiktok",
		kind: "team",
		abbr: "WAS",
		name: "Washington Spirit",
	};

	it("maps a TikTok video to socialVideo with cover, likes, and id from the video url", () => {
		const card = mapApifyTikTok(
			{
				text: "goal!",
				webVideoUrl: "https://www.tiktok.com/@washspirit/video/7490000000000000000",
				videoMeta: { coverUrl: "https://img/cover.jpg" },
				createTimeISO: "2026-06-09T12:00:00.000Z",
				diggCount: 500,
				authorMeta: { name: "washspirit" },
			},
			club,
		) as Record<string, unknown>;
		expect(card.layout).toBe("socialVideo");
		expect(card.platform).toBe("tiktok");
		expect(card.placement).toBe("home");
		expect(card.id).toBe("tt-7490000000000000000");
		expect(card.thumbnailURL).toBe("https://img/cover.jpg");
		expect(card.bodyText).toBe("goal!");
		expect(card.likes).toBe(500);
		expect(card.timestamp).toBe("2026-06-09T12:00:00Z");
		expect(card.ctaLabel).toBe("Open in TikTok");
	});

	it("returns null without a video url", () => {
		expect(mapApifyTikTok({ createTimeISO: "2026-06-09T12:00:00Z" }, club)).toBeNull();
	});
});
