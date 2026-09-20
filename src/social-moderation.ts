// ── Social feed IMAGE MODERATION (low-grade safety backstop, 2026-09-20) ────────────────
// The app republishes player Instagram posts as cards UNDER EACH PLAYER'S NAME — the app is a
// publisher, so the THUMBNAIL rendered in-app reads as endorsed content. moderateFeedImages runs
// ONCE per image at SCRAPE time (called from refreshSocialCache, before the snapshot is written to
// KV) — NEVER on user-open — and caches each verdict, so cost is flat with scrape volume, not users.
//
// It is a LOW-GRADE backstop over already-curated pro-athlete accounts: it flags only egregious
// content (explicit sexual/nudity, graphic violence/gore) and FAILS OPEN (keeps the card) on any
// error, missing binding, or ambiguity — a transient AI/fetch hiccup must NEVER blank the Feed.
//
// SCOPE: the still THUMBNAIL only (owner's concern = what shows in-app). A video's full content is
// out of scope — the video never renders in-app (it opens on Instagram); we scan its poster frame
// like any photo. Model = Cloudflare Workers AI vision (Neurons; sits inside the free daily tier).
//
// Isolated as a dependency-injected leaf so it unit-tests without Workers AI / KV / the network
// (see test/social-image-moderation.test.ts); index.ts wires the real env.AI + FEED_TAGS +
// fetchBounded-based image fetcher + emitDiag.

export const IMGMOD_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const IMGMOD_TTL = 30 * 24 * 3600; // a post's image is immutable → cache the verdict ~30d
const IMGMOD_CONCURRENCY = 8; // in-flight checks; keeps under workerd's ~6-outbound lane pressure while I/O-bound
const IMGMOD_MAX_SCANS_PER_RUN = 80; // NEW-image scan budget/run: bounds cron lifetime + KV writes (cached hits are free)
const IMGMOD_TIME_BUDGET_MS = 20_000; // stop scanning NEW images past this; remainder KEPT (fail-open), scanned a later run
const IMGMOD_PROMPT =
	"You are a narrow content-safety check for a women's soccer fan app that reposts players' public " +
	"Instagram photos. Reply with ONLY one word: UNSAFE if the image shows explicit sexual content or " +
	"nudity, or graphic violence or gore. Otherwise reply SAFE. Normal athlete, sport, training, " +
	"celebration, fashion, family, and lifestyle photos are SAFE.";

/** Platform dependencies injected by index.ts (mocked in tests). */
export interface ImageModDeps {
	/** Workers AI binding (env.AI). Undefined ⇒ the whole pass is skipped (fail open). */
	ai?: { run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };
	/** KV verdict cache read (env.FEED_TAGS.get). */
	kvGet(key: string): Promise<string | null>;
	/** KV verdict cache write (env.FEED_TAGS.put). */
	kvPut(key: string, value: string, opts: { expirationTtl: number }): Promise<void>;
	/** Fetch the image bytes (bounded + size-capped); null on any failure ⇒ fail open. */
	fetchImageBytes(url: string): Promise<Uint8Array | null>;
	/** Optional diagnostics sink (index wires emitDiag; undefined in tests / when there's no ctx). */
	diag?(kind: string, detail: string): void;
}

/** Vision safety check on one image's bytes. true=safe, false=unsafe, or null when it can't decide
 *  (AI error / ambiguous reply) — the caller fails open on null. */
async function classifyImageSafe(ai: NonNullable<ImageModDeps["ai"]>, bytes: Uint8Array): Promise<boolean | null> {
	try {
		const out = await ai.run(IMGMOD_MODEL, { prompt: IMGMOD_PROMPT, image: Array.from(bytes), max_tokens: 12 });
		const text = String((out as { response?: unknown })?.response ?? "").toUpperCase();
		if (text.includes("UNSAFE")) return false; // check UNSAFE first — it CONTAINS "SAFE" as a substring
		if (text.includes("SAFE")) return true;
		return null; // ambiguous → fail open
	} catch {
		return null; // AI error → fail open
	}
}

/** Low-grade image-safety pass over player FEED cards before they hit the snapshot. Drops a card
 *  whose thumbnail trips the vision check; FAILS OPEN (keeps the card) on any error / ambiguity /
 *  missing binding. Verdicts cache per image (~30d) so each image is scanned once; a per-run scan +
 *  wall-clock budget bounds the cron's lifetime and KV writes (uncached images beyond the budget
 *  are kept and picked up a later run). Emits loud diagnostics — no silent failure. */
export async function moderateFeedImages(cards: unknown[], deps: ImageModDeps): Promise<unknown[]> {
	if (cards.length === 0) return cards;
	if (!deps.ai) {
		deps.diag?.("imageModerationSkip", "AI binding unset — feed served unmoderated");
		return cards; // fail open: no binding → never blank the feed
	}
	const ai = deps.ai;

	const decisions = new Array<boolean>(cards.length).fill(true); // default KEEP (fail open)
	const dropDetails: string[] = [];
	let idx = 0, newScans = 0, scanned = 0, dropped = 0, errored = 0, deferred = 0;
	const start = Date.now();

	// Single-threaded async: idx/newScans increments between awaits are atomic (no true parallelism).
	async function worker(): Promise<void> {
		while (idx < cards.length) {
			const i = idx++;
			const c = cards[i] as { url?: string; thumbnailURL?: string; handle?: string };
			const img = c.thumbnailURL;
			if (!img) continue; // nothing to check → keep
			const cacheKey = `imgmod:${c.url ?? img}`;
			let cached: string | null = null;
			try { cached = await deps.kvGet(cacheKey); } catch { /* KV read miss → treat as uncached */ }
			if (cached === "unsafe") { decisions[i] = false; dropped++; if (c.handle) dropDetails.push(c.handle); continue; }
			if (cached === "safe") continue; // already verified → keep
			// Cache miss: gate NEW scans by count + wall-clock so the cron stays within its lifetime.
			if (newScans >= IMGMOD_MAX_SCANS_PER_RUN || Date.now() - start > IMGMOD_TIME_BUDGET_MS) { deferred++; continue; }
			newScans++; scanned++;
			const bytes = await deps.fetchImageBytes(img);
			if (!bytes) { errored++; continue; } // fetch fail → keep, don't cache (retry next run)
			const safe = await classifyImageSafe(ai, bytes);
			if (safe === null) { errored++; continue; } // AI error/ambiguous → keep, don't cache
			try { await deps.kvPut(cacheKey, safe ? "safe" : "unsafe", { expirationTtl: IMGMOD_TTL }); } catch { /* KV write budget — verdict still applied below */ }
			if (!safe) { decisions[i] = false; dropped++; if (c.handle) dropDetails.push(c.handle); }
		}
	}
	await Promise.all(Array.from({ length: Math.min(IMGMOD_CONCURRENCY, cards.length) }, () => worker()));

	const kept = cards.filter((_, i) => decisions[i]);
	if (deps.diag) {
		if (dropped > 0) deps.diag("imageModerationDrop", `${dropped}: ${dropDetails.slice(0, 5).join(",")}`);
		if (errored > 0) deps.diag("imageModerationError", `${errored} unresolved, kept (fail-open)`);
		deps.diag("imageModerationRun", `scanned=${scanned} dropped=${dropped} err=${errored} deferred=${deferred} kept=${kept.length}/${cards.length}`);
	}
	return kept;
}
