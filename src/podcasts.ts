// ── PODCASTS (Social tab → Listen chip + directory) ─────────────────────────────────────────
// A curated DIRECTORY of NWSL podcasts, not an episode river: the app shows show cards with a
// Follow button and a Listen chip of recent episodes ROUTED to the user's clubs. Routing is
// DETERMINISTIC (no AI, owner 2026-10-01): a club show's episodes inherit its club; a league
// show's episodes match FULL club names + FULL player names from the proxy's existing roster copy
// in KV (zero new ESPN calls), never bare nicknames or city names (false-positive traps like
// "Pride Month" or an MLS "Current"). Multi-match → every matched club; no match → "league".
//
// This file is PURE (no fetch / KV / env): types, the seed, the RSS parser, the router, validation.
// index.ts does the IO (fetch, the hourly snapshot refresh, /feed + /podcasts/directory). The seed
// is the fallback served until the first guarded /social/podcasts/apply write (KV social:podcast-list).
// Every show was Apple-lookup-verified live 2026-10-01 (feed URL + recent episode). Unit tests:
// test/podcasts.test.ts.

export type PodcastScope = string; // a club abbr (CLUB_ABBRS) or "league"

export interface PodcastShow {
	/** Stable slug id (dedupe + directory + Listen toggle key), e.g. "was-hey-spirits". */
	id: string;
	name: string;
	/** The podcast RSS feed (authoritative = Apple lookup feedUrl). */
	rss: string;
	/** A club abbr (every episode inherits it, no matching) or "league" (episodes are routed). */
	scope: PodcastScope;
	/** Apple podcast numeric id — builds the Apple/Overcast/Pocket Casts show links. */
	appleId?: string;
	/** Spotify show URL (stored once; episode-level deep links are unreliable, so show-level). */
	spotifyUrl?: string;
	/** Case-insensitive substring an episode TITLE must contain (a mixed feed's NWSL segment). */
	titleMatch?: string;
	/** One-line "what it covers" for the directory row. */
	blurb: string;
	/** Who makes it — drives the credit tag. "fan" = independent fan/creator show; "media" =
	 *  a professional outlet/network (The Athletic, CBS, Just Women's Sports, the Equalizer, …). */
	producer: "fan" | "media";
}

export interface PodcastEpisode {
	guid: string;
	showId: string;
	title: string;
	description: string; // plain text, <=240 chars
	pubDate?: string;
	duration?: string; // display form "H:MM:SS" / "M:SS"
	url?: string; // episode page (the Listen fallback target)
	clubs: string[]; // routed club abbrs; [] means league-wide
	/** Which names matched, each tagged with its club — so /feed can order a reader's own clubs
	 *  first in the "Mentions" line. (A club-name match carries that club; a player match her club.) */
	matched: { term: string; abbr: string }[];
}

/** The 16 app club abbreviations (must match the app's club join keys). */
export const CLUB_ABBRS = new Set([
	"LA", "BAY", "BOS", "CHI", "DEN", "GFC", "HOU", "KC",
	"NC", "ORL", "POR", "LOU", "SD", "SEA", "UTA", "WAS",
]);

/** Anti-spree rails (owner: quality, not quota — raise freely for a good show). */
export const MAX_PODCASTS_PER_CLUB = 6;
/** Newest episodes kept per show in the snapshot (bounds size + the Listen "Around the league"). */
export const MAX_EPISODES_PER_SHOW = 5;
/** A show with no episode in this window is hidden from the directory + flagged on the Status board. */
export const PODCAST_INACTIVE_DAYS = 42;

/** FULL club-name match terms per abbr — how a league episode's title/notes names the club. Bare
 *  nicknames (Spirit, Pride, Current, Courage, Wave, Thorns, Reign) and city-only names are
 *  DELIBERATELY excluded (false positives: "Pride Month", an MLS "Current", "Wave" the band). */
export const CLUB_MATCH_NAMES: Record<string, string[]> = {
	LA: ["angel city"],
	BAY: ["bay fc"],
	BOS: ["boston legacy"],
	CHI: ["chicago stars"],
	DEN: ["denver summit"],
	GFC: ["gotham fc", "gotham f c", "nj ny gotham"],
	HOU: ["houston dash"],
	KC: ["kansas city current", "kc current"],
	NC: ["north carolina courage", "nc courage"],
	ORL: ["orlando pride"],
	POR: ["portland thorns"],
	LOU: ["racing louisville"],
	SD: ["san diego wave"],
	SEA: ["seattle reign"],
	UTA: ["utah royals"],
	WAS: ["washington spirit"],
};

/** Podcast seed — Apple-lookup-verified 2026-10-01 (16 club shows + 7 league; Beatline excluded). */
export const PODCAST_SEED: PodcastShow[] = [
	{ id: "league-nwsl-this-week", name: "NWSL This Week", rss: "https://api.substack.com/feed/podcast/2858197.rss", scope: "league", appleId: "1763620771", spotifyUrl: "https://open.spotify.com/show/6s0txn6wZB8HsUPYHpxxiY", blurb: "Weekly recap of every NWSL match from Equalizer writers", producer: "media" },
	{ id: "league-full-time", name: "Full Time", rss: "https://feeds.acast.com/public/shows/6818801871c041c8cc75b143", scope: "league", appleId: "1518818543", spotifyUrl: "https://open.spotify.com/show/2Syy27diWBkaJsjI00RJtb", blurb: "Reporter-led women's soccer show from The Athletic", producer: "media" },
	{ id: "league-attacking-third", name: "Attacking Third", rss: "https://rss.amperwave.net/v2/feed/audacynetwork/attackingthird", scope: "league", appleId: "1573642138", spotifyUrl: "https://open.spotify.com/show/32OVfPoFl8BMNEsFJCnnHN", blurb: "CBS Sports' NWSL panel: recaps, transfers, analysis", producer: "media" },
	{ id: "league-expected-own-goals", name: "Expected Own Goals", rss: "https://feeds.megaphone.fm/RPPSG6845772467", scope: "league", appleId: "1698924172", spotifyUrl: "https://open.spotify.com/show/30ThmaUENe9hTGo00YLFyl", blurb: "NWSL tactics and analytics, every week", producer: "fan" },
	{ id: "league-the-late-sub", name: "The Late Sub", rss: "https://feeds.megaphone.fm/JWS5718566426", scope: "league", appleId: "1563105123", spotifyUrl: "https://open.spotify.com/show/4n4ZxsVs1Ix9DY9E0KPSc6", blurb: "Claire Watkins on the NWSL and USWNT", producer: "media" },
	{ id: "league-time-wasting", name: "Time Wasting", rss: "https://feeds.megaphone.fm/JWS9777147888", scope: "league", appleId: "1522055041", spotifyUrl: "https://open.spotify.com/show/6RTMyWpdSBY9I4vO528qX3", blurb: "Ali Riley and Kelley O'Hara on life around the league", producer: "media" },
	{ id: "league-soccerwise", name: "Soccerwise", rss: "https://feeds.captivate.fm/soccerwise/", scope: "league", appleId: "1752138229", spotifyUrl: "https://open.spotify.com/show/3avVYlzUnqlFaibuYsx7n9", titleMatch: "NWSL Soccerwise |", blurb: "The Wednesday NWSL show from Soccerwise", producer: "media" },
	{ id: "la-above-the-clouds", name: "Above the Clouds", rss: "https://anchor.fm/s/82fa3ca0/podcast/rss", scope: "LA", appleId: "1615706074", blurb: "Angel City analysis after every match", producer: "fan" },
	{ id: "la-casual-fc", name: "Casual FC", rss: "https://feeds.transistor.fm/casual-fc", scope: "LA", appleId: "1691808062", blurb: "Weekly Angel City previews and recaps", producer: "fan" },
	{ id: "bos-the-swan-dive", name: "The Swan Dive", rss: "https://feeds.acast.com/public/shows/69a615062d879b9006479dab", scope: "BOS", appleId: "1828264969", spotifyUrl: "https://open.spotify.com/show/5oaJHCvE0KajWc11bi0gBa", blurb: "Boston Legacy fan show, weekly", producer: "fan" },
	{ id: "den-the-5280-pitch", name: "The 5280 Pitch", rss: "https://api.riverside.fm/hosting/4mMPZQWY.rss", scope: "DEN", appleId: "1859060272", spotifyUrl: "https://open.spotify.com/show/6jiBAbW0QXepwdqK0qhaaF", blurb: "Denver Summit coverage from a Denver sports reporter", producer: "fan" },
	{ id: "den-summit-up", name: "Summit Up", rss: "https://api.riverside.fm/hosting/zo8hz1Qi.rss", scope: "DEN", appleId: "1832640530", blurb: "Denver Summit match recaps and previews", producer: "fan" },
	{ id: "gfc-gothamites-roost", name: "Gothamites' Roost", rss: "https://anchor.fm/s/11405cf70/podcast/rss", scope: "GFC", appleId: "6782950164", blurb: "A weekly Gotham FC fancast", producer: "fan" },
	{ id: "kc-the-tea-l", name: "The Tea(L)", rss: "https://anchor.fm/s/660d5aa0/podcast/rss", scope: "KC", appleId: "1583748540", blurb: "KC Current coverage since 2021", producer: "fan" },
	{ id: "nc-the-lion-s-pitch", name: "The Lion's Pitch", rss: "https://feeds.acast.com/public/shows/65eb196f82e6910016356fa6", scope: "NC", appleId: "1735753132", blurb: "Independent NC Courage analysis, weekly", producer: "fan" },
	{ id: "orl-skopurp-soccer", name: "SkoPurp Soccer", rss: "https://anchor.fm/s/de37cd58/podcast/rss", scope: "ORL", appleId: "1682046626", spotifyUrl: "https://open.spotify.com/show/2Dg5YqAKLie4dpaaDQ1YiM", blurb: "The Mane Land's Orlando Pride podcast", producer: "fan" },
	{ id: "por-rose-city-red-card", name: "Rose City Red Card", rss: "https://rss.buzzsprout.com/2619164.rss", scope: "POR", appleId: "1896820142", blurb: "Portland Thorns fan show, weekly", producer: "fan" },
	{ id: "por-the-rose-city-breakdown", name: "The Rose City Breakdown", rss: "https://media.rss.com/the-rose-city-breakdown/feed.xml", scope: "POR", appleId: "1879295371", spotifyUrl: "https://open.spotify.com/show/0zV3J34HLlpnwTMyJzRSuB", blurb: "Thorns interviews and analytics with Stumptown Footy", producer: "fan" },
	{ id: "lou-butchertown-rundown", name: "Butchertown Rundown", rss: "https://api.substack.com/feed/podcast/2644937.rss", scope: "LOU", appleId: "1609100723", blurb: "Independent Racing Louisville coverage", producer: "fan" },
	{ id: "sd-the-breaking-wave", name: "The Breaking Wave", rss: "https://feeds.acast.com/public/shows/65ff5fc88d6ad800169c4e76", scope: "SD", appleId: "1737630102", spotifyUrl: "https://open.spotify.com/show/45vtVzBmoRlZcpQcEAozyr", blurb: "San Diego Wave weekly fan show", producer: "fan" },
	{ id: "sea-the-cooler-guild", name: "The Cooler Guild", rss: "https://feeds.zencastr.com/f/c4BmBYVw.rss", scope: "SEA", appleId: "1749401888", blurb: "Seattle Reign weekly from Sounder at Heart", producer: "fan" },
	{ id: "uta-royal-riot", name: "Royal Riot", rss: "https://rss.pdrl.fm/fca752/feeds.libsyn.com/411032/rss/?redirect=false", scope: "UTA", appleId: "1619446086", spotifyUrl: "https://open.spotify.com/show/55cyEbD8BNgsq388oz6Yc2", titleMatch: "URFC:", blurb: "Utah Royals coverage (URFC segments)", producer: "fan" },
	{ id: "was-hey-spirits", name: "Hey Spirits", rss: "https://anchor.fm/s/d9a05634/podcast/rss", scope: "WAS", appleId: "1674466647", blurb: "Washington Spirit analysis, weekly", producer: "fan" },
];

// ── RSS parsing ───────────────────────────────────────────────────────────────────────────────

export interface RawEpisode {
	guid: string;
	title: string;
	link?: string;
	pubDate?: string;
	durationRaw?: string;
	description?: string; // raw (entities/HTML); index.ts decodes + strips like beat/news items
}

export interface ParsedPodcast {
	artwork?: string;
	/** The show's own author/network (`<itunes:author>` / `<managingEditor>`) — the credit byline. */
	author?: string;
	/** The podcaster set `<itunes:block>yes</itunes:block>` — an explicit "don't list me in directories"
	 *  opt-out. We honor it: the show is dropped from Listen + the directory. */
	blocked: boolean;
	episodes: RawEpisode[];
}

function tagText(block: string, name: string): string | undefined {
	const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
	if (!m) return undefined;
	const inner = m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
	return inner || undefined;
}

/** Parse a podcast RSS feed → channel artwork + episodes. Reads the podcast-specific tags
 *  parseOutletRSS skips: channel `<itunes:image href>` (artwork) and item `<itunes:duration>`.
 *  Returns RAW title/description (index.ts decodes entities + strips HTML, same as beat items). */
export function parsePodcastRSS(xml: string): ParsedPodcast {
	// Channel artwork: the FIRST itunes:image href is the channel's (items rarely carry their own).
	const artM = /<itunes:image[^>]*\bhref="([^"]+)"/i.exec(xml);
	const artwork = artM ? artM[1].replace(/&amp;/g, "&") : undefined;

	// Author/network for the credit byline: channel <itunes:author>, then <managingEditor>. Use the
	// channel block only (before the first <item>) so an episode author can't shadow the show's.
	const channel = xml.split(/<item[\s>]/i)[0];
	const author = tagText(channel, "itunes:author") ?? tagText(channel, "managingEditor");

	// Creator opt-out: honor a channel-level <itunes:block>yes</itunes:block> (podcasters use it to
	// tell directories not to list them). An item-level block is per-episode and rarer; we only read
	// the channel block, so an episode author can't flip the whole show.
	const blocked = /^\s*yes\s*$/i.test(tagText(channel, "itunes:block") ?? "");

	const episodes: RawEpisode[] = [];
	const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
	for (const block of blocks) {
		const title = tagText(block, "title");
		if (!title) continue;
		// guid may carry attributes (isPermaLink); fall back to the enclosure URL or the link.
		const guid =
			tagText(block, "guid") ??
			/<enclosure[^>]*\burl="([^"]+)"/i.exec(block)?.[1] ??
			tagText(block, "link");
		if (!guid) continue;
		episodes.push({
			guid,
			title,
			link: tagText(block, "link"),
			pubDate: tagText(block, "pubDate") ?? tagText(block, "pubdate"),
			durationRaw: tagText(block, "itunes:duration"),
			description: tagText(block, "description") ?? tagText(block, "itunes:summary") ?? tagText(block, "content:encoded"),
		});
	}
	return { artwork, author: author ? decodeAmp(author) : undefined, blocked, episodes };
}

/** Minimal entity decode for the author byline (feeds vary). */
function decodeAmp(s: string): string {
	return s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

/** Normalize an itunes:duration (seconds like "2083", or "M:SS" / "H:MM:SS") → a display string.
 *  Undefined when unparseable. */
export function normalizeDuration(raw?: string): string | undefined {
	if (!raw) return undefined;
	const s = raw.trim();
	let total: number;
	if (/^\d+$/.test(s)) {
		total = parseInt(s, 10);
	} else if (/^\d{1,2}(:\d{2}){1,2}$/.test(s)) {
		total = s.split(":").reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
	} else {
		return undefined;
	}
	if (!Number.isFinite(total) || total <= 0) return undefined;
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// ── Routing (deterministic, no AI) ──────────────────────────────────────────────────────────────

/** Lowercase + strip accents/punctuation to single spaces, so "André" matches "andre" and word
 *  boundaries are real (prevents "smith" matching inside "smithson"). */
export function normalizeForMatch(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** True iff `needle` (already normalized, space-delimited words) appears as a whole-word run in
 *  `paddedHaystack` (already normalized + space-padded on both ends). */
function containsPhrase(paddedHaystack: string, needle: string): boolean {
	if (!needle) return false;
	return paddedHaystack.includes(` ${needle} `);
}

/** Route one league-show episode to clubs by matching FULL club names + FULL player names.
 *  `roster` = full player name (normalized) → club abbr (from the proxy's KV roster copy). Returns
 *  the matched clubs + the terms that hit (for the Mentions line). Empty clubs = league-wide. A
 *  club-scope show never calls this. */
export function routeEpisode(
	title: string,
	description: string,
	roster: Map<string, string>,
): { clubs: string[]; matched: { term: string; abbr: string }[] } {
	const hay = ` ${normalizeForMatch(`${title} ${description}`)} `;
	const clubs = new Set<string>();
	const matched: { term: string; abbr: string }[] = [];
	const seen = new Set<string>();
	const add = (term: string, abbr: string) => {
		clubs.add(abbr);
		if (!seen.has(term)) {
			seen.add(term);
			matched.push({ term, abbr });
		}
	};
	for (const [abbr, names] of Object.entries(CLUB_MATCH_NAMES)) {
		for (const n of names) if (containsPhrase(hay, n)) add(n, abbr);
	}
	for (const [name, abbr] of roster) {
		// Require a full "first last" (at least two words) — no surname-only matching (owner).
		if (name.includes(" ") && containsPhrase(hay, name)) add(name, abbr);
	}
	return { clubs: [...clubs], matched };
}

// ── Validation + guarded list edits ─────────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9-]{2,60}$/;

export function podcastProblem(s: Partial<PodcastShow>): string | null {
	if (!s || typeof s !== "object") return "not an object";
	if (!s.id || !ID_RE.test(s.id)) return "invalid id (lowercase slug)";
	if (!s.name || typeof s.name !== "string") return "missing name";
	if (!s.rss || !/^https:\/\/[^\s]+$/.test(s.rss)) return "invalid https rss url";
	if (!s.scope || (s.scope !== "league" && !CLUB_ABBRS.has(s.scope))) return "scope must be a club abbr or league";
	return null;
}

export function isValidPodcastList(v: unknown): v is PodcastShow[] {
	return Array.isArray(v) && v.length > 0 && v.every((s) => podcastProblem(s as PodcastShow) === null);
}

export interface PodcastApplyResult {
	list: PodcastShow[];
	added: string[];
	dropped: string[];
	rejected: { id?: string; reason: string }[];
}

/** Apply drops then adds with server guards (schema, id + feed dedupe, per-club rail). Pure. */
export function applyPodcastChanges(
	current: PodcastShow[],
	body: { add?: Partial<PodcastShow>[]; drop?: string[] },
	maxPerClub = MAX_PODCASTS_PER_CLUB,
): PodcastApplyResult {
	const list = [...current];
	const added: string[] = [];
	const dropped: string[] = [];
	const rejected: { id?: string; reason: string }[] = [];

	for (const d of body.drop ?? []) {
		const id = String(d);
		const idx = list.findIndex((s) => s.id === id);
		if (idx === -1) rejected.push({ id, reason: "not on the list" });
		else {
			list.splice(idx, 1);
			dropped.push(id);
		}
	}
	for (const raw of body.add ?? []) {
		const s: PodcastShow = {
			id: String(raw.id ?? ""),
			name: String(raw.name ?? "").trim(),
			rss: String(raw.rss ?? ""),
			scope: raw.scope === "league" ? "league" : String(raw.scope ?? "").toUpperCase(),
			...(raw.appleId ? { appleId: String(raw.appleId) } : {}),
			...(raw.spotifyUrl ? { spotifyUrl: String(raw.spotifyUrl) } : {}),
			...(raw.titleMatch ? { titleMatch: String(raw.titleMatch) } : {}),
			blurb: String(raw.blurb ?? "").trim(),
		};
		const problem = podcastProblem(s);
		if (problem) {
			rejected.push({ id: s.id || undefined, reason: problem });
			continue;
		}
		if (list.some((x) => x.id === s.id)) {
			rejected.push({ id: s.id, reason: "id already on the list" });
			continue;
		}
		if (list.some((x) => x.rss === s.rss)) {
			rejected.push({ id: s.id, reason: "same feed already on the list" });
			continue;
		}
		if (s.scope !== "league" && list.filter((x) => x.scope === s.scope).length >= maxPerClub) {
			rejected.push({ id: s.id, reason: `per-club rail (${maxPerClub}) reached — raise MAX_PODCASTS_PER_CLUB if this show is good` });
			continue;
		}
		list.push(s);
		added.push(s.id);
	}
	return { list, added, dropped, rejected };
}

/** Apple podcast id → the show-level deep links for each supported app (owner: Apple default +
 *  a picker). Episode-level deep links are unreliable across apps, so these are show-level. */
export function showLinks(show: PodcastShow): { apple?: string; spotify?: string; overcast?: string; pocketcasts?: string } {
	const id = show.appleId;
	return {
		apple: id ? `https://podcasts.apple.com/podcast/id${id}` : undefined,
		spotify: show.spotifyUrl,
		overcast: id ? `https://overcast.fm/itunes${id}` : undefined,
		pocketcasts: id ? `https://pca.st/itunes/${id}` : undefined,
	};
}