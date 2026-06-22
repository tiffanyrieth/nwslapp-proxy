// Operator-only Bracket Battle admin panel — a single self-contained HTML page served by the
// Worker at GET /bracket/admin. The shell is public markup (no secrets); every data/control
// call goes to POST /bracket/admin/api with the operator's BRACKET_ADMIN_KEY in the
// `x-admin-key` header (entered once, kept in sessionStorage). Functional, not pretty.
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Bracket Battle — Admin</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 16px; background:#111; color:#eee; font:14px/1.45 -apple-system,system-ui,sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:#9ad; margin:22px 0 8px; border-bottom:1px solid #333; padding-bottom:4px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:6px 0; }
  button { background:#2a2a2e; color:#eee; border:1px solid #444; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:13px; }
  button:hover { background:#36363c; }
  button.danger { border-color:#a44; color:#f99; }
  button.go { border-color:#4a7; color:#9f9; }
  input, select { background:#1c1c1e; color:#eee; border:1px solid #444; border-radius:6px; padding:6px 8px; font-size:13px; }
  input.k { width:340px; max-width:60vw; }
  table { border-collapse:collapse; width:100%; margin:4px 0; }
  th, td { text-align:left; padding:5px 8px; border-bottom:1px solid #2a2a2a; vertical-align:top; }
  th { color:#999; font-weight:600; font-size:12px; }
  .pill { font-size:11px; padding:1px 7px; border-radius:10px; border:1px solid #555; }
  .ready { color:#9f9; border-color:#4a7; } .parked { color:#fc6; border-color:#a83; } .used { color:#999; }
  .kv { color:#9cf; } .muted { color:#888; }
  #msg { margin:8px 0; padding:8px 10px; border-radius:6px; background:#1c2a1c; min-height:18px; white-space:pre-wrap; }
  #msg.err { background:#2a1c1c; color:#f99; }
  .card { background:#1a1a1d; border:1px solid #2c2c30; border-radius:8px; padding:10px 12px; }
  small { color:#888; }
</style>
</head>
<body>
<h1>Bracket Battle — Admin</h1>
<small>Operator-only. Nothing here is user-facing.</small>

<div class="row" style="margin-top:10px">
  <input class="k" id="key" type="password" placeholder="BRACKET_ADMIN_KEY" autocomplete="off">
  <button class="go" onclick="saveKey()">Save key + load</button>
  <button onclick="refresh()">Refresh</button>
  <span id="tick" class="muted"></span>
</div>
<div id="msg"></div>

<h2>Current state</h2>
<div id="state" class="card">—</div>

<h2>Edition control</h2>
<div class="row">
  <button class="go" onclick="doAction('start_edition','Start the NEXT rotation edition?')">Start next (rotation)</button>
  <select id="startPick"></select>
  <button class="go" onclick="startSpecific()">Start specific</button>
</div>
<div class="row">
  <button onclick="doAction('advance_round','Advance the current round? This tallies votes and opens the next round.')">Advance round</button>
  <button class="danger" onclick="doAction('close_edition','Close + complete the active edition? This finishes the game.')">Close / complete</button>
  <button onclick="doAction('pause')">Pause</button>
  <button onclick="doAction('resume')">Resume</button>
</div>

<h2>Library — creative</h2>
<div class="row">
  <input id="newTitle" placeholder="New creative theme title">
  <button class="go" onclick="addCreative()">Add creative theme</button>
</div>
<div id="creative">—</div>

<h2>Library — stats</h2>
<div id="stats">—</div>

<h2>Queue / rotation</h2>
<div id="rotation" class="card">—</div>

<h2>History</h2>
<div id="history">—</div>

<script>
const KEY_LS = 'bracketAdminKey';
function getKey(){ return sessionStorage.getItem(KEY_LS) || document.getElementById('key').value || ''; }
function saveKey(){ sessionStorage.setItem(KEY_LS, document.getElementById('key').value.trim()); refresh(); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function setMsg(t, err){ const m=document.getElementById('msg'); m.textContent=t; m.className = err?'err':''; }

async function api(op, extra){
  const r = await fetch('/bracket/admin/api', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-admin-key': getKey() },
    body: JSON.stringify(Object.assign({op}, extra||{})),
  });
  if (r.status === 403){ setMsg('Forbidden — wrong or missing admin key.', true); throw new Error('forbidden'); }
  const j = await r.json().catch(()=>({error:'bad response'}));
  if (j && j.error) setMsg('Error: '+j.error, true);
  return j;
}

async function refresh(){
  try {
    const s = await api('state');
    if (s && s.error) return;
    renderState(s);
    if (!document.getElementById('msg').classList.contains('err')) setMsg('Loaded '+new Date().toLocaleTimeString());
  } catch(e){ /* msg already set */ }
}

function fmt(ts){ return ts ? new Date(ts).toLocaleString() : '—'; }

function renderState(s){
  const c = s.config || {}, a = s.active;
  const modeBtn = '<button onclick="setMode(\\''+(c.mode==='auto'?'manual':'auto')+'\\')">Switch to '+(c.mode==='auto'?'MANUAL':'AUTO')+'</button>';
  let html = '<div class="row"><b>Mode:</b> <span class="pill '+(c.mode==='manual'?'ready':'parked')+'">'+esc(c.mode)+'</span> '+modeBtn+' <span class="muted">season '+esc(c.season)+'</span></div>';
  if (a){
    html += '<div class="row"><b>Active:</b> '+esc(a.title)+' <span class="muted">('+esc(a.type)+')</span></div>'+
      '<table><tr><th>round</th><th>total rounds</th><th>pool</th><th>votes this round</th><th>round closes</th><th>active</th></tr>'+
      '<tr><td>'+esc(a.current_round)+'</td><td>'+esc(a.total_rounds)+'</td><td>'+esc(a.pool_size)+'</td><td>'+esc(a.thisRoundVotes)+'</td><td>'+fmt(a.round_closes_at)+'</td><td>'+esc(a.is_active)+'</td></tr></table>';
  } else {
    html += '<div class="row muted">No active edition.</div>';
  }
  if (c.manualAction) html += '<div class="row muted">queued manual_action: '+esc(c.manualAction)+'</div>';
  document.getElementById('state').innerHTML = html;

  // start-specific dropdown (all ready themes)
  const ready = [].concat((s.creative||[]).filter(t=>t.status==='ready').map(t=>({id:t.id,title:t.title,k:'creative'})),
                          (s.stats||[]).filter(t=>t.status==='ready').map(t=>({id:t.id,title:t.title,k:'stats'})));
  document.getElementById('startPick').innerHTML = '<option value="">— ready theme —</option>'+
    ready.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.title)+' ('+t.k+')</option>').join('');

  document.getElementById('creative').innerHTML = libTable(s.creative||[], 'creative', true);
  document.getElementById('stats').innerHTML = libTable(s.stats||[], 'stats', false);

  const np = s.nextPick;
  document.getElementById('rotation').innerHTML =
    '<div class="row"><b>Next auto-pick:</b> '+(np ? esc(np.title)+' <span class="muted">('+esc(np.type)+')</span>' : '<span class="muted">none ready</span>')+'</div>'+
    '<div class="row"><b>Used this season:</b> <span class="muted">'+((c.usedThemes&&c.usedThemes.length)?c.usedThemes.map(esc).join(', '):'(none)')+'</span> '+
    '<button onclick="clearUsed()">Clear used themes</button></div>';

  document.getElementById('history').innerHTML = histTable(s.history||[]);
}

function statusPill(st){ return '<span class="pill '+esc(st)+'">'+esc(st)+'</span>'; }

function libTable(rows, kind, canAdd){
  if (!rows.length) return '<div class="muted">none</div>';
  let h = '<table><tr><th>title</th><th>status</th><th>actions</th></tr>';
  for (const r of rows){
    h += '<tr><td>'+esc(r.title)+'</td><td>'+statusPill(r.status)+'</td><td class="row">'+
      '<button onclick="editTitle(\\''+kind+'\\',\\''+esc(r.id)+'\\')">Edit title</button>'+
      (r.status==='ready' ? '<button onclick="setStatus(\\''+kind+'\\',\\''+esc(r.id)+'\\',\\'parked\\')">Park</button>'
                          : '<button onclick="setStatus(\\''+kind+'\\',\\''+esc(r.id)+'\\',\\'ready\\')">Set ready</button>')+
      '<button class="danger" onclick="delTheme(\\''+kind+'\\',\\''+esc(r.id)+'\\')">Delete</button>'+
      '</td></tr>';
  }
  return h+'</table>';
}

function histTable(rows){
  if (!rows.length) return '<div class="muted">no completed editions</div>';
  let h = '<table><tr><th>title</th><th>type</th><th>rounds</th><th>votes</th><th>winner</th><th>created</th><th>completed</th></tr>';
  for (const e of rows){
    h += '<tr><td>'+esc(e.title)+'</td><td>'+esc(e.type)+'</td><td>'+esc(e.total_rounds)+'</td><td>'+esc(e.totalVotes)+'</td><td>'+esc(e.winner||'—')+'</td><td>'+fmt(e.created_at)+'</td><td>'+fmt(e.completed_at)+'</td></tr>';
  }
  return h+'</table>';
}

async function doAction(action, confirmText){ if (confirmText && !confirm(confirmText)) return; const r = await api('action',{action}); if (r && r.message) setMsg(r.message); refresh(); }
async function startSpecific(){ const id = document.getElementById('startPick').value; if (!id){ setMsg('Pick a ready theme first.', true); return; } if (!confirm('Start "'+id+'" now?')) return; const r = await api('action',{action:'start_edition:'+id}); if (r && r.message) setMsg(r.message); refresh(); }
async function setMode(mode){ await api('setMode',{mode}); refresh(); }
async function addCreative(){ const el=document.getElementById('newTitle'); const title=el.value.trim(); if(!title){ setMsg('Enter a title.', true); return; } await api('themeAdd',{title}); el.value=''; refresh(); }
async function editTitle(kind,id){ const title=prompt('New title:'); if(title==null) return; const t=title.trim(); if(!t) return; await api('themeEditTitle',{kind,id,title:t}); refresh(); }
async function setStatus(kind,id,status){ await api('themeStatus',{kind,id,status}); refresh(); }
async function delTheme(kind,id){ if(!confirm('Delete theme "'+id+'"?')) return; await api('themeDelete',{kind,id}); refresh(); }
async function clearUsed(){ if(!confirm('Clear used_themes_this_season (reset rotation)?')) return; await api('clearUsedThemes'); refresh(); }

// Next cron tick (the */5 bracket cron) — pure client clock, no server call.
setInterval(()=>{
  const now = new Date(); const ms = (5 - (now.getUTCMinutes()%5))*60000 - now.getUTCSeconds()*1000 - now.getMilliseconds();
  const s = Math.max(0, Math.round(ms/1000));
  document.getElementById('tick').textContent = 'next */5 tick in ~'+Math.floor(s/60)+'m'+String(s%60).padStart(2,'0')+'s';
}, 1000);

// Auto-load if a key is already in this session.
if (sessionStorage.getItem(KEY_LS)){ document.getElementById('key').value = sessionStorage.getItem(KEY_LS); refresh(); }
</script>
</body>
</html>`;
