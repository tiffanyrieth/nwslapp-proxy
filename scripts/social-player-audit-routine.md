# Social player audit — the self-tuning routine (fully automated)

You keep the NWSL fandom app's **featured-player social pool** current. The proxy has already
done everything mechanical (eligibility ledger, roster intersection, research memory) — your job
is ONLY the parts that need web research and judgment, and then applying the result. The run is
**fully automated** (owner ruling 2026-08-16): what you apply goes live; your final report is
transparency for troubleshooting, not an approval request.

Auth: every call uses the `x-audit-key` header with the SOCIAL_AUDIT_KEY from your prompt.
Base: `https://nwslapp-proxy.tiffany-rieth.workers.dev/social/player-audit`

## Background you must respect (the eligibility law)

- Featured default = NWSL roster ∧ has represented a national team. Eligibility is **earned
  forever** — the server's ledger handles that; you never re-judge it.
- The ONLY drops are: left the NWSL, or a dead/impersonated handle. **Never drop for NT-roster
  absence.** Emily Fox, Naomi Girma, Alyssa Thompson are grandfathered — never attempt to drop
  them (the server refuses anyway).
- The ceiling is a **CEILING, never a target** — read `capacity` in the report (160 total = two
  ROTATING POOLS × 80 per scrape run; the every-2-day scrape alternates pools, so every featured
  player serves all week and refreshes every 4 days). Pools are AUTO-ASSIGNED server-side (new
  adds join the lighter pool) — you never manage pools. Carry exactly who qualifies; never pad.

## Steps — execute in order

### 1. Ledger top-up (mechanical, no judgment)

`GET {base}?nt=<slug>` for EVERY slug the server accepts. Get the authoritative list first —
`GET {base}` with no params returns `validNt` (14 feeds; two oversized qualifying feeds are
excluded by design). Run them SEQUENTIALLY (each fans out ~15–35 ESPN fetches server-side).
One retry per failed slug, then move on and note it in the report. Record each summary
(`nwslMatched`, `newlyAdded`, `ledgerSize`).

### 2. Pull the decision report

`GET {base}?section=nwsl`. Note `capacity` (used/ceiling/headroom), `clubCoverage` zeros,
`candidates.needsResearch`, `candidates.researched`, and `drops.players`.

### 3. Research ONLY `candidates.needsResearch` (token discipline)

Never re-research `researched` names — that memory exists so you don't. For each new candidate,
web-search her Instagram (e.g. `"<name>" <club> Instagram`, `"<name>" <nation> Instagram`).
⚠️ IG ONLY — player-Bluesky discovery was DROPPED (owner 2026-08-17): a 2026 sweep proved almost
no players are genuinely on Bluesky (name-matches were impersonation squats), so defaults are
IG-only and you never search Bluesky for players. **The two-tier identity bar (owner law, 2026-08-17 — the app is a publisher; a
wrong account is the app lying to fans, including 12-year-olds):**

- **REQUIRED — athlete-class professional category.** The IG account must carry an athlete-class
  professional-category label: "Athlete" or a clear localized equivalent ("Futbolista",
  "Sportlerin", …). This is the same-name protection — a personal account or any non-athlete
  category FAILS the gate no matter how convincing the name match. Record the EXACT label you saw
  as `category` and your judgment as `athleteClass: true/false`. The category shows on the
  profile (under the name, above the bio) — read it via the profile page, a Google-indexed
  profile title, or a source that quotes it. If you cannot determine the category, record what
  you found WITHOUT `athleteClass: true` — the server refuses the add, which is correct: unproven
  stays unfeatured.
- **Verified (blue check) = the accuracy ACCELERATOR, not the gate.** Record `verified` when you
  can see it. A verified account needs only the category check; an UNVERIFIED account needs full
  identity corroboration — her club's or federation's own page linking that exact handle, or the
  bio itself naming her club/NT (e.g. @barbrabandaofficial: category "Athlete", bio links
  @orlpride + @fazfootball — passes without a blue check).
- **Public and alive** — not private, a post within roughly the last 6 months.

Verdicts: `found` (with `ig`, bare handle no @), `private`, or `none`.
POST the whole batch once — include the gate fields:
`POST {base}/research` body
`{"results":[{"name":"...","status":"found","ig":"...","category":"Athlete","athleteClass":true,"verified":true}, ...]}`

### 4. Verify drops (departures only, never name variants)

For each name in `drops.players`, web-search her current status. Confirm she actually LEFT the
NWSL (retired / transferred abroad / waived-unsigned) — check the club's own roster page.
⚠️ If it looks like a NAME VARIANT (married name, ESPN spelling) of someone still on a roster,
do NOT drop — note it in the report instead. Ambiguous → leave her on, note it.

### 5. Apply (this is live — be right, not fast)

`POST {base}/apply` body `{"add":[{"name","abbr","ig","bsky"?}...], "drop":["name",...]}`

- Adds = every candidate whose research found a **public IG handle AND confirmed athlete-class
  category** (`athleteClass: true`). The server enforces this independently — an add without a
  passing gate record is rejected, never silently accepted.
- `abbr` = the `club` from the report's candidate entry, verbatim.
- If adds would exceed the ceiling, prioritize (a) clubs at 0 coverage, then (b) major-tournament
  `source` over friendlies — and report exactly who was left off and why.
- Drops = only the departures you confirmed in step 4.
- The server validates everything again (grandfathered, dupes, club codes, ceiling) — treat any
  `rejected` entries as findings for the report, not errors to force through.

### 6. Report (transparency, not a gate)

State: per-slug ledger results; research verdicts (found/none/private counts + who); adds and
drops applied with the server's response; any rejects and why; club coverage AFTER the run
(call out remaining zeros); and **used/80 with headroom** — the owner watches that number to
revisit parked eligibility decisions.

## Hard rules (override everything)

- The SOCIAL_AUDIT_KEY is a secret: only ever the `x-audit-key` header value — never print it,
  never write it to a file, never include it in your report.
- One retry per failed step, then stop LOUD with a clear failure report. A partial run is safe
  (the ledger and research memory persist; a missed run self-heals next cycle).
- Default to NOT adding when unsure. Never pad toward 80. Never drop for NT absence. Never
  touch the grandfathered three.
