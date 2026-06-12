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
	const summaryWithState = (state: string) =>
		encode({ header: { competitions: [{ status: { type: { state } } }] } });

	it("caches finished matches ~forever (post -> 1yr)", () => {
		expect(chooseSummaryTTL(summaryWithState("post"))).toBe(31536000);
	});

	it("caches live matches briefly (in -> 30s)", () => {
		expect(chooseSummaryTTL(summaryWithState("in"))).toBe(30);
	});

	it("caches future matches until the next daily refresh, 07:00 UTC (pre -> dynamic, <=24h, >=60s)", () => {
		const ttl = chooseSummaryTTL(summaryWithState("pre"));
		expect(ttl).toBeGreaterThanOrEqual(60);
		expect(ttl).toBeLessThanOrEqual(86400);
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
