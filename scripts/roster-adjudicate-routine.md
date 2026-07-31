# Weekly roster adjudication — resolve ESPN↔NWSL mismatches from club sources

You are resolving factual disagreements between two data feeds about NWSL player positions and
shirt numbers. This is NOT content generation: every answer already exists on an authoritative
page — your job is to read it and report it, with a citation. When you cannot find an
authoritative answer, **decline by simply not posting that item.** An unposted mismatch costs
nothing (the owner sees it in her portal); a wrong ruling is pinned for 90 days.

You received `ADJUDICATE_KEY` in your instructions (it is a secret — never print it, never write
it to a file, never include it in your report).

## 1. Fetch the work list

```
curl -sS "https://nwslapp-proxy.tiffany-rieth.workers.dev/roster-truth/todo" \
  -H "x-adjudicate-key: $ADJUDICATE_KEY"
```

Response: `positions` (player, club, ESPN says X, the league feed says Y) and `jerseys` (ESPN has
no number; the league feed suggests one). If both lists are empty, report "nothing to adjudicate"
and STOP — that is a success, not a failure.

Club abbreviations: LA=Angel City FC · BAY=Bay FC · BOS=Boston Legacy FC · CHI=Chicago Stars FC ·
DEN=Denver Summit FC · GFC=Gotham FC · HOU=Houston Dash · KC=Kansas City Current ·
NC=North Carolina Courage · ORL=Orlando Pride · POR=Portland Thorns FC · LOU=Racing Louisville FC ·
SD=San Diego Wave FC · SEA=Seattle Reign FC · UTA=Utah Royals · WAS=Washington Spirit.

## 2. Adjudicate each item — the source hierarchy is strict

For each player, find her page on **the club's own official website roster** (e.g.
denversummitfc.com → roster, rsl.com/utahroyals → players). That is the PRIMARY source: it is
current-season and the club decides how it lists its own players.

- ⚠️ **Wikipedia is a FALLBACK ONLY, and only when the club page is unreachable.** Wikipedia
  carries CAREER position, not current role — it says "forward or full-back" for Janine Sonis,
  who is listed **Defender** by her own club this season. Trusting it would have produced a wrong
  90-day pin. Never let a career description override a current club listing.
- ⚠️ **Check married/maiden name forms.** This league is full of them: Janine Sonis = Janine
  Beckie · Paige Cronin = Paige Monaghan · Lindsey Heaps = Lindsey Horan. If a name misses on the
  club site, search the club site for the other form before falling back.
- Never use ESPN or nwslsoccer.com as the tiebreaker — they are the two parties in dispute.
- Position maps to one letter: G (goalkeeper) · D (defender/back) · M (midfielder) · F
  (forward/winger/striker). If the club lists a hybrid ("defender/midfielder") with no primary,
  DECLINE that item.

## 3. Post only what you resolved

```
curl -sS -X POST "https://nwslapp-proxy.tiffany-rieth.workers.dev/roster-truth/rulings" \
  -H "x-adjudicate-key: $ADJUDICATE_KEY" -H "Content-Type: application/json" \
  -d '{"rulings":[{"espnAthleteId":"…","playerName":"…","teamAbbr":"…","position":"D","source":"https://…"}]}'
```

- `source` is REQUIRED and must be the exact page you read the answer from (the server rejects
  rulings without it). For a jersey item send `"jersey": 21` instead of `position`.
- Post ONE batch at the end, not per-item.
- The response lists `accepted` and `skipped` with reasons. `"owner pin in force"` skips are
  EXPECTED (the owner outranks you) — not failures.

## 4. Report

State: how many items were pending, how many you ruled (with player → ruling → source domain),
how many you declined and why, and the server's accepted/skipped counts. Keep it short — this is
a maintenance log, not an essay.
