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

## Develop

```bash
npm install
npm run dev      # http://localhost:8787
npm test         # route-guard tests (vitest)
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
