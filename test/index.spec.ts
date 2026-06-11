import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { chooseSummaryTTL, dedupeByContent } from "../src/index";

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
