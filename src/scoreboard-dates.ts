// ESPN scoreboard date-shape classification (2026-09-16 incident). Pure — no Worker globals — so it
// runs under `node --test test/scoreboard-dates.test.ts`.
//
// ESPN broke the hyphenated `dates=A-B` RANGE form on the scoreboard endpoint: every range 400s
// ("Failed to get events endpoint", verified live from a clean IP), which blanked the schedule and the
// live watcher (both send ranges). NON-range forms still work — year-only `dates=YYYY` (the full
// season) and single-day `dates=YYYYMMDD`. classifyScoreboardDates() decides how to rewrite an
// incoming `dates` value before it reaches ESPN (the rewrite itself lives in index.ts, which needs
// Worker globals to fetch + merge).

const SCOREBOARD_RANGE_RE = /^(\d{8})-(\d{8})$/;

/** A JS Date at UTC midnight for a YYYYMMDD string. */
export function ymdToUTC(ymd: string): Date {
	return new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
}

/** YYYYMMDD for a Date, in UTC. */
export function utcYmd(d: Date): string {
	return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export type ScoreboardDateShape =
	| { mode: "passthrough" }
	| { mode: "year"; year: string }
	| { mode: "window"; days: string[] };

/**
 * Classify an incoming `dates` value. Only hyphenated 8-8 ranges are rewritten:
 *   • a wide range (the full-season `YYYY0101-YYYY1231` load) → `{year}` (one fetch of `dates=YYYY`);
 *   • a narrow range (the `<yesterday>-<tomorrow>` live window) → the list of UTC days it spans,
 *     fetched per-day and merged (see proxyScoreboardWindow in index.ts).
 * Year-only, single-day, absent, or anything malformed passes through untouched — ESPN accepts those.
 * The 8-day threshold separates the two real shapes (3-day window vs ~365-day season) with wide margin.
 */
export function classifyScoreboardDates(dates: string | null | undefined): ScoreboardDateShape {
	if (!dates) return { mode: "passthrough" };
	const m = SCOREBOARD_RANGE_RE.exec(dates);
	if (!m) return { mode: "passthrough" };
	const [, a, b] = m;
	const start = ymdToUTC(a);
	const end = ymdToUTC(b);
	if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return { mode: "passthrough" };
	const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
	if (spanDays > 8) return { mode: "year", year: a.slice(0, 4) };
	const days: string[] = [];
	for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) days.push(utcYmd(new Date(t)));
	return { mode: "window", days };
}
