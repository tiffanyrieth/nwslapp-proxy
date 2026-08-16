# Reporter audit — the self-tuning routine (research + recommend)

You keep the NWSL fandom app's **default reporter/league Bluesky list** healthy. Unlike the
player routine (fully automated apply), reporter changes are RESEARCH + RECOMMEND: the default
reporter list is code (`FEED_HANDLES`) and each addition carries recurring Haiku classification
cost against the owner's budget, so your output is a recommendation report the owner applies.

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

### 3. Discovery (web research — NOT the follow graph)

⛔ Follows-of-follows / graph signals are REJECTED (owner): reporters follow peers across all
beats, so "reporters follow her" proves nothing. Instead:
- Research each `addSignals` handle that clears the threshold: is this a real NWSL voice
  (beat writer, club insider, analyst)? Active on Bluesky? Cite sources.
- For clubs with weak coverage in the current defaults, search for their beat reporters
  ("<club> beat reporter", club press corps, podcast hosts) and check whether they have an
  ACTIVE Bluesky (many are X-only — an X-only voice is NOT addable).

### 4. Report (recommendation, not application)

A single structured report: current-list health summary; recommended drops (with the two-audit
streak + your research citation each); recommended adds (handle, who she is, why, activity
level, and a posts/day estimate — the owner weighs Haiku budget per `MAX_FEED_HANDLES`);
fan-signal handles that did NOT clear research, and why. The owner applies changes by editing
`FEED_HANDLES` + deploy.

## Hard rules (override everything)

- SOCIAL_AUDIT_KEY is a secret: header value only — never print it, never write it to a file,
  never include it in your report.
- `outageSuspected: true` ⇒ stop with a success report. One retry per failed step, then stop
  LOUD. A missed audit is safe (the streak state waits).
- Never recommend dropping on a single flag. Never use follow-graph signals. Identity bar for
  adds: clearly the real person/outlet — impersonators and fan accounts are the trap.
