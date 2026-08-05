import { describe, it, expect } from "vitest";
import {
	extractArticleLinks,
	extractIndexDates,
	isPlaceholderArticle,
	extractJsonLdArticle,
	decideFeedItem,
	centersNonNWSLLeague,
} from "../src/index";

describe("centersNonNWSLLeague — foreign-league relevance backstop", () => {
	it("drops a post centering a non-NWSL league with no NWSL signal", () => {
		expect(
			centersNonNWSLLeague("Japan is the joint-largest market for the WSL outside of the UK"),
		).toBe(true);
		expect(centersNonNWSLLeague("Liga F transfer window roundup")).toBe(true);
		expect(centersNonNWSLLeague("UEFA Women's Champions League draw")).toBe(true);
	});

	it("keeps NWSL posts, including ones that name another league in comparison", () => {
		expect(centersNonNWSLLeague("NWSL playoff race tightens after the weekend")).toBe(false);
		expect(centersNonNWSLLeague("Unlike the WSL, the NWSL has a salary cap")).toBe(false);
		expect(centersNonNWSLLeague("Ally Sentnor traded to Angel City FC")).toBe(false);
		expect(centersNonNWSLLeague("")).toBe(false);
		expect(centersNonNWSLLeague(undefined)).toBe(false);
	});

	it("does not treat the WSL inside NWSL as a foreign-league hit", () => {
		expect(centersNonNWSLLeague("Big NWSL transfer news today")).toBe(false);
	});
});

// ── B3b: club-news discovery helpers ──────────────────────────────────────────

describe("extractArticleLinks", () => {
	const html = `
		<a href="/news/">News</a>
		<a href="/news/index">Index</a>
		<a href="/news/match-day-thread-vs-courage">Article A</a>
		<a href="/news/club-signs-new-keeper">Article B</a>
		<a href="/news/tag/transfers">Tag</a>
		<a href="/news/author/jane-doe">Author</a>
		<a href="/news/page/2">Page 2</a>
		<a href="/news/match-day-thread-vs-courage">Dup of A</a>
		<a href="https://www.thorns.com/news/away-from-home-origin-ok">Absolute same-origin</a>
		<a href="https://evil.example.com/news/not-ours">Other origin</a>
		<a href="/schedule">Schedule</a>`;
	const links = extractArticleLinks(html, "https://www.thorns.com/news", "/news/");

	it("keeps direct-child article slugs only", () => {
		expect(links).toContain("https://www.thorns.com/news/match-day-thread-vs-courage");
		expect(links).toContain("https://www.thorns.com/news/club-signs-new-keeper");
		expect(links).toContain("https://www.thorns.com/news/away-from-home-origin-ok");
	});
	it("drops the index, tag/author/page sections, and other-origin links", () => {
		expect(links.some((l) => l.endsWith("/news/index"))).toBe(false);
		expect(links.some((l) => l.includes("/tag/"))).toBe(false);
		expect(links.some((l) => l.includes("/author/"))).toBe(false);
		expect(links.some((l) => l.includes("/page/"))).toBe(false);
		expect(links.some((l) => l.includes("evil.example.com"))).toBe(false);
		expect(links.some((l) => l.endsWith("/schedule"))).toBe(false);
	});
	it("dedupes", () => {
		const dupes = links.filter((l) => l.endsWith("/news/match-day-thread-vs-courage"));
		expect(dupes.length).toBe(1);
	});
});

describe("extractIndexDates — dates from the index when article pages have none", () => {
	it("reads a visible 'August 2, 2026' inside each card (Gotham/Sanity shape)", () => {
		const html = `
			<a href="/news/gotham-win"><img src="a.jpg"/><div class="date">August 2, 2026</div><h3>Gotham Win</h3></a>
			<a href="/news/gotham-draw"><img src="b.jpg"/><div class="date">August 1, 2026</div><h3>Gotham Draw</h3></a>`;
		const m = extractIndexDates(html, "/news/");
		expect(m.get("/news/gotham-win")).toBe("2026-08-02T12:00:00Z");
		expect(m.get("/news/gotham-draw")).toBe("2026-08-01T12:00:00Z");
	});
	it("reads a hidden FinSweet ISO sort field (Portland/Webflow shape) and abbreviated months", () => {
		const html = `
			<article><a href="/news/thorns-win">Cover</a><a href="/news/thorns-win">Learn More</a>
				<div class="hidden"><div fs-cmssort-field="date" class="meta">2026-07-31</div></div>
				<div class="meta">Jul 31, 2026</div></article>
			<article><a href="/news/thorns-draw">Cover</a>
				<div class="hidden"><div fs-cmssort-field="date" class="meta">2026-07-24</div></div></article>`;
		const m = extractIndexDates(html, "/news/");
		expect(m.get("/news/thorns-win")).toBe("2026-07-31T12:00:00Z");
		expect(m.get("/news/thorns-draw")).toBe("2026-07-24T12:00:00Z");
	});
	it("omits an article with no extractable date, and ignores date-like image filenames", () => {
		const html = `<a href="/news/no-date"><img src="hero-2026-08-15-crop.jpg"/><h3>No Date Here</h3></a>`;
		const m = extractIndexDates(html, "/news/");
		expect(m.has("/news/no-date")).toBe(false);
	});
});

describe("isPlaceholderArticle", () => {
	it("flags stub-site default posts", () => {
		expect(isPlaceholderArticle("Hello world!")).toBe(true);
		expect(isPlaceholderArticle("hello world")).toBe(true);
		expect(isPlaceholderArticle("  Sample Post ")).toBe(true);
		expect(isPlaceholderArticle("Uncategorized")).toBe(true);
	});
	it("passes real headlines through", () => {
		expect(isPlaceholderArticle("Club Signs New Keeper")).toBe(false);
		expect(isPlaceholderArticle("Hello world, here's our season preview")).toBe(false);
	});
});

describe("extractJsonLdArticle", () => {
	it("parses a proper ld+json NewsArticle block", () => {
		const html = `<script type="application/ld+json">
			{"@type":"NewsArticle","headline":"Big Signing","datePublished":"2026-06-10T12:00:00Z","image":"https://x/y.jpg"}
		</script>`;
		const out = extractJsonLdArticle(html);
		expect(out?.headline).toBe("Big Signing");
		expect(out?.datePublished).toBe("2026-06-10T12:00:00Z");
		expect(out?.image).toBe("https://x/y.jpg");
	});
	it("falls back to inline headline/datePublished (MLS platform: no og:, no ld block)", () => {
		const html = `<div>...</div><script>window.__DATA__={"headline":"Houston Dash Sign Graham","datePublished":"2026-06-05T14:00:47.666Z","thumbnailUrl":"https://img/x.jpg"}</script>`;
		const out = extractJsonLdArticle(html);
		expect(out?.headline).toBe("Houston Dash Sign Graham");
		expect(out?.datePublished).toBe("2026-06-05T14:00:47.666Z");
		expect(out?.image).toBe("https://img/x.jpg");
	});
	it("returns undefined when no article metadata is present", () => {
		expect(extractJsonLdArticle("<html><body>nothing</body></html>")).toBeUndefined();
	});
});

// ── B4: reporter-vs-league gate split ─────────────────────────────────────────

describe("decideFeedItem — reporter vs league split", () => {
	const followed = new Set<string>(["WAS"]);
	const generalChatter = { isNWSL: true, teams: [], leagueNews: false }; // a reporter's transfer take

	it("keeps general NWSL reporter chatter when requireLeagueNews is false (reporters)", () => {
		expect(decideFeedItem(generalChatter, followed, { requireLeagueNews: false, failClosed: true }).keep).toBe(true);
	});
	it("drops the same post for official league outlets (requireLeagueNews true)", () => {
		expect(decideFeedItem(generalChatter, followed, { requireLeagueNews: true, failClosed: true }).keep).toBe(false);
	});
	it("still drops non-NWSL posts regardless", () => {
		const offTopic = { isNWSL: false, teams: [], leagueNews: false };
		expect(decideFeedItem(offTopic, followed, { requireLeagueNews: false, failClosed: true }).keep).toBe(false);
	});
	it("still fails closed on an unjudged social post", () => {
		expect(decideFeedItem(undefined, followed, { requireLeagueNews: false, failClosed: true }).keep).toBe(false);
	});
});
