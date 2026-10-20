// Instagram scrape reliability + durable image copies (2026-10-20). Pure helpers, unit-tested in
// test/ig-scrape.test.ts; the wiring lives in index.ts (startSocialScrape, handleApifyWebhook,
// handleIgImageCopy, maybeRetrySocialScrape).
//
// WHY (live evidence, 2026-10-17/19 — docs/social-tuning.md "Scrape reliability"):
//  • The every-other-day cron used to WAIT on Apify's run-sync endpoint inside the cron invocation. A run
//    longer than ~2 min came back as a Cloudflare 524 (10/17: the run needed 4m48s → `apifyRunFail 524`,
//    the pool kept its old copy). On 10/19 the invocation died after a 61s run — no diag, no Bright Data.
//  • Bright Data (clubs) was triggered only AFTER the player scrape returned, so any player-side death also
//    lost Home's club posts (the 10/20 "IG clubs snapshot MISSING" page).
//  • The A/B pool marker flipped BEFORE the scrape, so a dead run skipped its pool for a whole extra cycle.
//  • Instagram's signed image links (`oe=`) die ~2.5 days after a scrape, but a pool refreshes every 4 days
//    — so every player image was dead ~1.5 of every 4 days for any phone that hadn't cached it.
// NOW: Bright Data first → Apify started ASYNC with an Apify webhook → the webhook (its own invocation)
// saves the pool, copies new images to R2 (served from img.crestside.app, no expiring link) and only then
// moves the marker. A one-shot 15:00 UTC check re-runs whichever side didn't land.

/** Public origin of the R2 image bucket's custom domain (crestside.app is on Cloudflare DNS). */
export const IMAGE_PUBLIC_ORIGIN = "https://img.crestside.app";

/** Images per copy batch. Each batch runs in its OWN invocation (SELF binding) so its image fetches get a
 *  fresh 50-subrequest budget; 40 leaves headroom for the diag flush. */
export const IMAGE_COPY_BATCH = 40;
/** Max batches one webhook fans out (each is 1 subrequest of the webhook's 50). 10 × 40 = 400 images,
 *  above a whole pool's ~310-card first run; anything beyond keeps its Instagram link this run. */
export const IMAGE_COPY_MAX_BATCHES = 10;

/** The fields the Apify dataset read asks for — exactly what `mapApifyInstagram` + the handle match read.
 *  Asking for these only (the actor's 1.7.x items also carry carousel/usertags/owner blobs) keeps the
 *  webhook's JSON parse small on the Free plan's 10ms CPU budget. */
export const APIFY_ITEM_FIELDS = [
	"scraped_username", "user", "ownerUsername",
	"code", "shortCode", "shortcode", "post_url", "url",
	"taken_at", "timestamp", "takenAtTimestamp",
	"image_url", "displayUrl", "thumbnailUrl",
	"caption", "text",
	"like_count", "likesCount", "likeCount",
] as const;

// UTC hour of the scrape cron (`0 12 */2 * *`) and of its one-shot retry check (3h later).
export const SCRAPE_HOUR_UTC = 12;
export const RETRY_HOUR_UTC = 15;

// The cron's every-2-days day-of-month step fires on days 1,3,5,…,31 (odd days).
export function isScrapeDayUTC(ms: number): boolean {
	return new Date(ms).getUTCDate() % 2 === 1;
}

/** The ONE 5-minute tick that runs the retry check: 15:00–15:04 UTC on a scrape day. Only one tick of the
 *  5-minute cron lands in that slot, which is what makes the retry one-time without storing any state. */
export function isRetrySlot(scheduledMs: number): boolean {
	const d = new Date(scheduledMs);
	return isScrapeDayUTC(scheduledMs) && d.getUTCHours() === RETRY_HOUR_UTC && d.getUTCMinutes() < 5;
}

/** Today's scrape time (12:00 UTC) for the day containing `ms`. */
export function scrapeStartMs(ms: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SCRAPE_HOUR_UTC);
}

/** Metadata stamped on a snapshot write when it holds FRESH cards (a keep-last-good re-put carries the old
 *  stamp forward, so a scrape that came back empty still reads as "not refreshed today"). */
export interface SnapshotStamp { at: number }

export function stampAt(meta: unknown): number {
	const at = (meta as { at?: unknown } | null | undefined)?.at;
	return typeof at === "number" && Number.isFinite(at) ? at : 0;
}

export type Pool = "A" | "B";
export const otherPool = (p: Pool): Pool => (p === "A" ? "B" : "A");

/** Which pool the scheduled scrape takes: the one NOT saved last (the marker names the last SAVED pool). */
export function nextPool(marker: string | null): Pool {
	return marker === "A" ? "B" : "A";
}

/** What the 15:00 check should re-run. Players are done if EITHER pool got fresh cards since 12:00 (the
 *  run saves exactly one); clubs are done if the club snapshot did. The retried pool is the one the 12:00
 *  run would have taken — the marker only moves on a successful save, so it still points the same way. */
export function retryPlan(input: {
	now: number;
	marker: string | null;
	poolAAt: number;
	poolBAt: number;
	clubAt: number;
	bdConfigured: boolean;
}): { players: Pool | null; clubs: boolean } {
	const since = scrapeStartMs(input.now);
	const playersDone = input.poolAAt >= since || input.poolBAt >= since;
	return {
		players: playersDone ? null : nextPool(input.marker),
		clubs: input.bdConfigured && input.clubAt < since,
	};
}

/** The `webhooks` query value for Apify's run-start call: one ad-hoc webhook for the run's terminal states,
 *  POSTed to /apify-webhook?pool=X with our secret in the Authorization header (base64 JSON, per Apify). */
export function apifyWebhooksParam(origin: string, pool: Pool, secret: string): string {
	const hooks = [
		{
			eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
			requestUrl: `${origin}/apify-webhook?pool=${pool}`,
			headersTemplate: JSON.stringify({ Authorization: secret }),
		},
	];
	return btoa(JSON.stringify(hooks));
}

/** Apify's default webhook payload → what we need. null = not a shape we recognize. */
export function parseApifyWebhook(body: unknown): { eventType: string; runId: string; datasetId: string | null; status: string } | null {
	const b = body as { eventType?: unknown; eventData?: { actorRunId?: unknown }; resource?: { id?: unknown; defaultDatasetId?: unknown; status?: unknown } } | null;
	if (!b || typeof b.eventType !== "string") return null;
	const runId = typeof b.resource?.id === "string" ? b.resource.id : typeof b.eventData?.actorRunId === "string" ? b.eventData.actorRunId : "";
	const datasetId = typeof b.resource?.defaultDatasetId === "string" ? b.resource.defaultDatasetId : null;
	const status = typeof b.resource?.status === "string" ? b.resource.status : "";
	return { eventType: b.eventType, runId, datasetId, status };
}

// ── Durable image copies ──────────────────────────────────────────────────────────────────────

type ImgCard = { id?: string; thumbnailURL?: string };

/** R2 key for a card's image: one object per POST (card id `ig-<shortcode>`), written once — a post's image
 *  never changes, so there is nothing to refresh. Old objects are removed by the bucket's age rule. */
export function imageKeyFor(card: ImgCard): string | null {
	const id = card.id;
	if (!id || !/^ig-[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
	return `ig/${id.slice(3)}`;
}

export const imagePublicURL = (key: string): string => `${IMAGE_PUBLIC_ORIGIN}/${key}`;
export const isOurImage = (url: string | undefined): boolean => !!url && url.startsWith(`${IMAGE_PUBLIC_ORIGIN}/`);

/** Plan this scrape's copies. A card whose post was already copied (its card in the PRIOR snapshot points at
 *  our image) reuses that address — no R2 call at all. Everything else with a fresh Instagram link is a job.
 *  Mutates `fresh` for the reused ones; returns the jobs (src = the fresh Instagram link). */
export function planImageCopies(fresh: unknown[], prior: unknown[]): { key: string; src: string; id: string }[] {
	const copied = new Map<string, string>();
	for (const p of prior) {
		const c = p as ImgCard;
		if (c.id && isOurImage(c.thumbnailURL)) copied.set(c.id, c.thumbnailURL as string);
	}
	const jobs: { key: string; src: string; id: string }[] = [];
	for (const f of fresh) {
		const c = f as ImgCard;
		if (!c.id || !c.thumbnailURL) continue;
		const reuse = copied.get(c.id);
		if (reuse) { c.thumbnailURL = reuse; continue; }
		if (isOurImage(c.thumbnailURL)) continue;
		const key = imageKeyFor(c);
		if (key && /^https:\/\//.test(c.thumbnailURL)) jobs.push({ key, src: c.thumbnailURL, id: c.id });
	}
	return jobs;
}

/** Point each successfully copied card at our image; failed copies keep the Instagram link (still fresh —
 *  it was scraped minutes ago) and get another try next scrape. */
export function applyImageCopies(fresh: unknown[], copiedKeys: Set<string>): number {
	let n = 0;
	for (const f of fresh) {
		const c = f as ImgCard;
		if (isOurImage(c.thumbnailURL)) continue;
		const key = imageKeyFor(c);
		if (key && copiedKeys.has(key)) { c.thumbnailURL = imagePublicURL(key); n++; }
	}
	return n;
}

export function chunk<T>(arr: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** Only real image responses of a sane size get stored (an Instagram error page must never become a card). */
export const IMAGE_COPY_MAX_BYTES = 5_000_000;
export function acceptableImage(contentType: string | null, bytes: number): boolean {
	return !!contentType && /^image\//i.test(contentType) && bytes > 0 && bytes <= IMAGE_COPY_MAX_BYTES;
}
