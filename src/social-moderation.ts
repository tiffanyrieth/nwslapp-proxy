// ── Social feed IMAGE MODERATION (low-grade safety backstop) ────────────────────────────
// The app republishes player Instagram posts as cards UNDER EACH PLAYER'S NAME — the app is a
// publisher, so the THUMBNAIL rendered in-app reads as endorsed content. This flags egregious
// content (explicit sexual/nudity, graphic violence/gore) and removes it from the snapshot the app
// reads, so an unsafe image never reaches the app.
//
// DESIGN (2026-09-20, reworked for the Workers FREE tier — 50 subrequests + 10ms CPU per invocation):
// moderation is DECOUPLED from the scrape. The scrape writes the snapshot (carrying prior verdicts
// forward so nothing is re-checked); a small batch runs on the existing 5-min cron (gated ~30 min),
// reading the CACHED snapshot and classifying a few not-yet-judged images per pass — NO extra Apify.
// Verdicts live IN the snapshot (`card.mod === "ok"`); unsafe cards are dropped from it. A whole
// batch's results save in ONE snapshot write (KV-write-frugal). FAILS OPEN: any error/missing binding
// leaves a card unjudged (still served) — a hiccup never blanks the feed.
//
// SCOPE: the still THUMBNAIL only. A video's full content is out of scope — it never renders in-app
// (opens on Instagram); we scan its poster frame like any photo. Model = Cloudflare Workers AI vision.
//
// Isolated as a dependency-injected leaf so it unit-tests without Workers AI / the network
// (see test/social-image-moderation.test.ts); index.ts wires env.AI + a fetchBounded image fetcher +
// emitDiag + the Supabase drop-log.

export const IMGMOD_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
// Per-pass batch of NEW images to classify. TUNED for the FREE tier's 10ms CPU limit (each image
// costs a byte→array conversion) AND 50-subrequest cap (2 subrequests/image). Conservative on purpose;
// lower it if `exceededCpu`/subrequest kills ever show in diagnostics. Steady state has few new images
// per scrape, so this only paces the one-time backlog. It rides a ~30-min gate on the 5-min cron.
export const IMGMOD_BATCH = 1;

const IMGMOD_PROMPT =
	"You are a narrow content-safety check for a women's soccer fan app that reposts players' public " +
	"Instagram photos. If the image shows explicit sexual content or nudity, or graphic violence or gore, " +
	"reply UNSAFE followed by ONE word for the category (nudity, sexual, violence, or gore). Otherwise reply " +
	"SAFE. Normal athlete, sport, training, celebration, fashion, family, and lifestyle photos are SAFE.";

/** A social feed card as far as moderation cares. `mod === "ok"` = judged safe (or nothing to judge);
 *  absent = not yet judged. Unsafe cards are removed from the array entirely. */
type ModCard = { id?: string; url?: string; thumbnailURL?: string; handle?: string; authorName?: string; mod?: string };

/** Platform dependencies injected by index.ts (mocked in tests). */
export interface ModDeps {
	/** Workers AI binding (env.AI). Undefined ⇒ nothing is classified (cards stay unjudged = served). */
	ai?: { run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };
	/** Fetch the image bytes (bounded + size-capped); null on any failure ⇒ leave unjudged (retry). */
	fetchImageBytes(url: string): Promise<Uint8Array | null>;
	/** Optional diagnostics sink (index wires emitDiag). */
	diag?(kind: string, detail: string): void;
	/** Optional per-drop hook — fires once per card dropped as unsafe (index → a Supabase log row). */
	onDrop?(rec: { postId: string; postUrl: string; imageUrl: string; name: string; handle: string; reason: string }): void;
}

/** Vision safety check on one image's bytes. `{ safe, reason }` (reason = the model's short category on
 *  an unsafe verdict), or null when it can't decide (AI error / ambiguous) — the caller fails open. */
async function classifyImage(ai: NonNullable<ModDeps["ai"]>, bytes: Uint8Array): Promise<{ safe: boolean; reason: string } | null> {
	try {
		const out = await ai.run(IMGMOD_MODEL, { prompt: IMGMOD_PROMPT, image: Array.from(bytes), max_tokens: 16 });
		const up = String((out as { response?: unknown })?.response ?? "").trim().toUpperCase();
		if (up.includes("UNSAFE")) { // check UNSAFE first — it CONTAINS "SAFE" as a substring
			const m = up.match(/UNSAFE[:\s]+([A-Z]+)/); // capture the trailing category word, if any
			return { safe: false, reason: (m?.[1] ?? "unspecified").toLowerCase() };
		}
		if (up.includes("SAFE")) return { safe: true, reason: "safe" };
		return null; // ambiguous → fail open
	} catch {
		return null; // AI error → fail open
	}
}

/** True when a card still needs judging: it has an image, isn't marked ok, and isn't approved. */
function needsJudging(c: ModCard, approved: Set<string>): boolean {
	return !!c.thumbnailURL && c.mod !== "ok" && !(c.url != null && approved.has(c.url));
}

/** Carry verdicts forward onto a freshly-scraped card array so re-scrapes don't re-check known posts.
 *  A fresh card is marked `mod:"ok"` if the SAME post URL was ok in the prior snapshot, or is on the
 *  approve allowlist, or has no image to judge. Mutates `fresh` in place. Called at scrape time. */
export function carryForwardVerdicts(fresh: unknown[], prior: unknown[], approved: Set<string>): void {
	const okUrls = new Set<string>();
	for (const p of prior) {
		const q = p as ModCard;
		if (q.mod === "ok" && q.url) okUrls.add(q.url);
	}
	for (const f of fresh) {
		const g = f as ModCard;
		if (!g.thumbnailURL || (g.url != null && (okUrls.has(g.url) || approved.has(g.url)))) g.mod = "ok";
	}
}

export interface ModResult { cards: unknown[]; processed: number; dropped: number; remaining: number; changed: boolean; }

/** Moderate a batch of not-yet-judged cards from a CACHED snapshot. Classifies up to `batchSize` new
 *  images (sequential — batch is tiny, so CPU, not wall-time, is the binding limit on free), marks safe
 *  ones `mod:"ok"`, and DROPS unsafe ones from the returned array (+ onDrop). Everything else is passed
 *  through untouched. FAILS OPEN: no AI, a fetch failure, an AI error, or an ambiguous reply all leave a
 *  card unjudged (still served), to be retried a later pass. Returns the (possibly shortened) array plus
 *  counters; the caller writes it back to KV only when `changed`. */
export async function moderateSnapshotBatch(cards: unknown[], approved: Set<string>, batchSize: number, deps: ModDeps): Promise<ModResult> {
	if (cards.length === 0) return { cards, processed: 0, dropped: 0, remaining: 0, changed: false };
	const out: unknown[] = [];
	const dropDetails: string[] = [];
	let processed = 0, dropped = 0, changed = false;
	const canClassify = !!deps.ai;

	for (const card of cards) {
		const c = card as ModCard;
		if (c.mod === "ok") { out.push(card); continue; } // already judged
		if (!c.thumbnailURL) { c.mod = "ok"; changed = true; out.push(card); continue; } // nothing to judge
		if (c.url != null && approved.has(c.url)) { c.mod = "ok"; changed = true; out.push(card); continue; } // owner-approved
		// Unjudged image. Over budget or no AI → leave it for a later pass (still served meanwhile).
		if (!canClassify || processed >= batchSize) { out.push(card); continue; }
		processed++;
		const bytes = await deps.fetchImageBytes(c.thumbnailURL);
		if (!bytes) { out.push(card); continue; } // fetch fail → leave unjudged (retry; ages out via staleness)
		const verdict = await classifyImage(deps.ai!, bytes);
		if (verdict === null) { out.push(card); continue; } // AI error/ambiguous → leave unjudged (retry)
		if (verdict.safe) { c.mod = "ok"; changed = true; out.push(card); }
		else {
			dropped++; changed = true; if (c.handle) dropDetails.push(c.handle);
			deps.onDrop?.({ postId: c.id ?? c.url ?? c.thumbnailURL, postUrl: c.url ?? "", imageUrl: c.thumbnailURL, name: c.authorName ?? "", handle: c.handle ?? "", reason: verdict.reason });
			// unsafe → NOT pushed → removed from the snapshot
		}
	}

	const remaining = out.reduce<number>((n, x) => n + (needsJudging(x as ModCard, approved) ? 1 : 0), 0);
	if (deps.diag) {
		if (!canClassify) deps.diag("imageModerationSkip", "AI binding unset — feed served unmoderated");
		if (dropped > 0) deps.diag("imageModerationDrop", `${dropped}: ${dropDetails.slice(0, 5).join(",")}`);
		deps.diag("imageModerationRun", `processed=${processed} dropped=${dropped} remaining=${remaining} kept=${out.length}/${cards.length}`);
	}
	return { cards: out, processed, dropped, remaining, changed };
}
