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
- The 80 ceiling is a **CEILING, never a target**. Carry exactly who qualifies; never pad.

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
web-search her Instagram and Bluesky (e.g. `"<name>" <club> Instagram`, `"<name>" <nation>
Instagram`). The bar for **found**:

- **Clearly her** — the profile references her club/national team, or a club/league post links to
  it, or it carries a verified badge. ⚠️ Impersonator and fan accounts are the trap: a name-match
  alone is NEVER enough. When identity is not certain, record `none` — a missed add costs a wait;
  a stranger's content in fans' feeds costs trust.
- **Public and alive** — not private, has a post within roughly the last 6 months.

Verdicts: `found` (with `ig` and/or `bsky`, bare handles no @), `private`, or `none`.
POST the whole batch once:
`POST {base}/research` body `{"results":[{"name":"...","status":"found","ig":"...","bsky":"..."}, ...]}`

### 4. Verify drops (departures only, never name variants)

For each name in `drops.players`, web-search her current status. Confirm she actually LEFT the
NWSL (retired / transferred abroad / waived-unsigned) — check the club's own roster page.
⚠️ If it looks like a NAME VARIANT (married name, ESPN spelling) of someone still on a roster,
do NOT drop — note it in the report instead. Ambiguous → leave her on, note it.

### 5. Apply (this is live — be right, not fast)

`POST {base}/apply` body `{"add":[{"name","abbr","ig","bsky"?}...], "drop":["name",...]}`

- Adds = every candidate whose research found a **public IG handle** (IG is required to serve
  today; a bsky-only player stays in research memory and auto-surfaces when Bluesky player
  serving ships — do NOT add her yet).
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
