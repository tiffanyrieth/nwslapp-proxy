// Playoff bracket OVERRIDE — an operator escape hatch for when ESPN corrupts the postseason
// data. Precedent: ESPN once wiped a whole NWSL roster on a trade and was slow to fix it, so
// /roster gained a last-known-good KV cache. This is the same philosophy for the playoff
// bracket: a small JSON in KV that the app layers over its ESPN-derived bracket, so correcting
// a bad game (wrong winner/score, a dropped match) or a format surprise is a SERVER edit — live
// for every user in minutes — instead of an App Store release.
//
// Dormant by default: no key set → GET returns { override: null } → the app derives purely from
// ESPN, exactly as it does today.
//
//   GET  /playoff-override?season=2026          → { version, season, override }   (public)
//   POST /playoff-override?season=2026          → set (body = the override JSON)   (x-admin-key)
//   POST /playoff-override?season=2026&clear=1  → delete the override             (x-admin-key)
//
// Override JSON shape (all fields optional; the app ignores unknown keys):
//   {
//     "note":        "why this exists (for the operator)",
//     "hideBracket": false,                         // kill switch: hide the whole feature
//     "teamCount":   8,                             // force the bracket size (format change)
//     "seeds":       { "WAS": 2, "GFC": 8 },        // correct specific seeds (merged over ESPN)
//     "matchups": [                                 // correct/inject specific games
//       { "round": "playoffs---semifinals", "home": "WAS", "away": "POR",
//         "homeScore": 2, "awayScore": 0, "winner": "WAS", "state": "post",
//         "kickoff": "2026-11-15T17:00Z", "broadcast": "CBS", "venue": "Audi Field" }
//     ]
//   }
//
// KV key: `playoff-override:<season>` in FEED_TAGS. No TTL — persists until cleared.

interface OverrideEnv {
  FEED_TAGS: KVNamespace;
  BRACKET_ADMIN_KEY?: string;
}

export async function handlePlayoffOverride(request: Request, url: URL, env: OverrideEnv): Promise<Response> {
  const season = url.searchParams.get("season") ?? String(new Date().getUTCFullYear());
  const kvKey = `playoff-override:${season}`;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30", // short — an operator fix should propagate fast
        "Access-Control-Allow-Origin": "*",
      },
    });

  if (request.method === "GET") {
    const override = (await env.FEED_TAGS.get(kvKey, "json")) as unknown | null;
    return json({ version: 1, season: Number(season), override: override ?? null });
  }

  if (request.method === "POST") {
    const key = env.BRACKET_ADMIN_KEY;
    if (!key || request.headers.get("x-admin-key") !== key) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.searchParams.get("clear") === "1") {
      await env.FEED_TAGS.delete(kvKey);
      return json({ ok: true, cleared: true, season: Number(season) });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json({ ok: false, error: "override must be a JSON object" }, 400);
    }
    await env.FEED_TAGS.put(kvKey, JSON.stringify(body));
    return json({ ok: true, season: Number(season), stored: body });
  }

  return new Response("method not allowed", { status: 405 });
}
