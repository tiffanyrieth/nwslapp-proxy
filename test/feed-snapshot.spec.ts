// Social feed, "window, not count" + Haiku-when-content-comes-in (2026-10-08). The curated reporter/league
// Bluesky posts are fetched + judged by a 15-min background refresh and ACCUMULATED in a snapshot; /feed only
// reads it. These tests prove: the per-club daily flood guard (incl. the xG bot on a full round), accumulation
// + pruning, stored-verdict decisions, that a new-client /feed makes ZERO outbound calls, and that old builds'
// added-account path still works.
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import worker, {
	capCuratedPerDayPerClub,
	contentGetJSON,
	contentPut,
	curatedBlueskyCards,
	mergeSlotItems,
	refreshBlueskySnapshot,
	resetContentMemo,
} from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const BSKY = "https://public.api.bsky.app";
const AUTHOR_FEED = "/xrpc/app.bsky.feed.getAuthorFeed";
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");

/** `env` with every KV write recorded — the content pipeline must make NONE (docs/decisions.md 2026-10-08:
 *  KV writes are reserved for live matches; content lives in the ContentStore Durable Object). */
function spyEnv(): { env: Env; kvPuts: string[] } {
	const kvPuts: string[] = [];
	const kv = env.FEED_TAGS;
	const FEED_TAGS = new Proxy(kv, {
		get(target, prop) {
			if (prop === "put") return (key: string, ...rest: unknown[]) => {
				kvPuts.push(key);
				return (target.put as (...a: unknown[]) => Promise<void>)(key, ...rest);
			};
			const v = (target as unknown as Record<string | symbol, unknown>)[prop];
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
		},
	});
	return { env: { ...env, FEED_TAGS } as Env, kvPuts };
}

async function get(url: string, e: Env = env): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new IncomingRequest(url), e, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

/** Seed a ContentStore value (where Social snapshots live now). */
async function seed(key: string, value: unknown): Promise<void> {
	const ctx = createExecutionContext();
	expect(await contentPut(env, ctx, [{ key, value: JSON.stringify(value) }])).toBe(true);
	await waitOnExecutionContext(ctx);
}

/** A getAuthorFeed item (an ORIGINAL post) as Bluesky returns it. */
function post(handle: string, rkey: string, text: string, msAgo: number) {
	return {
		post: {
			uri: `at://did:plc:${handle.replace(/\W/g, "")}/app.bsky.feed.post/${rkey}`,
			author: { handle, displayName: handle },
			record: { text, createdAt: iso(msAgo) },
			likeCount: 1,
			repostCount: 0,
		},
	};
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(async () => {
	fetchMock.assertNoPendingInterceptors();
	await env.FEED_TAGS.delete("social:reporter-list");
	resetContentMemo(); // the per-isolate snapshot memo would otherwise leak a snapshot into the next test
});

describe("curated flood guard — per account, per day, per club", () => {
	const card = (handle: string, club: string | undefined, msAgo: number, id: string) => ({
		id, handle, teamAbbreviation: club, timestamp: iso(msAgo),
	});

	it("holds one noisy account to 4 posts a day about ONE club", () => {
		const cards = Array.from({ length: 6 }, (_, i) => card("@noisy.bsky.social", "WAS", i * 60_000, `n${i}`));
		const kept = capCuratedPerDayPerClub(cards);
		expect(kept.length).toBe(4);
		expect(kept.map((c) => c.id)).toEqual(["n0", "n1", "n2", "n3"]); // the newest 4
	});

	it("never blocks the xG bot on a full 8-match day — one summary per club pair, all 8 kept", () => {
		const clubs = ["WAS", "POR", "KC", "ORL", "SD", "SEA", "GFC", "NC"];
		const cards = clubs.map((club, i) => card("@nwslstat.bsky.social", club, i * 30 * 60_000, `x${i}`));
		expect(capCuratedPerDayPerClub(cards).length).toBe(8);
	});

	it("counts days separately and league-wide posts as their own group; handle-less cards pass", () => {
		const cards = [
			...Array.from({ length: 4 }, (_, i) => card("@r.bsky.social", "WAS", i * 60_000, `today${i}`)),
			...Array.from({ length: 4 }, (_, i) => card("@r.bsky.social", "WAS", DAY + i * 60_000, `yday${i}`)),
			...Array.from({ length: 4 }, (_, i) => card("@r.bsky.social", undefined, i * 60_000, `league${i}`)),
			{ id: "article", teamAbbreviation: "WAS", timestamp: iso(0) },
		];
		expect(capCuratedPerDayPerClub(cards as Record<string, unknown>[]).length).toBe(13);
	});
});

describe("snapshot merge — accumulate within the 21-day window", () => {
	it("keeps stored items a re-fetch no longer returns, keeps their stored fields, and prunes past 21 days", () => {
		const stored = [
			{ id: "a", timestamp: iso(2 * DAY), nwslVerdict: { isNWSL: true }, thumbnailURL: "https://img/a.jpg" },
			{ id: "old", timestamp: iso(22 * DAY) },
		];
		const fresh = [{ id: "a", timestamp: iso(2 * DAY), thumbnailURL: undefined, likes: 9 }, { id: "b", timestamp: iso(0) }];
		const out = mergeSlotItems(stored, fresh) as Record<string, unknown>[];
		expect(out.map((i) => i.id)).toEqual(["b", "a"]); // newest first; "old" pruned
		expect(out[1].nwslVerdict).toEqual({ isNWSL: true }); // stored verdict kept
		expect(out[1].thumbnailURL).toBe("https://img/a.jpg"); // an undefined fresh field never erases it
		expect(out[1].likes).toBe(9);
		expect(mergeSlotItems([], [{ id: "1", timestamp: iso(0) }, { id: "2", timestamp: iso(1000) }], 1).length).toBe(1);
	});
});

describe("curatedBlueskyCards — decisions from STORED verdicts (no Haiku)", () => {
	const snap = {
		v: 1 as const, at: Date.now(), updatedAt: Date.now(),
		handles: {
			"rep.bsky.social": { kind: "reporter" as const, fetchedAt: Date.now(), ok: true, items: [
				{ card: { id: "r1", handle: "@rep.bsky.social", bodyText: "Spirit win", timestamp: iso(0) }, verdict: { id: "r1", isNWSL: true, teams: ["WAS"], leagueNews: false } },
				{ card: { id: "r2", handle: "@rep.bsky.social", bodyText: "Thorns news", timestamp: iso(0) }, verdict: { id: "r2", isNWSL: true, teams: ["POR"], leagueNews: false } },
				{ card: { id: "r3", handle: "@rep.bsky.social", bodyText: "unjudged", timestamp: iso(0) } },
			] },
			"lg.bsky.social": { kind: "league" as const, fetchedAt: Date.now(), ok: true, items: [
				{ card: { id: "l1", handle: "@lg.bsky.social", bodyText: "chatter", timestamp: iso(0) }, verdict: { id: "l1", isNWSL: true, teams: [], leagueNews: false } },
				{ card: { id: "l2", handle: "@lg.bsky.social", bodyText: "Schedule release", timestamp: iso(0) }, verdict: { id: "l2", isNWSL: true, teams: [], leagueNews: true } },
			] },
		},
	};
	const active = [{ handle: "rep.bsky.social", kind: "reporter" as const }, { handle: "lg.bsky.social", kind: "league" as const }];

	it("keeps followed-club + genuine league news, tags the club, fails unjudged CLOSED", () => {
		const out = curatedBlueskyCards(snap, active, ["WAS"]);
		expect(out.map((c) => c.id).sort()).toEqual(["l2", "r1"]);
		expect(out.find((c) => c.id === "r1")?.teamAbbreviation).toBe("WAS");
		expect(out.find((c) => c.id === "l2")?.isLeague).toBe(true);
	});

	it("a muted default (absent from `active`) contributes nothing", () => {
		expect(curatedBlueskyCards(snap, [active[1]], ["WAS"]).map((c) => c.id)).toEqual(["l2"]);
	});
});

describe("refreshBlueskySnapshot — fetched + judged in the background, accumulated", () => {
	it("accumulates posts across runs and keeps them when an account's newest page moves on", async () => {
		await env.FEED_TAGS.put("social:reporter-list", JSON.stringify([{ handle: "rep.bsky.social", kind: "reporter" }]));
		const feed = (items: unknown[]) => JSON.stringify({ feed: items });
		fetchMock.get(BSKY).intercept({ path: (p) => p.startsWith(AUTHOR_FEED) })
			.reply(200, feed([post("rep.bsky.social", "p1", "first post", 3_600_000)]), { headers: { "Content-Type": "application/json" } });
		const spy = spyEnv();
		const ctx1 = createExecutionContext();
		await refreshBlueskySnapshot(spy.env, ctx1);
		await waitOnExecutionContext(ctx1);

		// Next run: the account's newest page only shows the NEW post — the first one must survive.
		fetchMock.get(BSKY).intercept({ path: (p) => p.startsWith(AUTHOR_FEED) })
			.reply(200, feed([post("rep.bsky.social", "p2", "second post", 0)]), { headers: { "Content-Type": "application/json" } });
		const ctx2 = createExecutionContext();
		const r = await refreshBlueskySnapshot(spy.env, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(r.posts).toBe(2);
		expect(spy.kvPuts).toEqual([]); // the snapshot lives in the ContentStore — zero KV writes
		resetContentMemo();
		const snap = (await contentGetJSON(env, undefined, "social:bluesky-snapshot")) as { handles: Record<string, { items: { card: { id: string } }[] }> };
		expect(snap.handles["rep.bsky.social"].items.map((i) => i.card.id).sort()).toEqual(["bsky-p1", "bsky-p2"]);
	});
});

describe("/feed — what a request does", () => {
	it("a new client (caps=devicebsky) with snapshots present makes ZERO outbound calls", async () => {
		await env.FEED_TAGS.put("social:reporter-list", JSON.stringify([{ handle: "rep.bsky.social", kind: "reporter" }]));
		await seed("social:bluesky-snapshot", {
			v: 1, at: Date.now(), updatedAt: Date.now(),
			handles: { "rep.bsky.social": { kind: "reporter", fetchedAt: Date.now(), ok: true, items: [
				{ card: { id: "bsky-r1", layout: "blueskyReporter", handle: "@rep.bsky.social", bodyText: "Spirit analysis", timestamp: iso(0) },
					verdict: { id: "bsky-r1", isNWSL: true, teams: ["WAS"], leagueNews: false } },
			] } },
		});
		await seed("social:sources-snapshot", { v: 1, at: Date.now(), updatedAt: Date.now(), sources: {} });
		// No interceptors registered + disableNetConnect: ANY outbound fetch (Bluesky, Haiku, OG) would throw.
		const spy = spyEnv();
		const res = await get("https://dc-a.test/feed?teams=WAS&caps=podcast,devicebsky&handles=someone.bsky.social&muted=rep.bsky.social", spy.env);
		expect(res.status).toBe(200);
		expect(spy.kvPuts).toEqual([]); // a /feed request writes nothing to KV
		const cards = (await res.json()) as { id: string; teamAbbreviation?: string }[];
		// The curated card is there (mutes + adds are ignored for new clients — the app applies them).
		expect(cards.map((c) => c.id)).toContain("bsky-r1");
		expect(cards.find((c) => c.id === "bsky-r1")?.teamAbbreviation).toBe("WAS");
	});

	it("an old client's added account is still fetched live and served unfiltered (compat path)", async () => {
		await env.FEED_TAGS.put("social:reporter-list", JSON.stringify([{ handle: "rep.bsky.social", kind: "reporter" }]));
		await seed("social:bluesky-snapshot", { v: 1, at: Date.now(), updatedAt: Date.now(), handles: {} });
		await seed("social:sources-snapshot", { v: 1, at: Date.now(), updatedAt: Date.now(), sources: {} });
		fetchMock.get(BSKY).intercept({ path: (p) => p.startsWith(AUTHOR_FEED) && p.includes("added.bsky.social") })
			.reply(200, JSON.stringify({ feed: [post("added.bsky.social", "u1", "anything at all", 0)] }), { headers: { "Content-Type": "application/json" } });
		const res = await get("https://dc-b.test/feed?teams=WAS&handles=added.bsky.social");
		const cards = (await res.json()) as { id: string; userAdded?: boolean }[];
		expect(cards.find((c) => c.id === "bsky-u1")?.userAdded).toBe(true);
	});
});
