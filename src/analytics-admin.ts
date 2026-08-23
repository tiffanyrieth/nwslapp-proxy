// Analytics admin dashboard — the READ surface for the anonymous usage counters + the derived
// player-engagement aggregates. Owner-only (admin-key gated). GET /analytics/admin = the page;
// POST /analytics/admin/api = the computed metrics as JSON. Everything shown is AGGREGATE — the
// anonymous counters carry no identity, and the engagement RPC returns only COUNTS. No per-person data.

import { adminAuthed, adminRealm } from "./admin-auth.ts";
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

async function computeMetrics(env: Env): Promise<unknown> {
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
    .map(([week, v]) => ({ week, wau: v.new + v.returning, new: v.new, returning: v.returning }))
    .sort((a, b) => (a.week < b.week ? 1 : -1))
    .slice(0, 8);

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
    weeks,
    sessionLength: sumByParam(rows, "session_length", since30),
    daysActive: sumByParam(rows, "days_active_week", since60),
    tabs: sumByParam(rows, "tab_opened", since30),
    gameOpens: sumByParam(rows, "fanzone_game_opened", since30),
    feedChips: sumByParam(rows, "feed_chip_tapped", since30),
    feedItemTaps: Object.values(sumByParam(rows, "feed_item_tapped", since30)).reduce((a, b) => a + b, 0),
    sessions30d: Object.values(sumByParam(rows, "session_start", since30)).reduce((a, b) => a + b, 0),
    versions: sumByParam(rows, "session_start", since30),
    os: sumByParam(rows, "session_os", since30),
    engagement,
    follows,
  };
}

export async function handleAnalyticsAdmin(request: Request, env: Env): Promise<Response> {
  if (!adminAuthed(request, env.BRACKET_ADMIN_KEY)) {
    return new Response("Authentication required.", {
      status: 401, headers: { "WWW-Authenticate": adminRealm("NWSLApp Admin") },
    });
  }
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
  const wk = (d.weeks||[])[0] || {wau:0,new:0,returning:0,week:'—'};
  const e = d.engagement||{};
  const sl = d.sessionLength||{}; const slTotal = Object.values(sl).reduce((a,b)=>a+b,0);
  let h = '';
  h += '<h2>This week ('+esc(wk.week)+')</h2><div class="grid">';
  h += '<div class="card"><div class="big">'+(wk.wau||0)+'</div><div class="sub">weekly active (all users)</div></div>';
  h += '<div class="card"><div class="big">'+(wk.returning||0)+'</div><div class="sub">returning · '+(wk.new||0)+' new</div></div>';
  h += '<div class="card"><div class="big">'+(e.fanzone_players||0)+'</div><div class="sub">played Fan Zone (signed-in)</div></div>';
  h += '<div class="card"><div class="big">'+(e.new_players||0)+'</div><div class="sub">new signed-in players</div></div>';
  h += '</div>';
  h += '<h2>Weekly active (last weeks)</h2><table><tr><th>week</th><th>WAU</th><th>new</th><th>returning</th></tr>'+
       (d.weeks||[]).map(w=>'<tr><td>'+esc(w.week)+'</td><td>'+w.wau+'</td><td>'+w.new+'</td><td>'+w.returning+'</td></tr>').join('')+'</table>';
  h += '<h2>Fan Zone plays this week (signed-in players)</h2><table><tr><th>game</th><th>players</th></tr>'+
       '<tr><td>Predict</td><td>'+(e.predict_players||0)+'</td></tr>'+
       '<tr><td>Bracket</td><td>'+(e.bracket_players||0)+'</td></tr>'+
       '<tr><td>Know Her Game</td><td>'+(e.khg_players||0)+'</td></tr>'+
       '<tr><td>Trivia</td><td>'+(e.trivia_players||0)+'</td></tr></table>'+
       '<div class="muted">Opens (last 30d) below include signed-out browsing — compare to plays for the funnel.</div>';
  const f = d.follows||{};
  if (f.total_followers){
    const m = f.multi||{};
    const avgTeams = f.total_followers>0 ? (f.total_follows/f.total_followers).toFixed(1) : '—';
    const multiPct = f.total_followers>0 ? Math.round(((m['2']||0)+(m['3']||0)+(m['4plus']||0))/f.total_followers*100) : 0;
    const alertPct = f.total_follows>0 ? Math.round((f.alerts_on||0)/f.total_follows*100) : 0;
    h += '<h2>Following (signed-in users)</h2><div class="grid">';
    h += '<div class="card"><div class="big">'+(f.total_followers||0)+'</div><div class="sub">people following a club</div></div>';
    h += '<div class="card"><div class="big">'+avgTeams+'</div><div class="sub">avg clubs / person</div></div>';
    h += '<div class="card"><div class="big">'+multiPct+'%</div><div class="sub">follow 2+ clubs</div></div>';
    h += '<div class="card"><div class="big">'+alertPct+'%</div><div class="sub">of follows have match alerts on</div></div>';
    h += '</div>';
    h += '<h2>Clubs followed per person</h2><table><tr><th>clubs</th><th>people</th></tr>'+
         ['1','2','3','4plus'].map(k=>'<tr><td>'+k+'</td><td>'+(m[k]||0)+'</td></tr>').join('')+'</table>';
    h += '<h2>Most-followed clubs</h2><table><tr><th>club</th><th>followers</th><th>% of followers</th></tr>'+
         (Object.entries(f.by_team||{}).sort((a,b)=>b[1]-a[1]).map(([t,c])=>'<tr><td>'+esc(t)+'</td><td>'+c+'</td><td>'+pct(c,f.total_followers)+'</td></tr>').join('')||'<tr><td class="muted" colspan=3>no follows yet</td></tr>')+'</table>';
  }
  h += '<h2>Session length (30d)</h2><table><tr><th>bucket</th><th>sessions</th><th>%</th></tr>'+
       ['lt1m','1to5m','5to15m','15to30m','gt30m'].map(b=>'<tr><td>'+b+'</td><td>'+(sl[b]||0)+'</td><td>'+pct(sl[b]||0,slTotal)+'</td></tr>').join('')+'</table>';
  h += '<h2>Days opened / week</h2><table><tr><th>days</th><th>devices</th></tr>'+rows(d.daysActive)+'</table>';
  h += '<h2>Most-opened tabs (30d)</h2><table><tr><th>tab</th><th>opens</th></tr>'+rows(d.tabs)+'</table>';
  h += '<h2>Fan Zone opens (30d)</h2><table><tr><th>game</th><th>opens</th></tr>'+rows(d.gameOpens)+'</table>';
  h += '<h2>Social</h2><table><tr><th>filter</th><th>taps</th></tr>'+rows(d.feedChips)+'</table><div class="muted">content taps (30d): '+(d.feedItemTaps||0)+'</div>';
  h += '<h2>Reach (30d)</h2><div class="muted">sessions: '+(d.sessions30d||0)+'</div>'+
       '<table><tr><th>version</th><th>sessions</th></tr>'+rows(d.versions)+'</table>'+
       '<table style="margin-top:8px"><tr><th>iOS</th><th>sessions</th></tr>'+rows(d.os)+'</table>';
  h += '<div class="muted" style="margin-top:16px">Aggregate only — anonymous counters carry no identity; player counts are distinct-user aggregates, never a person. Generated '+esc(d.generatedAt)+'.</div>';
  document.getElementById('out').innerHTML = h;
  document.getElementById('msg').textContent = '';
}
load();
</script></body></html>`;
