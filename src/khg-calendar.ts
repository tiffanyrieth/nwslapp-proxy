// khg-calendar.ts — the Know Her Game calendar, DERIVED FROM THE NWSL SCHEDULE (2026-09-14).
//
// WHY: the biweekly KHG round has three consumers that must agree — the weekend generator (routine), the
// Monday publish pass (/knowher/publish-verified via the watcher) and the phone's pre-scheduled Tier-1
// "new round" nudge. None of them knew about stoppages: the generator gated on anchor parity alone, and
// the nudge on "after the anchor" alone, so after the season's last round the phone kept promising a new
// round every other Monday all winter while nothing was generated. The fixture list is the one source that
// already knows every stoppage — offseason, World Cup, Olympics, international windows, the June block — and
// the new season's restart the moment ESPN loads the schedule. So the calendar is computed HERE from ESPN,
// served on GET /config (`khgCalendar`), and consulted by the publish pass + the generator; the app mirrors
// the same rule (`FanZoneCadence.knowHerCalendar`) as its offline fallback. Two halves of one contract.
//
// THE RULE (shared verbatim with the app): a KHG drop Monday is LIVE iff ≥1 NWSL league-or-playoff fixture
// (no preseason) kicks off inside that round's 14-day window [monday, monday+14d). Otherwise PAUSED: no
// generation, no publish, no nudge. `seasonEnd` = the first KHG drop Monday after the last fixture.
//
// THE ANCHOR TRAP: the anchor (Week-1 Monday) decides KHG/Trivia parity and every edition key. It is derived
// from the FIRST regular-season fixture ONCE per season and FROZEN in KV — never re-derived mid-season (a
// postponed opener would renumber every round). Pauses are derived live; they carry no keys. The compiled
// SEASON_ANCHOR (assembler) / FanZoneCadence.seasonAnchor (app) stay the parity source this season; the
// served anchor exists so both sides can detect DRIFT (a missed per-season bump) loudly.
//
// Pure helpers first (node --test), the KV/ESPN-touching loader last.

export interface CalendarEvent {
  date?: string;
  /** ESPN's `season.slug`: "regular-season", "playoffs---semifinals", "preseason", … */
  seasonSlug?: string | null;
}

export interface KHGCalendar {
  /** Week-1 Monday, "YYYY-MM-DD" (UTC). The FROZEN per-season anchor. */
  anchor: string;
  /** First KHG drop Monday after the last fixture ("YYYY-MM-DD"), or null when no fixture is known. */
  seasonEnd: string | null;
  /** KHG drop Mondays ("YYYY-MM-DD") whose 14-day round window holds no fixture. Sorted. */
  pausedMondays: string[];
  /** ISO instant the calendar was computed. */
  derivedAt: string;
  /** Owner overrides applied (for the admin page's "what am I looking at"). */
  overrides?: KHGCalendarOverride;
}

/** The owner's escape hatch (KV `config:khg_calendar_override`, admin-managed): force a Monday paused or
 *  live regardless of what ESPN says, or pin the anchor. Applied AFTER derivation. */
export interface KHGCalendarOverride {
  forcePaused?: string[];
  forceLive?: string[];
  anchor?: string;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** UTC midnight of the Monday opening `d`'s week (Mon=1 … Sun=7 → back to Monday). */
export function mondayStart(d: Date): Date {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = u.getUTCDay() || 7;
  u.setUTCDate(u.getUTCDate() - (day - 1));
  return u;
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseYMD(s: string | null | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole weeks between two Mondays (exact — both are UTC midnights). */
function weekOffset(monday: Date, anchor: Date): number {
  return Math.round((monday.getTime() - anchor.getTime()) / WEEK_MS);
}

/** League + playoff kickoffs only (ESPN tags preseason by slug; a missing slug counts — fail-open, a
 *  fixture with unknown type must never pause the game). Unparseable dates are dropped. */
export function fixtureKickoffs(events: CalendarEvent[]): Date[] {
  const out: Date[] = [];
  for (const ev of events) {
    if ((ev.seasonSlug ?? "").startsWith("preseason")) continue;
    if (!ev.date) continue;
    const t = new Date(ev.date);
    if (!Number.isNaN(t.getTime())) out.push(t);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** The Week-1 Monday = the Monday of the week holding the FIRST regular-season fixture (null if none). */
export function deriveAnchor(events: CalendarEvent[]): string | null {
  const regular = fixtureKickoffs(events.filter((e) => (e.seasonSlug ?? "regular-season").startsWith("regular")));
  return regular.length ? ymd(mondayStart(regular[0])) : null;
}

/** THE RULE. Walks `horizonWeeks` from `now`'s week, keeping only KHG drop Mondays (even offsets from the
 *  anchor, never before it); a drop whose 14-day window holds no kickoff is paused; the first drop after the
 *  last kickoff is `seasonEnd` (and the walk stops — everything past it is paused by definition). */
export function computeCalendar(
  events: CalendarEvent[],
  anchorYMD: string,
  now: Date,
  override: KHGCalendarOverride = {},
  horizonWeeks = 60,
): KHGCalendar {
  const anchor = parseYMD(override.anchor ?? anchorYMD) ?? parseYMD(anchorYMD)!;
  const kickoffs = fixtureKickoffs(events);
  const last = kickoffs.length ? kickoffs[kickoffs.length - 1] : null;
  const paused = new Set<string>();
  let seasonEnd: string | null = null;
  let monday = mondayStart(now);
  for (let i = 0; i < horizonWeeks; i++, monday = new Date(monday.getTime() + WEEK_MS)) {
    const off = weekOffset(monday, anchor);
    if (off < 0 || off % 2 !== 0) continue;
    if (last && monday.getTime() > last.getTime()) { seasonEnd = ymd(monday); break; }
    const windowEnd = monday.getTime() + 14 * DAY_MS;
    const live = kickoffs.some((k) => k.getTime() >= monday.getTime() && k.getTime() < windowEnd);
    if (!live) paused.add(ymd(monday));
  }
  for (const m of override.forcePaused ?? []) if (parseYMD(m)) paused.add(m);
  for (const m of override.forceLive ?? []) paused.delete(m);
  return {
    anchor: ymd(anchor),
    seasonEnd,
    pausedMondays: [...paused].sort(),
    derivedAt: now.toISOString(),
    ...(Object.keys(override).length ? { overrides: override } : {}),
  };
}

/** Is the KHG round dropping on `monday` paused under `cal`? (`monday` = "YYYY-MM-DD".) A `forceLive`
 *  override wins over the season end too — the owner's hatch must be able to force a publish. */
export function isPausedMonday(cal: KHGCalendar, monday: string): boolean {
  if (cal.overrides?.forceLive?.includes(monday)) return false;
  if (cal.seasonEnd && monday >= cal.seasonEnd) return true;
  return cal.pausedMondays.includes(monday);
}

// ── Loader (KV-cached derivation; the only part that touches ESPN) ───────────────────────────────

export interface KHGCalendarEnv {
  FEED_TAGS: KVNamespace;
}

export const KHG_CALENDAR_CACHE_KEY = "config:khg_calendar_derived";
export const KHG_CALENDAR_OVERRIDE_KEY = "config:khg_calendar_override";
export const KHG_ANCHOR_KEY = (year: number) => `khg:anchor:${year}`;
/** Recompute at most this often — a schedule change (playoffs loaded, a postponement) lands within 6h. */
export const KHG_CALENDAR_TTL_S = 6 * 3600;

/** The NWSL season a date belongs to (Jan/Feb = the coming season's schedule is what matters). */
export function seasonYear(now: Date): number {
  return now.getUTCFullYear();
}

/** Derive (or serve the ≤6h-old cached) calendar. `fetchEvents(year)` is injected so the loader is testable
 *  and the ESPN fetch stays where the other ESPN calls live. On ANY failure returns null (callers fail open:
 *  /config omits the field, the publish pass proceeds) and reports via `log`. */
export async function loadKnowHerCalendar(
  env: KHGCalendarEnv,
  fetchEvents: (year: number) => Promise<CalendarEvent[]>,
  compiledAnchor: string,
  now: Date,
  log: (kind: string, detail: string) => void,
  force = false,
): Promise<KHGCalendar | null> {
  try {
    const override = await readOverride(env);
    if (!force) {
      const raw = await env.FEED_TAGS.get(KHG_CALENDAR_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as KHGCalendar;
        if (now.getTime() - new Date(cached.derivedAt).getTime() < KHG_CALENDAR_TTL_S * 1000) return cached;
      }
    }
    const year = seasonYear(now);
    // Late in the year the NEXT season's schedule is what says when KHG resumes — include it once it exists.
    const years = now.getUTCMonth() >= 9 ? [year, year + 1] : [year];
    const events = (await Promise.all(years.map((y) => fetchEvents(y).catch(() => [] as CalendarEvent[])))).flat();
    // FREEZE the anchor per season: first derivation wins, never overwritten. Fall back to the compiled
    // constant (and say so) when no regular-season fixture is loaded yet.
    const anchorKey = KHG_ANCHOR_KEY(year);
    let anchor = await env.FEED_TAGS.get(anchorKey);
    if (!anchor) {
      const derived = deriveAnchor(events);
      if (derived) {
        anchor = derived;
        await env.FEED_TAGS.put(anchorKey, anchor);
        if (anchor !== compiledAnchor) log("khgCalendarAnchorDrift", `derived=${anchor} compiled=${compiledAnchor}`);
      } else {
        anchor = compiledAnchor;
      }
    }
    const cal = computeCalendar(events, anchor, now, override);
    await env.FEED_TAGS.put(KHG_CALENDAR_CACHE_KEY, JSON.stringify(cal), { expirationTtl: 7 * 86_400 });
    return cal;
  } catch (e) {
    log("khgCalendarError", e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100));
    return null;
  }
}

export async function readOverride(env: KHGCalendarEnv): Promise<KHGCalendarOverride> {
  try {
    const raw = await env.FEED_TAGS.get(KHG_CALENDAR_OVERRIDE_KEY);
    return raw ? (JSON.parse(raw) as KHGCalendarOverride) : {};
  } catch {
    return {};
  }
}

export async function writeOverride(env: KHGCalendarEnv, override: KHGCalendarOverride): Promise<void> {
  const clean: KHGCalendarOverride = {};
  if (override.forcePaused?.length) clean.forcePaused = [...new Set(override.forcePaused)].sort();
  if (override.forceLive?.length) clean.forceLive = [...new Set(override.forceLive)].sort();
  if (override.anchor) clean.anchor = override.anchor;
  if (Object.keys(clean).length === 0) {
    await env.FEED_TAGS.delete(KHG_CALENDAR_OVERRIDE_KEY);
  } else {
    await env.FEED_TAGS.put(KHG_CALENDAR_OVERRIDE_KEY, JSON.stringify(clean));
  }
  // Any override change invalidates the derived cache so /config reflects it within the 5-min edge cache.
  await env.FEED_TAGS.delete(KHG_CALENDAR_CACHE_KEY);
}
