// CONTENT STORE (2026-10-08) — non-live content state lives in a Durable Object, never KV.
// docs/decisions.md "KV writes are reserved for live matches": these pin the store's KV-like semantics, the
// read-through migration (a KV READ copied into the store, never a KV write), and that a write the store
// can't take is reported — it must never fall back to KV.
import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, afterEach } from "vitest";
import { contentGet, contentGetJSON, contentPut, contentWrittenAt, resetContentMemo } from "../src/index";
import { ContentStore, CONTENT_GZIP_MIN } from "../src/content-store";

function stub() {
	const ns = env.CONTENT_STORE!;
	return ns.get(ns.idFromName("content"));
}

function kvSpy(base: Env = env): { env: Env; kvPuts: string[] } {
	const kvPuts: string[] = [];
	const kv = base.FEED_TAGS;
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
	return { env: { ...base, FEED_TAGS } as Env, kvPuts };
}

afterEach(() => resetContentMemo());

describe("ContentStore — KV semantics in a Durable Object", () => {
	it("round-trips small (raw) and large (gzipped) values; missing keys read null", async () => {
		const big = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, text: "Spirit win at Audi Field" })) });
		expect(big.length).toBeGreaterThan(CONTENT_GZIP_MIN);
		await stub().putMany([{ key: "sv3-a", value: '{"id":"a","isNWSL":true}' }, { key: "snap", value: big }]);
		const got = await stub().getMany(["sv3-a", "snap", "nope"]);
		expect(got["sv3-a"]).toBe('{"id":"a","isNWSL":true}');
		expect(got.snap).toBe(big);
		expect(got.nope).toBeNull();
	});

	it("expired rows read as missing and are pruned on a later write", async () => {
		await runInDurableObject(stub(), async (_obj: ContentStore, state) => {
			state.storage.sql.exec(
				"INSERT OR REPLACE INTO kv (key, value, gz, expires_at, written_at) VALUES (?, ?, 0, ?, ?)",
				"ogn-old", new TextEncoder().encode("{}"), Date.now() - 1000, Date.now() - 2000,
			);
		});
		expect((await stub().getMany(["ogn-old"]))["ogn-old"]).toBeNull();
		await stub().putMany([{ key: "x", value: "1", ttlSec: 60 }]);
		const left = await runInDurableObject(stub(), async (_obj: ContentStore, state) =>
			state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE key = 'ogn-old'").one().n);
		expect(left).toBe(0);
	});

	it("writtenAt answers without shipping the value", async () => {
		const before = Date.now();
		await stub().putMany([{ key: "social:sources-snapshot", value: "{}" }]);
		const at = (await stub().writtenAt(["social:sources-snapshot", "never"]));
		expect(at["social:sources-snapshot"]).toBeGreaterThanOrEqual(before);
		expect(at.never).toBeNull();
	});
});

describe("contentGet / contentPut — the only door, and it never writes KV", () => {
	it("a content write goes to the store and makes ZERO KV writes", async () => {
		const spy = kvSpy();
		const ctx = createExecutionContext();
		expect(await contentPut(spy.env, ctx, [{ key: "nv3-1", value: '{"id":"1","isNWSL":true,"teams":[]}', ttlSec: 60 }])).toBe(true);
		await waitOnExecutionContext(ctx);
		expect(spy.kvPuts).toEqual([]);
		expect((await stub().getMany(["nv3-1"]))["nv3-1"]).toContain('"isNWSL":true');
	});

	it("read-through migration: a value still in KV is READ and copied into the store — never re-written to KV", async () => {
		await env.FEED_TAGS.put("sv3-legacy", '{"id":"legacy","isNWSL":true,"teams":["WAS"],"leagueNews":false}');
		const spy = kvSpy();
		const ctx = createExecutionContext();
		const v = await contentGetJSON<{ teams: string[] }>(spy.env, ctx, "sv3-legacy");
		await waitOnExecutionContext(ctx);
		expect(v?.teams).toEqual(["WAS"]);
		expect(spy.kvPuts).toEqual([]);
		expect((await stub().getMany(["sv3-legacy"]))["sv3-legacy"]).toContain('"WAS"');
		await env.FEED_TAGS.delete("sv3-legacy");
	});

	it("no store → the write is REPORTED (false), and nothing falls back to KV", async () => {
		const spy = kvSpy({ ...env, CONTENT_STORE: undefined } as Env);
		const ctx = createExecutionContext();
		expect(await contentPut(spy.env, ctx, [{ key: "clubnews-WAS", value: "[]" }])).toBe(false);
		await waitOnExecutionContext(ctx);
		expect(spy.kvPuts).toEqual([]);
	});

	it("no store → reads fall back to a KV READ", async () => {
		await env.FEED_TAGS.put("social:podcasts-snapshot", '{"v":1}');
		const noStore = { ...env, CONTENT_STORE: undefined } as Env;
		const got = await contentGet(noStore, undefined, ["social:podcasts-snapshot"]);
		expect(got.get("social:podcasts-snapshot")).toBe('{"v":1}');
		await env.FEED_TAGS.delete("social:podcasts-snapshot");
	});

	it("contentWrittenAt is null for a never-written snapshot (so it's due) and set after a write", async () => {
		const ctx = createExecutionContext();
		expect(await contentWrittenAt(env, ctx, "social:bluesky-snapshot")).toBeNull();
		await contentPut(env, ctx, [{ key: "social:bluesky-snapshot", value: "{}" }]);
		expect(await contentWrittenAt(env, ctx, "social:bluesky-snapshot")).not.toBeNull();
		await waitOnExecutionContext(ctx);
	});
});
