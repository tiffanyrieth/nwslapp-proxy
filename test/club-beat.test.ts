import { describe, it, expect } from "vitest";
import {
	BEAT_SEED,
	NEWS_FEED_SEED,
	CLUB_ABBRS,
	applyBeatChanges,
	beatSourceProblem,
	beatSourcesFor,
	isValidBeatList,
	isValidNewsFeeds,
	parseBeehiivArchive,
	parseWpJsonPosts,
	sourceTier,
	titlePasses,
	type BeatSource,
} from "../src/club-beat";

describe("Club Beat seed", () => {
	it("every seed source validates", () => {
		for (const s of BEAT_SEED) expect(beatSourceProblem(s), s.id).toBeNull();
		expect(isValidBeatList(BEAT_SEED)).toBe(true);
	});
	it("ids are unique and every club abbr is real", () => {
		const ids = BEAT_SEED.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const s of BEAT_SEED) expect(CLUB_ABBRS.has(s.abbr)).toBe(true);
	});
	it("personal Bluesky accounts run the NWSL gate (mixed)", () => {
		for (const id of ["la-damian-calhoun", "kc-daniel-sperry", "lou-brendan-devine", "was-ella-brockway"]) {
			expect(BEAT_SEED.find((s) => s.id === id)?.mixed, id).toBe(true);
		}
	});
	it("held-out podcast-promo / short-reaction accounts are NOT in the seed (owner decision 17)", () => {
		const handles = BEAT_SEED.map((s) => s.handle).filter(Boolean);
		for (const h of ["heyspirits.bsky.social", "blfcswandive.bsky.social", "lionspitch.bsky.social"]) expect(handles).not.toContain(h);
	});
	it("news seed validates and keeps the original four outlets first", () => {
		expect(isValidNewsFeeds(NEWS_FEED_SEED)).toBe(true);
		expect(NEWS_FEED_SEED.slice(0, 4).map((f) => f.source)).toEqual(["The Equalizer", "Just Women's Sports", "All For XI", "The Guardian"]);
	});
});

describe("beatSourcesFor - cost scales with follows", () => {
	it("returns only the requested clubs' sources", () => {
		const got = beatSourcesFor(BEAT_SEED, ["GFC", "SEA"]);
		expect(got.length).toBeGreaterThan(0);
		expect(new Set(got.map((s) => s.abbr))).toEqual(new Set(["GFC", "SEA"]));
	});
	it("no follows -> no sources", () => {
		expect(beatSourcesFor(BEAT_SEED, [])).toEqual([]);
	});
});

describe("titlePasses", () => {
	it("case-insensitive substring", () => {
		expect(titlePasses("NWSL Crunchtime: Did the Denver Summit blow it?", "nwsl")).toBe(true);
		expect(titlePasses("Are Arsenal out of the WSL title race?", "NWSL")).toBe(false);
	});
	it("no filter passes everything", () => {
		expect(titlePasses("anything", undefined)).toBe(true);
	});
});

describe("beatSourceProblem / validation", () => {
	it("rejects an unknown club, bad handle, non-https url, unknown kind", () => {
		expect(beatSourceProblem({ id: "xx-test", abbr: "NYC", name: "x", kind: "rss", url: "https://a.b/feed" })).toMatch(/club/);
		expect(beatSourceProblem({ id: "xx-test", abbr: "GFC", name: "x", kind: "bluesky", handle: "nodot" })).toMatch(/handle/);
		expect(beatSourceProblem({ id: "xx-test", abbr: "GFC", name: "x", kind: "rss", url: "http://a.b/feed" })).toMatch(/url/);
		expect(beatSourceProblem({ id: "xx-test", abbr: "GFC", name: "x", kind: "tiktok" as BeatSource["kind"], url: "https://a.b" })).toMatch(/kind/);
	});
	it("a list with ONE bad entry is invalid as a whole (never serve a partial list)", () => {
		expect(isValidBeatList([...BEAT_SEED, { id: "bad", abbr: "ZZZ", name: "x", kind: "rss", url: "https://a.b" }])).toBe(false);
		expect(isValidBeatList([])).toBe(false);
	});
});

describe("applyBeatChanges - the guarded write path", () => {
	const base: BeatSource[] = [
		{ id: "gfc-a", abbr: "GFC", name: "A", kind: "rss", url: "https://a.example/feed" },
		{ id: "gfc-b", abbr: "GFC", name: "B", kind: "bluesky", handle: "b.bsky.social" },
	];
	it("drops then adds, reporting each", () => {
		const r = applyBeatChanges(base, {
			drop: ["gfc-a", "nope"],
			add: [{ id: "was-c", abbr: "was", name: "C", kind: "bluesky", handle: "@C.bsky.social", mixed: true }],
		});
		expect(r.dropped).toEqual(["gfc-a"]);
		expect(r.added).toEqual(["was-c"]);
		expect(r.rejected).toEqual([{ id: "nope", reason: "not on the list" }]);
		const c = r.list.find((s) => s.id === "was-c");
		expect(c).toMatchObject({ abbr: "WAS", handle: "c.bsky.social", mixed: true });
	});
	it("rejects duplicate id and duplicate source on the same club", () => {
		const r = applyBeatChanges(base, {
			add: [
				{ id: "gfc-a", abbr: "GFC", name: "dup id", kind: "rss", url: "https://z.example/feed" },
				{ id: "gfc-z", abbr: "GFC", name: "dup source", kind: "bluesky", handle: "b.bsky.social" },
			],
		});
		expect(r.added).toEqual([]);
		expect(r.rejected.map((x) => x.reason)).toEqual(["id already on the list", "same source already on this club"]);
	});
	it("per-club anti-spree rail", () => {
		const r = applyBeatChanges(base, { add: [{ id: "gfc-c", abbr: "GFC", name: "C", kind: "rss", url: "https://c.example/feed" }] }, 2);
		expect(r.added).toEqual([]);
		expect(r.rejected[0].reason).toMatch(/per-club rail/);
	});
	it("does not mutate the input list", () => {
		const copy = JSON.stringify(base);
		applyBeatChanges(base, { drop: ["gfc-a"] });
		expect(JSON.stringify(base)).toBe(copy);
	});
});

describe("parseBeehiivArchive", () => {
	const html =
		`<html><script>window.__remixContext = {"state":{"loaderData":{"routes/archive":{"paginatedPosts":{"pagination":{"page":1},"posts":[` +
		`{"id":"1","web_title":"Week 25 recap: Lucky break","web_subtitle":"It might not have been pretty, but the Bats get the job done.","override_scheduled_at":"2026-09-23T18:00:08.470Z","slug":"week-25-recap-lucky-break","is_premium":false,"image_url":"https://img.example/25.jpg","note":"brackets ] [ and \\"quotes\\" inside a string"},` +
		`{"id":"2","web_title":"2026 nwsl matchday 26: g+ pass networks \\u0026 shot charts","web_subtitle":"","override_scheduled_at":null,"publish_date":"2026-09-29T12:00:00Z","slug":"md-26","is_premium":false,"image_url":""},` +
		`{"id":"3","web_title":"Paid post","slug":"paid","is_premium":true,"override_scheduled_at":"2026-09-20T00:00:00Z"}` +
		`]}}}}};</script></html>`;
	it("extracts title, link, date, subtitle, image; skips premium; unescapes JSON", () => {
		const items = parseBeehiivArchive(html, "https://thebatsignal.beehiiv.com/");
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({
			title: "Week 25 recap: Lucky break",
			link: "https://thebatsignal.beehiiv.com/p/week-25-recap-lucky-break",
			pubDate: "2026-09-23T18:00:08.470Z",
			description: "It might not have been pretty, but the Bats get the job done.",
			image: "https://img.example/25.jpg",
		});
		expect(items[1].title).toBe("2026 nwsl matchday 26: g+ pass networks & shot charts");
		expect(items[1].pubDate).toBe("2026-09-29T12:00:00Z"); // falls back past a null override
		expect(items[1].description).toBeUndefined();
		expect(items[1].image).toBeUndefined();
	});
	it("page-builder theme: posts under a block's data.posts (the btvc layout)", () => {
		const html =
			`<script>window.__remixContext = {"blocks":[{"type":"post","attrs":{"id":"x","data":{"posts":[` +
			`{"id":"1","web_title":"2026 nwsl matchday 26: g+ pass networks","web_subtitle":"","override_scheduled_at":"2026-09-29T23:35:42.289Z","slug":"md-26","is_premium":false,"image_url":"https://img.example/26.png","authors":[{"name":"andr\u00e9"}]}` +
			`]}}}],"other":{"posts":[]}};</script>`;
		const items = parseBeehiivArchive(html, "https://btvc.beehiiv.com");
		expect(items).toHaveLength(1);
		expect(items[0].link).toBe("https://btvc.beehiiv.com/p/md-26");
		expect(items[0].pubDate).toBe("2026-09-29T23:35:42.289Z");
	});
	it("no archive payload -> []", () => {
		expect(parseBeehiivArchive("<html>nothing</html>", "https://x.beehiiv.com")).toEqual([]);
	});
});

describe("parseWpJsonPosts", () => {
	it("maps WP REST posts; date_gmt becomes UTC", () => {
		const items = parseWpJsonPosts([
			{
				date_gmt: "2026-09-27T03:29:43",
				link: "https://www.ocregister.com/2026/09/26/x/",
				title: { rendered: "Maiara Niehues&#8217; late goal lifts Angel City" },
				excerpt: { rendered: "<p>Angel City beat the Spirit.</p>" },
				jetpack_featured_media_url: "https://img.example/a.jpg",
			},
			{ title: { rendered: "no link" } },
		]);
		expect(items).toHaveLength(1);
		expect(items[0].pubDate).toBe("2026-09-27T03:29:43Z");
		expect(items[0].image).toBe("https://img.example/a.jpg");
		expect(items[0].title).toContain("Niehues"); // entity decoding happens in index.ts
	});
	it("non-array -> []", () => {
		expect(parseWpJsonPosts({ code: "rest_forbidden" })).toEqual([]);
	});
});

describe("sourceTier", () => {
	const now = Date.parse("2026-09-30T12:00:00Z");
	const day = 86_400_000;
	it("tiers on the newest item (same thresholds as reporter Bluesky)", () => {
		expect(sourceTier(now - 2 * day, now, true)).toBe("ok");
		expect(sourceTier(now - 20 * day, now, true)).toBe("cooling");
		expect(sourceTier(now - 40 * day, now, true)).toBe("dormant");
		expect(sourceTier(null, now, true)).toBe("empty");
		expect(sourceTier(null, now, false)).toBe("dead");
	});
});
