import { describe, it, expect } from "vitest";
import {
	extractArticleLinks,
	isPlaceholderArticle,
	extractJsonLdArticle,
	decideFeedItem,
} from "../src/index";

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
