// ── CLUB BEAT + curated NEWS OUTLETS (Social tab → Reporters) ──────────────────────────────
// Club Beat = coverage dedicated to ONE club (fan blogs, club-tag feeds of mixed sites, newspaper
// beat sections, beat writers' Bluesky). Every beat card is stamped with its club (`teamAbbreviation`,
// `isLeague:false`), so it reaches ONLY that club's followers — the same routing player IG uses.
// Club-dedicated sources skip the Haiku relevance gate; `mixed` sources (a person's own Bluesky, which
// also carries off-topic posts) run the NWSL gate and keep only NWSL/USWNT items.
//
// News outlets = league-wide written analysis (the News pool, Haiku-tagged per article, as before).
// Both lists are DATA: KV overlays (`social:beat-list`, `social:news-feeds`) written through guarded
// admin endpoints; the constants below are the SEED served until the first write.
//
// Owner rulings (2026-09-30): sources are judged on QUALITY, not quota — count ceilings never keep a
// good source out (the per-club guard below is an anti-spree rail, raise it freely). Platform limits
// (50 external subrequests / invocation on the Workers Free plan) are handled by ENGINEERING — the
// per-source edge cache + per-request fetch budget in index.ts — never by cutting sources.
//
// This file is PURE (no fetch / KV / env): types, seeds, validation, parsers, guarded list edits.
// index.ts does the IO. Unit tests: test/club-beat.test.ts.

export type BeatKind = "rss" | "bluesky" | "beehiiv" | "wpjson";

export interface BeatSource {
	/** Stable slug id (dedupe + health rows + drop target), e.g. "den-burgundy-wave". */
	id: string;
	/** The club this source covers — the routing key. */
	abbr: string;
	/** Display name → card `sourceName` ("Read on <name>") / Bluesky fallback author. */
	name: string;
	kind: BeatKind;
	/** rss: feed URL · beehiiv: the publication's /archive page · wpjson: a WP REST posts query. */
	url?: string;
	/** bluesky only. */
	handle?: string;
	/** Case-insensitive substring an item TITLE must contain (e.g. a show's club-episode prefix). */
	titleMatch?: string;
	/** Run the NWSL relevance gate (a person's own account also posts off-topic). */
	mixed?: boolean;
}

export type NewsKind = "rss" | "beehiiv";
export interface NewsFeedSource {
	url: string;
	source: string; // display name on the card
	kind?: NewsKind; // default "rss"
	titleMatch?: string;
}

/** The 16 app club abbreviations (must match the app's club join keys). */
export const CLUB_ABBRS = new Set([
	"LA", "BAY", "BOS", "CHI", "DEN", "GFC", "HOU", "KC",
	"NC", "ORL", "POR", "LOU", "SD", "SEA", "UTA", "WAS",
]);

/** Anti-spree rail for the guarded apply path — NOT a quality ceiling (owner: quality, not quota).
 *  Every source was verified live 2026-09-30 before it went on this list. */
export const MAX_BEAT_PER_CLUB = 8;

// WordPress REST (MediaNews/Tribune papers block their section RSS with 403, but the public posts API
// serves the same club section: dated, with a featured image). `categories=<id>` = the club section.
const wp = (host: string, categoryId: number) =>
	`https://www.${host}/wp-json/wp/v2/posts?categories=${categoryId}&per_page=8&_fields=date_gmt,link,title,excerpt,jetpack_featured_media_url`;

/** Club Beat SEED — owner-approved 2026-09-30 (plan §7a + §7a-2; podcast-promo / short-reaction
 *  Bluesky accounts held for the podcast build). Every feed/handle verified live that day. */
export const BEAT_SEED: BeatSource[] = [
	// Angel City
	{ id: "la-damian-calhoun", abbr: "LA", name: "Damian Calhoun", kind: "bluesky", handle: "damiancalhoun.bsky.social", mixed: true },
	{ id: "la-oc-register", abbr: "LA", name: "OC Register", kind: "wpjson", url: wp("ocregister.com", 47054) },
	// Bay FC
	{ id: "bay-mercury-news", abbr: "BAY", name: "The Mercury News", kind: "wpjson", url: wp("mercurynews.com", 31950) },
	// Boston Legacy
	{ id: "bos-blazing-musket", abbr: "BOS", name: "The Blazing Musket", kind: "rss", url: "https://www.theblazingmusket.com/tag/boston-legacy-football-club/rss/" },
	{ id: "bos-boston-herald", abbr: "BOS", name: "Boston Herald", kind: "rss", url: "https://www.bostonherald.com/tag/boston-legacy/feed/" },
	// Chicago Stars
	{ id: "chi-chgo-stars", abbr: "CHI", name: "CHGO Stars", kind: "bluesky", handle: "chgo-stars.bsky.social" },
	// Denver Summit
	{ id: "den-burgundy-wave", abbr: "DEN", name: "Burgundy Wave", kind: "rss", url: "https://burgundywave.com/category/denver-summit-fc/feed/" },
	{ id: "den-denver-post", abbr: "DEN", name: "The Denver Post", kind: "rss", url: "https://www.denverpost.com/tag/denver-summit-fc/feed/" },
	{ id: "den-summit-up", abbr: "DEN", name: "Summit Up", kind: "bluesky", handle: "summitup.bsky.social" },
	// Gotham FC
	{ id: "gfc-bat-signal", abbr: "GFC", name: "The Bat Signal", kind: "bluesky", handle: "thebatsignal.bsky.social" },
	{ id: "gfc-bat-signal-newsletter", abbr: "GFC", name: "The Bat Signal", kind: "beehiiv", url: "https://thebatsignal.beehiiv.com/archive" },
	{ id: "gfc-front-row-soccer", abbr: "GFC", name: "Front Row Soccer", kind: "rss", url: "https://www.frontrowsoccer.com/tag/gotham-fc/feed/" },
	// Houston Dash
	{ id: "hou-bayou-city-soccer", abbr: "HOU", name: "Bayou City Soccer", kind: "rss", url: "https://www.bayoucitysoccer.net/dash?format=rss" },
	// KC Current
	{ id: "kc-soccer-journal", abbr: "KC", name: "KC Soccer Journal", kind: "rss", url: "https://kcsoccerjournal.com/category/kc-current/feed/" },
	{ id: "kc-daniel-sperry", abbr: "KC", name: "Daniel Sperry", kind: "bluesky", handle: "danielsperrykc.bsky.social", mixed: true },
	// Orlando Pride
	{ id: "orl-mane-land", abbr: "ORL", name: "The Mane Land", kind: "rss", url: "https://themaneland.com/category/orlando-pride/feed/" },
	{ id: "orl-orlando-sentinel", abbr: "ORL", name: "Orlando Sentinel", kind: "wpjson", url: wp("orlandosentinel.com", 128) },
	// Portland Thorns
	{ id: "por-stumptown-footy", abbr: "POR", name: "Stumptown Footy", kind: "rss", url: "https://stumptown-footy.ghost.io/tag/portland-thorns/rss/" },
	// Racing Louisville
	{ id: "lou-butchertown-rundown", abbr: "LOU", name: "Butchertown Rundown", kind: "rss", url: "https://butchertownrundown.substack.com/feed" },
	{ id: "lou-brendan-devine", abbr: "LOU", name: "Brendan Devine", kind: "bluesky", handle: "brendan-devine.bsky.social", mixed: true },
	// San Diego Wave
	{ id: "sd-union-tribune", abbr: "SD", name: "San Diego Union-Tribune", kind: "rss", url: "https://www.sandiegouniontribune.com/tag/wave-fc/feed/" },
	// Seattle Reign
	{ id: "sea-sounder-at-heart", abbr: "SEA", name: "Sounder at Heart", kind: "rss", url: "https://www.sounderatheart.com/tag/seattle-reign/rss/" },
	{ id: "sea-ride-of-the-valkyries", abbr: "SEA", name: "Ride of the Valkyries", kind: "bluesky", handle: "rideofvalkyries.com" },
	// Utah Royals
	{ id: "uta-royals-buzz", abbr: "UTA", name: "Utah Royals Buzz", kind: "rss", url: "https://utroyalbuzz.substack.com/feed" },
	// Washington Spirit
	{ id: "was-ella-brockway", abbr: "WAS", name: "Ella Brockway", kind: "bluesky", handle: "ellabrockway.bsky.social", mixed: true },
];

/** League-wide News outlets SEED. The first four are the long-standing pool; the rest were added
 *  2026-09-30 (owner-approved) for high-effort analysis. Every item is still Haiku-gated for NWSL
 *  relevance + team-tagged, so a club-specific piece reaches only that club's fans. */
export const NEWS_FEED_SEED: NewsFeedSource[] = [
	{ url: "https://equalizersoccer.com/feed/", source: "The Equalizer" },
	{ url: "https://justwomenssports.com/feed/", source: "Just Women's Sports" },
	{ url: "https://www.allforxi.com/rss/index.xml", source: "All For XI" }, // Atom (SB Nation)
	{ url: "https://www.theguardian.com/football/womensfootball/rss", source: "The Guardian" },
	// Mostly WSL; its weekly "NWSL Crunchtime" column is the NWSL piece → title filter.
	{ url: "https://www.thecutback.com/feed", source: "The Cutback", titleMatch: "NWSL" },
	{ url: "https://www.americansocceranalysis.com/home?format=rss", source: "American Soccer Analysis" },
	// No public RSS — its beehiiv archive page carries the post list (title, subtitle, date, image).
	{ url: "https://btvc.beehiiv.com/archive", source: "Beyond the Vaudevillian Cane", kind: "beehiiv" },
];

// ── Validation ────────────────────────────────────────────────────────────────────────────────

const BSKY_HANDLE_RE = /^[a-z0-9][a-z0-9.-]{2,60}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,60}$/;

/** Why a beat source is malformed, or null when it's valid. */
export function beatSourceProblem(s: Partial<BeatSource>): string | null {
	if (!s || typeof s !== "object") return "not an object";
	if (!s.id || !ID_RE.test(s.id)) return "invalid id (lowercase slug)";
	if (!s.abbr || !CLUB_ABBRS.has(s.abbr)) return "unknown club abbr";
	if (!s.name || typeof s.name !== "string") return "missing name";
	if (s.kind === "bluesky") {
		const h = (s.handle ?? "").toLowerCase();
		if (!BSKY_HANDLE_RE.test(h) || !h.includes(".")) return "invalid bluesky handle";
		return null;
	}
	if (s.kind === "rss" || s.kind === "beehiiv" || s.kind === "wpjson") {
		if (!s.url || !/^https:\/\/[^\s]+$/.test(s.url)) return "invalid https url";
		return null;
	}
	return "unknown kind";
}

/** A KV-loaded beat list is usable only if EVERY entry validates (a partial list would silently
 *  hide a club's coverage — callers fall back to the seed and emit a diag instead). */
export function isValidBeatList(v: unknown): v is BeatSource[] {
	return Array.isArray(v) && v.length > 0 && v.every((s) => beatSourceProblem(s as BeatSource) === null);
}

export function isValidNewsFeeds(v: unknown): v is NewsFeedSource[] {
	return (
		Array.isArray(v) &&
		v.length > 0 &&
		v.every((f) => {
			const x = f as NewsFeedSource;
			return !!x && typeof x.source === "string" && !!x.source && typeof x.url === "string" && /^https:\/\//.test(x.url) &&
				(x.kind === undefined || x.kind === "rss" || x.kind === "beehiiv");
		})
	);
}

/** Beat sources for the requested clubs only — cost scales with follows, not list size. */
export function beatSourcesFor(list: BeatSource[], teams: string[]): BeatSource[] {
	const want = new Set(teams);
	return list.filter((s) => want.has(s.abbr));
}

/** Title filter (case-insensitive substring). No filter → everything passes. */
export function titlePasses(title: string, titleMatch?: string): boolean {
	if (!titleMatch) return true;
	return title.toLowerCase().includes(titleMatch.toLowerCase());
}

// ── Guarded list edits (the admin / future-routine write path) ─────────────────────────────────

export interface BeatApplyResult {
	list: BeatSource[];
	added: string[];
	dropped: string[];
	rejected: { id?: string; reason: string }[];
}

/** Apply drops then adds to a beat list with server-side guards: schema validation, id + source
 *  dedupe, the per-club anti-spree rail. Pure — the caller persists `list` when anything changed. */
export function applyBeatChanges(
	current: BeatSource[],
	body: { add?: Partial<BeatSource>[]; drop?: string[] },
	maxPerClub = MAX_BEAT_PER_CLUB,
): BeatApplyResult {
	const list = [...current];
	const added: string[] = [];
	const dropped: string[] = [];
	const rejected: { id?: string; reason: string }[] = [];

	for (const d of body.drop ?? []) {
		const id = String(d);
		const idx = list.findIndex((s) => s.id === id);
		if (idx === -1) {
			rejected.push({ id, reason: "not on the list" });
			continue;
		}
		list.splice(idx, 1);
		dropped.push(id);
	}

	for (const raw of body.add ?? []) {
		const s: BeatSource = {
			id: String(raw.id ?? ""),
			abbr: String(raw.abbr ?? "").toUpperCase(),
			name: String(raw.name ?? "").trim(),
			kind: raw.kind as BeatKind,
			...(raw.url ? { url: String(raw.url) } : {}),
			...(raw.handle ? { handle: String(raw.handle).toLowerCase().replace(/^@/, "") } : {}),
			...(raw.titleMatch ? { titleMatch: String(raw.titleMatch) } : {}),
			...(raw.mixed ? { mixed: true } : {}),
		};
		const problem = beatSourceProblem(s);
		if (problem) {
			rejected.push({ id: s.id || undefined, reason: problem });
			continue;
		}
		if (list.some((x) => x.id === s.id)) {
			rejected.push({ id: s.id, reason: "id already on the list" });
			continue;
		}
		const target = s.kind === "bluesky" ? s.handle : s.url;
		if (list.some((x) => x.abbr === s.abbr && (x.kind === "bluesky" ? x.handle : x.url) === target)) {
			rejected.push({ id: s.id, reason: "same source already on this club" });
			continue;
		}
		if (list.filter((x) => x.abbr === s.abbr).length >= maxPerClub) {
			rejected.push({ id: s.id, reason: `per-club rail (${maxPerClub}) reached — raise MAX_BEAT_PER_CLUB if this source is good` });
			continue;
		}
		list.push(s);
		added.push(s.id);
	}
	return { list, added, dropped, rejected };
}

// ── Parsers (return RAW strings; index.ts decodes entities / strips HTML) ──────────────────────

export interface RawItem {
	title: string;
	link: string;
	pubDate?: string;
	description?: string;
	image?: string;
}

/** Slice the JSON array that starts at `start` (the index of its `[`), honoring strings/escapes. */
function sliceJsonArray(s: string, start: number): string | null {
	let depth = 0;
	let inStr = false;
	for (let i = start; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (inStr) {
			if (c === 92 /* \ */) i++;
			else if (c === 34 /* " */) inStr = false;
			continue;
		}
		if (c === 34) inStr = true;
		else if (c === 91 /* [ */) depth++;
		else if (c === 93 /* ] */) {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}

/** beehiiv publication archive page → items. beehiiv SSRs the archive's post list as JSON; the key
 *  path differs by theme (`"paginatedPosts":{…,"posts":[…]}` on one, `"data":{"posts":[…]}` inside a
 *  page-builder block on another — both seen live 2026-09-30), so scan EVERY `"posts":[` array and
 *  take the first whose entries carry `web_title` + `slug`. Premium (paywalled) posts are skipped.
 *  `origin` = the publication's origin (links are `<origin>/p/<slug>`). */
export function parseBeehiivArchive(html: string, origin: string): RawItem[] {
	const base = origin.replace(/\/$/, "");
	let from = 0;
	for (;;) {
		const postsKey = html.indexOf('"posts":[', from);
		if (postsKey === -1) return [];
		from = postsKey + 1;
		const arr = sliceJsonArray(html, postsKey + '"posts":'.length);
		if (!arr) continue;
		let posts: Array<Record<string, unknown>>;
		try {
			posts = JSON.parse(arr) as Array<Record<string, unknown>>;
		} catch {
			continue;
		}
		if (!Array.isArray(posts) || !posts.some((p) => p && typeof p.web_title === "string" && typeof p.slug === "string")) continue;
		const out: RawItem[] = [];
		for (const p of posts) {
			const title = typeof p.web_title === "string" ? p.web_title.trim() : "";
			const slug = typeof p.slug === "string" ? p.slug : "";
			if (!title || !slug || p.is_premium === true) continue;
			const date = [p.override_scheduled_at, p.scheduled_at, p.publish_date, p.published_at, p.created_at].find(
				(d) => typeof d === "string" && d,
			) as string | undefined;
			out.push({
				title,
				link: `${base}/p/${slug}`,
				pubDate: date,
				description: typeof p.web_subtitle === "string" && p.web_subtitle ? p.web_subtitle : undefined,
				image: typeof p.image_url === "string" && p.image_url ? p.image_url : undefined,
			});
		}
		return out;
	}
}

/** WordPress REST `wp/v2/posts` response → items. `date_gmt` has no zone suffix → treat as UTC. */
export function parseWpJsonPosts(json: unknown): RawItem[] {
	if (!Array.isArray(json)) return [];
	const out: RawItem[] = [];
	for (const p of json as Array<Record<string, unknown>>) {
		const title = (p.title as { rendered?: string } | undefined)?.rendered?.trim();
		const link = typeof p.link === "string" ? p.link : undefined;
		if (!title || !link) continue;
		const g = typeof p.date_gmt === "string" ? p.date_gmt : undefined;
		out.push({
			title,
			link,
			pubDate: g ? (/[zZ]|[+-]\d\d:?\d\d$/.test(g) ? g : `${g}Z`) : undefined,
			description: (p.excerpt as { rendered?: string } | undefined)?.rendered,
			image: typeof p.jetpack_featured_media_url === "string" && p.jetpack_featured_media_url ? p.jetpack_featured_media_url : undefined,
		});
	}
	return out;
}

// ── Source health (Status board + GET /social/beat-audit) ───────────────────────────────────────

export type SourceTier = "ok" | "cooling" | "dormant" | "empty" | "dead";
const DAY = 86_400_000;

/** Same thresholds as the reporter Bluesky tiers: 🟢 <14d · 🟡 14–30d · 🔴 >30d (past the app's
 *  ~30-day Social window → invisible) · empty (reachable, no dated items) · dead (unreachable). */
export function sourceTier(newestMs: number | null, now: number, reachable: boolean): SourceTier {
	if (!reachable) return "dead";
	if (newestMs === null) return "empty";
	const age = now - newestMs;
	if (age < 14 * DAY) return "ok";
	if (age <= 30 * DAY) return "cooling";
	return "dormant";
}
