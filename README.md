# nwslapp-proxy

A tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/) that
caches ESPN's unofficial NWSL **scoreboard** endpoint and fans it out to the
[NWSLApp](https://github.com/tiffanyrieth/NWSLApp) iOS client. One upstream ESPN
call serves every app instance ("poll once, fan out"), which de-risks the
undocumented ESPN dependency that sits under the app's schedule.

This is **V2 milestone 0.2.0** — deliberately scoped to a single route.

## What it does

- **One route:** `GET /scoreboard` — anything else returns `404` (`405` for
  non-GET).
- **Transparent pass-through:** forwards the request (query string verbatim) to
  ESPN's `…/usa.nwsl/scoreboard` and returns the JSON **unchanged**, so the app's
  existing decoder needs no changes.
- **Edge caching** via the Workers Cache API with a dynamic TTL — `30s` while a
  match is live (any event in the `"in"` state), `300s` otherwise.
- **Resilience:** if ESPN is down, a stale cached copy is served when available
  (`X-Proxy-Cache: STALE`); otherwise `502`.
- Every response carries an **`X-Proxy-Cache: HIT | MISS | STALE`** header.

Out of scope for now: ESPN's teams, roster, and standings endpoints — the app
still calls those directly.

## Example

```bash
curl -i 'https://nwslapp-proxy.<subdomain>.workers.dev/scoreboard?dates=20260101-20261231&limit=500'
# first call  → X-Proxy-Cache: MISS
# second call → X-Proxy-Cache: HIT
```

## No silent failures (hard rule)

The app's **NO SILENT FAILURES** rule applies here too. **Any pipeline that can serve
partial or degraded results MUST signal it** — never silently return a subset. Concretely:

- **Emit telemetry on a miss.** Use `emitDiag(env, ctx, kind, detail)` — it writes a
  `diag:` record to KV `FEED_TAGS` in the same shape the app's `POST /telemetry` sink uses,
  so a proxy-side miss shows up in the owner's `GET /telemetry/recent` Diagnostics next to
  app telemetry. (Example: per-club club-news fires `clubNewsFallback` / `clubNewsEmpty`.)
- **Cover it with a health check.** A fan-out that's supposed to cover N things gets a
  script that verifies all N and **exits non-zero on any gap**, run at deploy time. See
  `scripts/health_check_club_news.mjs` (`npm run healthcheck`) — it curls `/team-videos`
  for all 16 clubs and fails if any returns no article-news.

This exists because a 1-of-16 club-news implementation once shipped and sat silently
half-working; the rule makes the *next* half-built pipeline impossible to miss.

## Develop

```bash
npm install
npm run dev          # http://localhost:8787
npm test             # vitest (route guards + pure-helper units)
npm run healthcheck  # assert all 16 clubs return Home club-news (prod by default;
                     # pass a base URL arg, e.g. http://localhost:8787, for dev)
```

## Deploy

```bash
npx wrangler login   # one-time browser authorize
npm run deploy       # → https://nwslapp-proxy.<subdomain>.workers.dev
npx wrangler tail    # live request logs
```

## Stack

Cloudflare Workers · TypeScript · Wrangler · Vitest. No KV/D1 — the Cache API
needs no bindings.

## Git hooks (branch-first guardrail)

Local hooks in `hooks/` enforce the workflow: `pre-commit` blocks commits straight
to `main` (branch first, merge via PR); `pre-push` blocks force-pushing or deleting
`main`. They're a local tripwire, not server-side enforcement, and `core.hooksPath`
isn't pushed — so **activate them once per fresh clone**:

```bash
git config core.hooksPath hooks
```

Bypass on purpose with `git commit --no-verify` / `git push --no-verify`.
