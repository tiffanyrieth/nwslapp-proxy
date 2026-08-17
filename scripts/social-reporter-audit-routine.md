# Reporter audit — the self-tuning routine (FULLY AUTOMATED, guarded)

You keep the NWSL fandom app's **default reporter/league Bluesky list** healthy — fully
automated (owner 2026-08-17): what you apply goes live via `POST {base}/apply`; your report is
transparency for the owner's review, not an approval request. The SERVER enforces the
mechanical limits (max 2 adds per call, the budget ceiling, dedupe/validation); YOU enforce the
quality bar below.

Auth: `x-audit-key` header with the SOCIAL_AUDIT_KEY from your prompt.
Endpoint: `GET https://nwslapp-proxy.tiffany-rieth.workers.dev/social/reporter-audit`

## Steps

### 1. Pull the audit

`GET /social/reporter-audit`. It carries:
- `defaults` — every default handle's health tier (`ok` / `cooling` / `dormant` / `empty` / `dead`),
  tiered on the last ORIGINAL post (reposts don't count).
- `outageSuspected` — ⚠️ if true, Bluesky itself is down (a majority flagged at once): report
  "outage — nothing actionable this run" and STOP. That is success. Never treat outage flags
  as drop candidates.
- `dropCandidates.secondConsecutiveFlag` — flagged on TWO consecutive audits = strong drop
  candidates. `firstFlag` = watch only (vacation/leave); never recommend dropping on one flag.
- `addSignals` — anonymous per-team add counters from fans (`3+ adds of one handle among a
  team's fans` = escalation threshold). Empty until the Stage-3 counter ships.

### 2. Verify drop candidates (web research)

For each `secondConsecutiveFlag` handle: web-search where the reporter went. Common truths:
moved outlets, moved to another platform, left the beat, or left journalism. A reporter who
still covers NWSL elsewhere but abandoned Bluesky is still a drop FROM THE BLUESKY LIST
(we serve what posts). Cite what you find.

### 3. Discovery (web research — NOT the follow graph) — RUN THIS EVERY TIME

⚠️ Discovery is NOT conditional on fan signals existing (audit run #1 skipped it when
addSignals was empty — wrong). Every run does BOTH halves:
- **Fan signals:** research each `addSignals` handle clearing the threshold (3+ adds among one
  club's fans): is this a real NWSL voice (beat writer, club insider, analyst)? Active on
  Bluesky? Cite sources. Ignore any signal whose team code is not one of the 16 club
  abbreviations (malformed/test data).
- **Beat-coverage sweep (unconditional):** the current defaults skew to league-wide voices.
  For clubs without a dedicated beat voice on the list, search for their beat reporters
  ("<club> beat reporter", club press corps, local outlet soccer desks, podcast hosts) and
  check whether they have an ACTIVE Bluesky posting original coverage (many are X-only — an
  X-only voice is NOT addable, note her and move on). Recommend only genuinely additive,
  active voices — a handful per run at most; every add is recurring classification cost the
  owner budgets for.
⛔ Follows-of-follows / graph signals are REJECTED (owner): reporters follow peers across all
beats, so "reporters follow her" proves nothing.

### 4. THE QUALITY BAR for adds (judge the CONTENT, not the résumé)

Sample the candidate's recent ORIGINAL posts before adding. Add only voices whose NWSL
coverage is **distinctive and engaging** — breaking news, transfers and transfer rumors,
player storylines told with insight or energy, presser/report access. Do NOT add accounts
whose output is primarily bare article links with no text, generic recaps/aggregation, or
whose last ORIGINAL post is older than ~30 days (an inactive or link-dump account adds cost
without content — activity recency is a HARD check, verified via getAuthorFeed, reposts don't
count). Mixed beats are fine (NWSL + other soccer) — Haiku filters per-post; what matters is
that the NWSL posts themselves are worth a fan's tap.

### 5. Apply (guarded) + report

`POST {base}/apply` body `{"add":[{"handle":"...","kind":"reporter|league"}],"drop":["handle"]}`
— at most 2 adds per run (server-capped); drops ONLY for second-consecutive-flag handles whose
departure you verified in step 2. Treat any `rejected[]` entries as findings, never force.
Then the report: list health; drops applied (streak + citation); adds applied (who she is, the
quality evidence, posts/day); candidates you did NOT add and the specific bar they missed
(X-only, link-dump, inactive, generic) so future runs skip them; fan-signal outcomes.

## Hard rules (override everything)

- SOCIAL_AUDIT_KEY is a secret: header value only — never print it, never write it to a file,
  never include it in your report.
- `outageSuspected: true` ⇒ stop with a success report. One retry per failed step, then stop
  LOUD. A missed audit is safe (the streak state waits).
- Never recommend dropping on a single flag. Never use follow-graph signals. Identity bar for
  adds: clearly the real person/outlet — impersonators and fan accounts are the trap.
