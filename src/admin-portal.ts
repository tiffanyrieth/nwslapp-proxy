// The single operator portal — GET /admin. One URL, one password, three tabs.
//
// Before this there were two separate password-protected pages (/bracket/admin, /knowher/admin)
// and roster verification would have made a third. They share one HTTP Basic realm, so a shell
// page can host all three and the browser authenticates once for the whole origin.
//
// ⚠️ WHY THE OTHER TWO ARE IFRAMED, deliberately. Both existing panels are complete, working HTML
// DOCUMENTS (own <head>, own styles, own POST wiring) and one of them drives a LIVE Bracket. Cutting
// them apart to inline their markup would risk breaking a running game to gain nothing the operator
// can see — the tabs, the single URL and the single password prompt all work either way. Their old
// URLs keep working unchanged, so this shell is additive and reversible: delete it and nothing is lost.
//
// The Roster tab is native (it's new, so there's nothing to preserve) and talks to POST /admin/roster.

export const ADMIN_PORTAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>NWSLApp — Admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#111; color:#eee; font:14px/1.45 -apple-system,system-ui,sans-serif; }
  header { padding:12px 16px 0; }
  h1 { font-size:18px; margin:0 0 10px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:#9ad; margin:20px 0 8px; border-bottom:1px solid #333; padding-bottom:4px; }
  nav { display:flex; gap:4px; border-bottom:1px solid #333; padding:0 16px; }
  nav button { background:none; border:none; border-bottom:2px solid transparent; color:#999; padding:8px 14px; cursor:pointer; font-size:14px; }
  nav button:hover { color:#ddd; }
  nav button.on { color:#fff; border-bottom-color:#9ad; }
  .panel { display:none; }
  .panel.on { display:block; }
  #roster { padding:0 16px 40px; }
  iframe { display:block; width:100%; height:calc(100vh - 92px); border:0; background:#111; }
  table { border-collapse:collapse; width:100%; margin:4px 0; }
  th, td { text-align:left; padding:5px 8px; border-bottom:1px solid #2a2a2a; vertical-align:middle; }
  th { color:#999; font-weight:600; font-size:12px; }
  button.act { background:#2a2a2e; color:#eee; border:1px solid #444; border-radius:6px; padding:4px 9px; cursor:pointer; font-size:12px; }
  button.act:hover { background:#36363c; }
  button.go { border-color:#4a7; color:#9f9; }
  button.danger { border-color:#a44; color:#f99; }
  .pill { font-size:11px; padding:1px 7px; border-radius:10px; border:1px solid #555; }
  .ok { color:#9f9; border-color:#4a7; } .warn { color:#fc6; border-color:#a83; } .bad { color:#f99; border-color:#a44; }
  .muted { color:#888; }
  .small { font-size:12px; }
  .note { background:#17171a; border:1px solid #2a2a2e; border-left:3px solid #9ad; padding:8px 10px; margin:10px 0; font-size:12.5px; color:#bbb; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:8px 0; }
  code { background:#1c1c1e; padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<header><h1>NWSLApp — Admin</h1></header>
<nav>
  <button class="on" data-tab="roster">Roster</button>
  <button data-tab="status">Status</button>
  <button data-tab="bracket">The Bracket</button>
  <button data-tab="knowher">Know Her Game</button>
</nav>

<div class="panel on" id="roster">
  <div class="row">
    <button class="act go" id="run">Run verification now</button>
    <span id="ranAt" class="muted small"></span>
  </div>
  <div id="gates"></div>
  <div id="body"></div>
</div>

<div class="panel" id="status"><iframe data-src="/admin/status" title="Status"></iframe></div>
<div class="panel" id="bracket"><iframe data-src="/bracket/admin" title="The Bracket admin"></iframe></div>
<div class="panel" id="knowher"><iframe data-src="/knowher/admin" title="Know Her Game admin"></iframe></div>

<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

// Tabs. Iframes load LAZILY on first view so opening the portal doesn't spin up the
// Bracket panel's polling before you've asked for it. EXCEPTION: the Status tab RELOADS on
// every click (cache-busted) so it re-runs its live health check each time you open it.
for (const b of document.querySelectorAll("nav button")) {
  b.onclick = () => {
    for (const x of document.querySelectorAll("nav button")) x.classList.toggle("on", x === b);
    for (const p of document.querySelectorAll(".panel")) p.classList.toggle("on", p.id === b.dataset.tab);
    const f = document.querySelector("#" + b.dataset.tab + " iframe");
    if (f) {
      if (b.dataset.tab === "status") f.src = f.dataset.src + "?t=" + Date.now(); // always re-run the check
      else if (!f.src) f.src = f.dataset.src;                                     // others lazy-load once
    }
  };
}

async function api(op, extra = {}) {
  const r = await fetch("/admin/roster", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, ...extra }),
  });
  return r.json();
}

function gateRow(label, ok, detail) {
  return '<tr><td>' + esc(label) + '</td><td>' +
    (ok ? '<span class="pill ok">pass</span>' : '<span class="pill bad">fail</span>') +
    '</td><td class="small muted">' + esc(detail || "") + '</td></tr>';
}

function render(d) {
  const rep = d.report;
  if (!rep) {
    $("#ranAt").textContent = "";
    $("#gates").innerHTML = '<div class="note">No verification has run yet. Press <b>Run verification now</b>, or wait for the nightly 08:00 UTC job.</div>';
    $("#body").innerHTML = "";
    return;
  }
  $("#ranAt").textContent = "last run " + rep.ranAt;

  const failing = rep.clubs.filter((c) => !c.gateB.ok || !c.gateC.ok);
  const unverified = rep.clubs.filter((c) => !c.verified).map((c) => c.abbr);
  let g = '<h2>Gates</h2><table>';
  g += gateRow("A — team identity", rep.gateA.ok, rep.gateA.failures.join("; ") || rep.clubs.length + " clubs");
  g += gateRow("B — squad shape", !failing.some((c) => !c.gateB.ok),
    failing.filter((c) => !c.gateB.ok).map((c) => c.abbr + ": " + c.gateB.failures.join(", ")).join(" · "));
  g += gateRow("C — continuity", !failing.some((c) => !c.gateC.ok),
    failing.filter((c) => !c.gateC.ok).map((c) => c.abbr + ": " + c.gateC.failures.join(", ")).join(" · "));
  g += '</table>';
  if (unverified.length) g += '<div class="note">Not verified this run (a fetch failed, so these clubs were skipped rather than judged): ' + esc(unverified.join(", ")) + '</div>';
  $("#gates").innerHTML = g;

  const ov = d.overrides || {};
  const now = Date.now();
  let h = "";

  // Position mismatches — the Rodman case. NEITHER feed automatically wins, so each row is a
  // decision, not a defect: pin whichever source you judge correct.
  const pos = rep.clubs.flatMap((c) => c.diffs.positionMismatches.map((m) => ({ ...m, abbr: c.abbr })));
  h += '<h2>Position mismatches (' + pos.length + ')</h2>';
  h += '<div class="note">Neither feed wins automatically — verified 2026-07-30, NWSL was right about Rodman but ESPN was right about Sonis. Pin the one you judge correct; a pin lasts ' + d.ttlDays + ' days, then the mismatch simply reappears here if the feeds still disagree.</div>';
  if (!pos.length) h += '<p class="muted small">None.</p>';
  else {
    h += '<table><tr><th>Club</th><th>Player</th><th>ESPN</th><th>NWSL</th><th>Mins</th><th>Pin to</th></tr>';
    for (const m of pos) {
      const pinned = ov[m.espnAthleteId];
      const live = pinned && Date.parse(pinned.expiresAt) > now;
      h += '<tr><td>' + esc(m.abbr) + '</td><td>' + esc(m.name) + '</td><td>' + esc(m.espn) + '</td><td>' + esc(m.sdp) + '</td><td class="muted">' + m.minutes + "'" + '</td><td>' +
        (live
          ? '<span class="pill ok">pinned ' + esc(pinned.position || "") + '</span>'
          : '<button class="act" data-pin="' + esc(m.espnAthleteId) + '" data-pos="' + esc(m.espn) + '" data-name="' + esc(m.name) + '" data-team="' + esc(m.abbr) + '">ESPN (' + esc(m.espn) + ')</button> ' +
            '<button class="act go" data-pin="' + esc(m.espnAthleteId) + '" data-pos="' + esc(m.sdp) + '" data-name="' + esc(m.name) + '" data-team="' + esc(m.abbr) + '">NWSL (' + esc(m.sdp) + ')</button>') +
        '</td></tr>';
    }
    h += '</table>';
  }

  // Players the league still lists with real minutes that ESPN has dropped entirely.
  const erased = rep.clubs.flatMap((c) => c.diffs.sdpOnlyWithMinutes.map((p) => ({ ...p, abbr: c.abbr })));
  h += '<h2>Missing from ESPN (' + erased.length + ')</h2>';
  h += '<div class="note">The league still lists these players with real minutes this season; ESPN does not carry them. Read-only — an override can correct a player ESPN lists, but it will never invent one, so a stale pin can never make a real player vanish.</div>';
  if (!erased.length) h += '<p class="muted small">None.</p>';
  else {
    h += '<table><tr><th>Club</th><th>Player</th><th>#</th><th>Mins</th></tr>';
    for (const p of erased) h += '<tr><td>' + esc(p.abbr) + '</td><td>' + esc(p.name) + '</td><td class="muted">' + esc(p.jersey ?? "—") + '</td><td class="muted">' + p.minutes + "'" + '</td></tr>';
    h += '</table>';
  }

  // On ESPN, not yet in the league feed. Overwhelmingly new signings — informational only.
  const only = rep.clubs.flatMap((c) => c.diffs.espnOnly.map((p) => ({ ...p, abbr: c.abbr })));
  h += '<h2>Not yet in the league feed (' + only.length + ')</h2>';
  h += '<div class="note">Usually new signings the league has not ingested yet (it runs 1–3 weeks behind), sometimes a name spelled differently on each side. Shown in the app as normal — never removed.</div>';
  if (!only.length) h += '<p class="muted small">None.</p>';
  else {
    h += '<table><tr><th>Club</th><th>Player</th><th>#</th></tr>';
    for (const p of only) h += '<tr><td>' + esc(p.abbr) + '</td><td>' + esc(p.name) + '</td><td class="muted">' + esc(p.jersey ?? "—") + '</td></tr>';
    h += '</table>';
  }

  // One person, two spellings — paired by shirt number so she stops being counted twice.
  const nv = rep.clubs.flatMap((c) => (c.diffs.likelyNameVariances || []).map((p) => ({ ...p, abbr: c.abbr })));
  h += '<h2>Same player, different spelling (' + nv.length + ')</h2>';
  h += '<div class="note">Paired because they wear the same number for the same club. Mononyms and legal-vs-known names are everywhere in this league (Debinha, Lorena, Ary Borges), and one is a marriage. Nothing to do — listed so you can see they were understood, not missed.</div>';
  if (!nv.length) h += '<p class="muted small">None.</p>';
  else {
    h += '<table><tr><th>Club</th><th>#</th><th>ESPN</th><th>NWSL</th></tr>';
    for (const p of nv) h += '<tr><td>' + esc(p.abbr) + '</td><td class="muted">' + esc(p.jersey) + '</td><td>' + esc(p.espnName) + '</td><td>' + esc(p.sdpName) + '</td></tr>';
    h += '</table>';
  }

  // Missing jerseys the league can fill.
  const mj = rep.clubs.flatMap((c) => c.diffs.missingJerseys.map((p) => ({ ...p, abbr: c.abbr })));
  h += '<h2>No shirt number on ESPN (' + mj.length + ')</h2>';
  if (!mj.length) h += '<p class="muted small">None.</p>';
  else {
    h += '<table><tr><th>Club</th><th>Player</th><th>NWSL has</th><th></th></tr>';
    for (const p of mj) {
      const pinned = ov[p.espnAthleteId];
      const live = pinned && Date.parse(pinned.expiresAt) > now;
      h += '<tr><td>' + esc(p.abbr) + '</td><td>' + esc(p.name) + '</td><td>#' + esc(p.sdpJersey) + '</td><td>' +
        (live ? '<span class="pill ok">pinned</span>'
              : '<button class="act go" data-pin="' + esc(p.espnAthleteId) + '" data-jersey="' + esc(p.sdpJersey) + '" data-name="' + esc(p.name) + '" data-team="' + esc(p.abbr) + '">Use #' + esc(p.sdpJersey) + '</button>') +
        '</td></tr>';
    }
    h += '</table>';
  }

  // Active + lapsed rulings.
  const all = Object.values(ov);
  h += '<h2>Your overrides (' + all.length + ')</h2>';
  h += '<div class="note">A pin outranks both feeds for ' + d.ttlDays + ' days. It expires on purpose: a permanent pin becomes an invisible lie the day the fact genuinely changes. Expiry is safe because the nightly check keeps running — if the feeds still disagree when a pin lapses, the row reappears above.</div>';
  if (!all.length) h += '<p class="muted small">None.</p>';
  else {
    h += '<table><tr><th>Player</th><th>Club</th><th>Pinned to</th><th>By</th><th>Status</th><th></th></tr>';
    for (const o of all) {
      const daysLeft = Math.ceil((Date.parse(o.expiresAt) - now) / 86400000);
      const val = o.position ? o.position : (o.jersey != null ? "#" + o.jersey : "—");
      const by = o.auto
        ? '<span class="pill warn">auto</span>' + (o.source ? ' <a class="small" href="' + esc(o.source) + '" target="_blank" rel="noopener">source</a>' : '')
        : '<span class="pill">you</span>' + (o.source ? ' <a class="small" href="' + esc(o.source) + '" target="_blank" rel="noopener">source</a>' : '');
      h += '<tr><td>' + esc(o.playerName) + '</td><td>' + esc(o.teamAbbr) + '</td><td>' + esc(val) + '</td><td>' + by + '</td><td>' +
        (daysLeft > 0 ? '<span class="pill ok">' + daysLeft + 'd left</span>' : '<span class="pill warn">expired</span>') +
        '</td><td><button class="act" data-renew="' + esc(o.espnAthleteId) + '">Renew</button> ' +
        '<button class="act danger" data-remove="' + esc(o.espnAthleteId) + '">Remove</button></td></tr>';
    }
    h += '</table>';
  }

  $("#body").innerHTML = h;
  wire();
}

function wire() {
  for (const b of document.querySelectorAll("[data-pin]")) {
    b.onclick = async () => {
      b.disabled = true;
      const d = await api("setOverride", {
        espnAthleteId: b.dataset.pin,
        playerName: b.dataset.name,
        teamAbbr: b.dataset.team,
        position: b.dataset.pos,
        jersey: b.dataset.jersey ? Number(b.dataset.jersey) : undefined,
      });
      render(d);
    };
  }
  for (const b of document.querySelectorAll("[data-renew]")) {
    b.onclick = async () => { b.disabled = true; render(await api("renewOverride", { espnAthleteId: b.dataset.renew })); };
  }
  for (const b of document.querySelectorAll("[data-remove]")) {
    b.onclick = async () => { b.disabled = true; render(await api("removeOverride", { espnAthleteId: b.dataset.remove })); };
  }
}

$("#run").onclick = async () => {
  $("#run").disabled = true;
  $("#run").textContent = "Running…";
  try { render(await api("run")); }
  finally { $("#run").disabled = false; $("#run").textContent = "Run verification now"; }
};

api("state").then(render);
</script>
</body>
</html>`;
