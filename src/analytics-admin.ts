// Analytics admin dashboard — the READ surface for the anonymous usage counters + the derived
// player-engagement aggregates. Owner-only (admin-key gated). GET /analytics/admin = the page;
// POST /analytics/admin/api = the computed metrics as JSON. Everything shown is AGGREGATE — the
// anonymous counters carry no identity, and the engagement RPC returns only COUNTS. No per-person data.

import { adminGate, type AdminAuthEnv } from "./admin-auth.ts";
import { fetchTeamAbbrs } from "./bracket-engine.ts";

interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  BRACKET_ADMIN_KEY?: string;
}

interface CounterRow { day: string; event: string; param: string; count: number }

/** Standard ISO-8601 week key "YYYY-Www" (Thursday-based, UTC) for a "YYYY-MM-DD" day string. */
function isoWeek(dayStr: string): string {
  const d = new Date(dayStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;            // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow + 3);         // shift to the week's Thursday
  const year = d.getUTCFullYear();
  const firstThu = new Date(Date.UTC(year, 0, 4));
  const firstDow = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDow + 3);
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function daysAgoISO(n: number, now: number): string {
  return new Date(now - n * 86400000).toISOString().slice(0, 10);
}

// ── Human-readable period labels (owner's 2026-09-05 relabel: business shorthand, never ISO keys) ──
// Deterministic (no Intl/locale) so node --test pins them exactly.
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_LONG  = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** Monday (UTC) of ISO week "YYYY-Www". ISO week 1 is the week containing Jan 4. */
export function isoWeekMonday(weekKey: string): Date {
  const [y, w] = weekKey.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const dow = (jan4.getUTCDay() + 6) % 7;            // Mon=0 … Sun=6
  const week1Mon = Date.UTC(y, 0, 4 - dow);
  return new Date(week1Mon + (w - 1) * 7 * 86400000);
}

/** "Aug 25–31" or, across a month boundary, "Aug 30 – Sep 5". */
export function isoWeekDateRange(weekKey: string): string {
  const mon = isoWeekMonday(weekKey);
  const sun = new Date(mon.getTime() + 6 * 86400000);
  const m1 = MONTH_SHORT[mon.getUTCMonth()], m2 = MONTH_SHORT[sun.getUTCMonth()];
  return m1 === m2
    ? `${m1} ${mon.getUTCDate()}–${sun.getUTCDate()}`
    : `${m1} ${mon.getUTCDate()} – ${m2} ${sun.getUTCDate()}`;
}

/** "2026-09" → "September". */
export function monthLabel(yyyymm: string): string {
  const m = Number(yyyymm.slice(5, 7));
  return MONTH_LONG[m - 1] ?? yyyymm;
}

export interface WeekRow { week: string; wau: number; new: number; returning: number }
export interface MonthRow { month: string; mau: number; new: number; returning: number }

/** The headline periods (owner's A2 layout, 2026-09-05 — "last week + month to date", the way a
 *  business dashboard reads): the most recent COMPLETED ISO week (strictly before the current key),
 *  the current week so far (personal-reflection only), and the current month to date. `weeks` /
 *  `months` are newest-first; keys compare lexicographically (zero-padded), incl. year rollover. */
export function pickHeadline(weeks: WeekRow[], months: MonthRow[], todayISO: string) {
  const currentWeekKey = isoWeek(todayISO);
  const currentMonthKey = todayISO.slice(0, 7);
  return {
    currentWeekKey,
    currentMonthKey,
    lastCompletedWeek: weeks.find((w) => w.week < currentWeekKey) ?? null,
    currentWeekSoFar: weeks.find((w) => w.week === currentWeekKey) ?? null,
    monthToDate: months.find((m) => m.month === currentMonthKey) ?? null,
  };
}

/** The Feed filters that exist in the app TODAY (FeedViewModel.ContentFilter: all/reporters/players).
 *  The "clubs" chip was removed, but its taps linger in the 30-day counters from older builds — hide
 *  any param not in this set so the dashboard never shows a ghost filter. Add here when the app adds one. */
const LIVE_FEED_FILTERS = new Set(["all", "reporters", "players"]);
export function onlyLiveFilters(chips: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(chips)) if (LIVE_FEED_FILTERS.has(k)) out[k] = v;
  return out;
}

async function sbGet<T>(env: Env, path: string): Promise<T> {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
    },
  });
  if (!r.ok) throw new Error(`sbGet ${path} → ${r.status}`);
  return (await r.json()) as T;
}

async function sbRpc<T>(env: Env, fn: string, body: unknown): Promise<T> {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbRpc ${fn} → ${r.status}`);
  return (await r.json()) as T;
}

/** Sum a counter's rows over a day-window, grouped by param. */
function sumByParam(rows: CounterRow[], event: string, sinceDay: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.event === event && r.day >= sinceDay) out[r.param] = (out[r.param] ?? 0) + Number(r.count);
  }
  return out;
}

export async function computeMetrics(env: Env): Promise<unknown> {
  const now = Date.now();
  const since60 = daysAgoISO(60, now);
  const since30 = daysAgoISO(30, now);
  const since7 = new Date(now - 7 * 86400000).toISOString();

  // The whole counters table is tiny (events × params × days); pull 60 days and fold in JS.
  const rows = await sbGet<CounterRow[]>(
    env, `analytics_counters?day=gte.${since60}&select=day,event,param,count&limit=100000`);

  // WAU by ISO week from active_week (each device counts once/week → sum = WAU), split new/returning.
  const weekMap: Record<string, { new: number; returning: number }> = {};
  for (const r of rows) {
    if (r.event !== "active_week") continue;
    const w = isoWeek(r.day);
    (weekMap[w] ??= { new: 0, returning: 0 });
    if (r.param === "new") weekMap[w].new += Number(r.count);
    else weekMap[w].returning += Number(r.count);
  }
  const weeks = Object.entries(weekMap)
    .map(([week, v]) => ({ week, range: isoWeekDateRange(week), wau: v.new + v.returning, new: v.new, returning: v.returning }))
    .sort((a, b) => (a.week < b.week ? 1 : -1))
    .slice(0, 8);

  // MAU by calendar month from active_month (each device counts once/month → sum = MAU), split new/returning.
  // The honest reach measure — a soccer app people don't open every week. 60-day pull gives ~2-3 months.
  const monthMap: Record<string, { new: number; returning: number }> = {};
  for (const r of rows) {
    if (r.event !== "active_month") continue;
    const m = r.day.slice(0, 7);                    // YYYY-MM
    (monthMap[m] ??= { new: 0, returning: 0 });
    if (r.param === "new") monthMap[m].new += Number(r.count);
    else monthMap[m].returning += Number(r.count);
  }
  const months = Object.entries(monthMap)
    .map(([month, v]) => ({ month, name: monthLabel(month), mau: v.new + v.returning, new: v.new, returning: v.returning }))
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .slice(0, 3);

  // Resilient: if the engagement RPC isn't applied yet, still render the counter metrics.
  let engagement: Record<string, number> = {};
  try {
    engagement = await sbRpc<Record<string, number>>(env, "analytics_engagement", { p_since: since7 });
  } catch { /* engagement panel shows zeros until migration_analytics_dashboard.sql is applied */ }

  // Follow analytics (derived from the follows + alert-pref tables — no new tracking). Map ESPN team ids
  // to club abbreviations for display. Both best-effort so the dashboard never breaks on one miss.
  let follows: Record<string, unknown> = {};
  try {
    const raw = await sbRpc<{ by_team?: Record<string, number>; [k: string]: unknown }>(env, "analytics_follows", {});
    let abbrById = new Map<string, string>();
    try { abbrById = new Map((await fetchTeamAbbrs()).map((t) => [t.id, t.abbr])); } catch { /* raw ids */ }
    const byTeam: Record<string, number> = {};
    for (const [id, c] of Object.entries(raw.by_team ?? {})) byTeam[abbrById.get(id) ?? id] = c;
    follows = { ...raw, by_team: byTeam };
  } catch { /* follows panel shows nothing until the follows RPC is applied */ }

  return {
    generatedAt: new Date(now).toISOString(),
    // Headline periods: last COMPLETED week + month to date (the calendar cards reset at the
    // boundary by design — a device self-counts once per ISO week / calendar month — so the
    // honest glance is the finished week, not the partial one).
    headline: (() => {
      const h = pickHeadline(weeks, months, new Date(now).toISOString().slice(0, 10));
      return {
        ...h,
        lastCompletedWeekRange: h.lastCompletedWeek ? isoWeekDateRange(h.lastCompletedWeek.week) : null,
        currentWeekRange: isoWeekDateRange(h.currentWeekKey),
        monthName: monthLabel(h.currentMonthKey),
      };
    })(),
    weeks,
    months,
    daysActive: sumByParam(rows, "days_active_week", since60),
    tabs: sumByParam(rows, "tab_opened", since30),
    gameOpens: sumByParam(rows, "fanzone_game_opened", since30),
    feedChips: onlyLiveFilters(sumByParam(rows, "feed_chip_tapped", since30)),
    feedItemTaps: Object.values(sumByParam(rows, "feed_item_tapped", since30)).reduce((a, b) => a + b, 0),
    sessions30d: Object.values(sumByParam(rows, "session_start", since30)).reduce((a, b) => a + b, 0),
    versions: sumByParam(rows, "session_start", since30),
    os: sumByParam(rows, "session_os", since30),
    engagement,
    follows,
  };
}

export async function handleAnalyticsAdmin(request: Request, env: Env): Promise<Response> {
  // Portal surface → the full gate (key + throttle + the Access JWT once armed). Part B 2026-08-24.
  const gate = await adminGate(request, env as unknown as AdminAuthEnv, { jwt: true });
  if (gate) return gate;
  const url = new URL(request.url);
  if (url.pathname === "/analytics/admin/api") {
    try {
      return Response.json(await computeMetrics(env));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }
  return new Response(ANALYTICS_ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const ANALYTICS_ADMIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Analytics</title>
<style>
  body { font-family:-apple-system,system-ui,sans-serif; background:#000; color:#eee; margin:0; padding:16px; }
  h2 { font-size:15px; margin:20px 0 8px; color:#9ad; }
  .grid { display:flex; flex-wrap:wrap; gap:12px; }
  .card { background:#1c1c1e; border-radius:10px; padding:14px 16px; min-width:140px; }
  .big { font-size:28px; font-weight:800; }
  .sub { color:#999; font-size:12px; margin-top:2px; }
  table { border-collapse:collapse; width:100%; max-width:640px; }
  th,td { text-align:left; padding:5px 10px; border-bottom:1px solid #2c2c2e; font-size:13px; }
  th { color:#999; font-weight:600; }
  .muted { color:#888; font-size:12px; }
  .err { color:#f66; }
  button { background:#2c2c2e; color:#eee; border:1px solid #444; border-radius:8px; padding:6px 12px; cursor:pointer; }
</style></head><body>
<div class="row"><button onclick="load()">Refresh</button> <span id="msg" class="muted"></span></div>
<div id="out"></div>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
function pct(part, total){ return total>0 ? Math.round(part/total*100)+"%" : "—"; }
function rows(obj){ const e=Object.entries(obj||{}).sort((a,b)=>b[1]-a[1]); return e.length? e.map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+v+'</td></tr>').join('') : '<tr><td class="muted" colspan=2>no data yet</td></tr>'; }
async function load(){
  document.getElementById('msg').textContent = 'Loading…';
  let d; try { const r = await fetch('/analytics/admin/api',{method:'POST'}); d = await r.json(); } catch(e){ document.getElementById('out').innerHTML='<div class="err">Failed to load.</div>'; return; }
  if (d.error){ document.getElementById('out').innerHTML='<div class="err">Error: '+esc(d.error)+'</div>'; return; }
  // Owner's 2026-09-05 relabel: business shorthand ("last week", "month to date", "last 30 days"),
  // scope on EVERY section, human date ranges — never ISO keys, never wordy explainers.
  const H = d.headline||{};
  const lw = H.lastCompletedWeek || {wau:0,new:0,returning:0};
  const cw = H.currentWeekSoFar || {wau:0,new:0,returning:0};
  const mtd = H.monthToDate || {mau:0,new:0,returning:0};
  const e = d.engagement||{};
  const card = (big, sub) => '<div class="card"><div class="big">'+big+'</div><div class="sub">'+sub+'</div></div>';
  // Coarsen the days-opened-per-week buckets (1/2/3to4/5to7) to the owner's once/twice/3+ view.
  const cadence = (obj) => { const o={'1 day':0,'2 days':0,'3+ days':0}; for(const [k,v] of Object.entries(obj||{})){ if(k==='1')o['1 day']+=v; else if(k==='2')o['2 days']+=v; else o['3+ days']+=v; } return o; };
  let h = '';
  // ── Headline: last COMPLETED week (the honest glance) + month to date ──
  h += '<h2>Active users — last week ('+esc(H.lastCompletedWeekRange||'no completed week yet')+')</h2><div class="grid">';
  h += card(lw.wau||0, 'active devices');
  h += card(lw.returning||0, 'returning · '+(lw.new||0)+' new');
  h += card(e.fanzone_players||0, 'played Fan Zone (signed-in, last 7 days)');
  h += card(e.new_players||0, 'new signed-in accounts (last 7 days)');
  h += '</div>';
  h += '<div class="muted">This week so far ('+esc(H.currentWeekRange||'')+'): '+(cw.wau||0)+' active devices · '+(cw.returning||0)+' returning · '+(cw.new||0)+' new</div>';
  h += '<h2>Active users — '+esc(H.monthName||'this month')+' (month to date)</h2><div class="grid">';
  h += card(mtd.mau||0, 'active devices');
  h += card(mtd.returning||0, 'returning · '+(mtd.new||0)+' new');
  h += '</div>';
  h += '<div class="muted">Active devices = anonymous app opens (no identity). New signed-in accounts = profiles created; inflated by test accounts until the pre-launch purge.</div>';
  // ── History (completed periods) ──
  h += '<h2>Monthly active (last months)</h2><table><tr><th>month</th><th>active devices</th><th>new</th><th>returning</th></tr>'+
       (d.months||[]).map(m=>'<tr><td>'+esc(m.name||m.month)+'</td><td>'+m.mau+'</td><td>'+m.new+'</td><td>'+m.returning+'</td></tr>').join('')+'</table>';
  h += '<h2>Weekly active (last 8 weeks)</h2><table><tr><th>week</th><th>active devices</th><th>new</th><th>returning</th></tr>'+
       (d.weeks||[]).map(w=>'<tr><td>'+esc(w.range||w.week)+(w.week===H.currentWeekKey?' <span class="muted">(so far)</span>':'')+'</td><td>'+w.wau+'</td><td>'+w.new+'</td><td>'+w.returning+'</td></tr>').join('')+'</table>';
  h += '<h2>Fan Zone plays (signed-in, last 7 days)</h2><table><tr><th>game</th><th>players</th></tr>'+
       '<tr><td>Predict</td><td>'+(e.predict_players||0)+'</td></tr>'+
       '<tr><td>Bracket</td><td>'+(e.bracket_players||0)+'</td></tr>'+
       '<tr><td>Know Her Game</td><td>'+(e.khg_players||0)+'</td></tr>'+
       '<tr><td>Trivia</td><td>'+(e.trivia_players||0)+'</td></tr></table>'+
       '<div class="muted">Fan Zone opens (last 30 days) below include signed-out browsing.</div>';
  // ── Following: signed-in accounts ACTIVE in the last 180 days (a count-only scope; nothing is deleted) ──
  const f = d.follows||{};
  if (f.total_followers){
    const m = f.multi||{};
    const avgTeams = f.total_followers>0 ? (f.total_follows/f.total_followers).toFixed(1) : '—';
    const multiPct = f.total_followers>0 ? Math.round(((m['2']||0)+(m['3']||0)+(m['4plus']||0))/f.total_followers*100) : 0;
    const alertPct = f.total_follows>0 ? Math.round((f.alerts_on||0)/f.total_follows*100) : 0;
    h += '<h2>Following (signed-in accounts active in the last 180 days)</h2><div class="grid">';
    h += card(f.total_followers||0, 'people following a club');
    h += card(avgTeams, 'avg clubs per person');
    h += card(multiPct+'%', 'follow 2+ clubs');
    h += card(alertPct+'%', 'of follows have match alerts on');
    h += '</div>';
    h += '<h2>Clubs followed per person (current)</h2><table><tr><th>clubs</th><th>people</th></tr>'+
         ['1','2','3','4plus'].map(k=>'<tr><td>'+(k==='4plus'?'4+':k)+'</td><td>'+(m[k]||0)+'</td></tr>').join('')+'</table>';
    h += '<h2>Most-followed clubs (current)</h2><table><tr><th>club</th><th>followers</th><th>% of followers</th></tr>'+
         (Object.entries(f.by_team||{}).sort((a,b)=>b[1]-a[1]).map(([t,c])=>'<tr><td>'+esc(t)+'</td><td>'+c+'</td><td>'+pct(c,f.total_followers)+'</td></tr>').join('')||'<tr><td class="muted" colspan=3>no follows yet</td></tr>')+'</table>';
  }
  const cad = cadence(d.daysActive);
  h += '<h2>Days opened per week (last 8 weeks)</h2><table><tr><th>days opened</th><th>device-weeks</th></tr>'+
       ['1 day','2 days','3+ days'].map(k=>'<tr><td>'+esc(k)+'</td><td>'+(cad[k]||0)+'</td></tr>').join('')+'</table>';
  h += '<h2>Most-opened tabs (last 30 days)</h2><table><tr><th>tab</th><th>opens</th></tr>'+rows(d.tabs)+'</table>';
  h += '<h2>Fan Zone opens (last 30 days)</h2><table><tr><th>game</th><th>opens</th></tr>'+rows(d.gameOpens)+'</table>';
  // Two different meters, kept apart: switching a filter chip vs opening a piece of content.
  h += '<h2>Feed filter taps (last 30 days)</h2><table><tr><th>filter</th><th>taps</th></tr>'+rows(d.feedChips)+'</table>';
  h += '<h2>Content opens (last 30 days)</h2><div class="grid">'+card(d.feedItemTaps||0, 'feed posts opened')+'</div>';
  h += '<h2>Sessions (last 30 days)</h2><div class="grid">'+card(d.sessions30d||0, 'sessions')+'</div>'+
       '<table><tr><th>app version</th><th>sessions</th></tr>'+rows(d.versions)+'</table>'+
       '<table style="margin-top:8px"><tr><th>iOS</th><th>sessions</th></tr>'+rows(d.os)+'</table>';
  h += '<div class="muted" style="margin-top:16px">Aggregate only — anonymous counters carry no identity; account counts are aggregates, never a person. Generated '+esc(d.generatedAt)+'.</div>';
  document.getElementById('out').innerHTML = h;
  document.getElementById('msg').textContent = '';
}
load();
</script></body></html>`;
