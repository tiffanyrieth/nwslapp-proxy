<!--
  Know Her Game — CANONICAL weekly generation template (automation).

  Provenance: this is the PROVEN Rodman-WORKING query (scripts/knowher-prompt-rodman-WORKING.md — the
  gold standard, keep untouched) scaled to 16 players, with the owner's 2026-07-13 fidelity rulings
  applied: ">=6 MUST be human" (not "should"), NO web-search cap, thin-coverage anti-fabrication rule
  kept, and all operator notes moved into THIS comment so the model receives exactly the Rodman-shaped
  query. The wording below is DELICATE and owner-owned — never change it without an explicit owner
  decision (query fidelity is the product).

  Usage: scripts/assemble_knowher_prompt.mjs strips this comment and substitutes the two placeholders —
  <<WEEK_KEY>> (ISO week, e.g. 2026-W29) and <<PLAYER_LIST>> (one block per team from /knowher/todo).
  The assembled output IS the prompt; run it on a web-search-enabled Sonnet and POST the JSON to
  /knowher/ingest (see scripts/knowher-weekly-routine.md). This file changes nothing live.
-->

You're writing a ~10-question quiz **for each player below** for a **women's soccer fandom app**. This is NOT a
stats app. The legacy sports apps are male-focused, stat-heavy, and when they cover women's sports they do a
lazy cookie-cutter port. We're doing the opposite: the **Olympic approach** — tell me who she IS so I feel a
connection and want to root for her. Female fans want a HYBRID that leans into **story and personality**, with
stats as texture. If a quiz feels like a stat sheet, it has failed. Make me *feel* something and maybe laugh (a
relatable detail like "she travels with her PS5" is gold).

## The players (verified 2026 stats — USE THESE NUMBERS, don't look stats up)

<<PLAYER_LIST>>

## What to produce PER PLAYER (~10 questions) — HUMAN-FIRST

- **At LEAST 6 of the ~10 must be HUMAN / STORY questions** (`herStory` / `herWorld` / `trueOrFalse`):
  personality, relatable quirks, life beyond soccer, origin story, career milestones. Most featured players
  have *tons* of these — dig (Google "<player> fun facts", inside and outside soccer). Warm, surprising,
  makes-you-smile details. INTERLEAVE them throughout (never dump them at the end).
- **At MOST ~4 stat/identity questions** (`herGame`), and make them THINK — MC options that are genuinely
  CLOSE (e.g. minutes with several plausible 900-range options). NO gimmes ("what position?", "what's her
  number?", "how many games has a star started?" → obviously ~all). A star's basic stats are boring.
- ⚠️ **Coverage varies across 16 players — NEVER fabricate to hit the ratio.** Human-first is the target, but
  a less-covered player (a backup keeper, a lower-profile international) may not have 6 clean, well-sourced
  human facts. If so: use as many well-sourced human questions as genuinely exist, then fill the rest with
  **genuinely-hard, non-gimme stat questions** (same THINK bar). A stretched or invented fun fact is a WORSE
  failure than one extra hard stat question — better a 5-human/5-stat quiz that's all true than a 6th human
  question you had to reach for. Doing fewer human questions for a thin-coverage player is fine; padding is not.

## THE FIVE-LAYER GUARDRAIL (every human question — non-negotiable)

1. **Public** — public life only, never private.
2. **About HER** — her own story/personality/career. NEVER define her through another person (esp. a more
   famous one). *(Canonical fail: "grew up around basketball → her dad is [famous NBA player]" — banned
   even though true.)*
3. **Sourced** — verified only, never rumor as fact.
4. **Holds even when true** — if it makes her story about someone else's fame, it's out.
5. **Mechanical** — if the ANSWER is another person's name/identity, it's OUT.

Framing test: WOULD ask her hobbies, quirks, a relatable travel habit, a career first. WOULD NOT ask who
she's dating or which relative is famous.

## Sourcing — GOLD-TIER sources can be a SINGLE source

- **GOLD-TIER (one of these alone is enough — trusted editorial desks):** Just Women's Sports, Girls
  Soccer Network, The Athletic, ESPN, Sports Illustrated, AP, Reuters, official NWSL / club /
  U.S. Soccer / Olympics.com / a player's own national federation, and major national outlets (NYT,
  Washington Post, People). A fact from any ONE of these is trusted — do NOT drop it for lack of a second source.
- **General web (anything not gold-tier):** needs ≥2 DISTINCT reputable domains that agree.
- **NEVER:** fan wikis, gossip/tabloid, video-game DBs (futbin), retailer/sponsor pages, random YouTube/
  social, unsourced blogs. Only cite URLs you actually retrieved — if you can't verify, drop it.
- **Disambiguate:** confirm each fact is about THIS player (the correct NWSL player + her CURRENT club as
  listed above / her national team) — discard same-or-similar-name namesakes.
- **Search budget (soft):** aim for **~5–6 searches per player**. Well-covered players won't need that
  many; for a thin-coverage player, once you've spent ~5–6 and the well is dry, STOP — fall back to
  genuinely-hard stat questions (per the coverage rule above) rather than hunting endlessly. A great
  5-human/5-stat quiz beats grinding a dozen searches for a 6th reached-for fact.

## Format — fix the True/False trap

- `category`: `herGame` / `herStory` / `herWorld` / `trueOrFalse`. MC = exactly 4 options; T/F = exactly 2
  (`["True","False"]` in that order, so `correctIndex` 0 = True, 1 = False).
- A **single** fun fact must be an MC **"which of these has she actually done?"** — ONE true option among
  3–4 plausible-but-false ones (forces real knowledge). Do NOT make a lone fun fact a hyper-specific
  True/False ("True or false: she did <ultra-specific thing>") — the answer is obviously TRUE, a free
  guess. BANNED.
- Only use **True/False when some statements are plausibly FALSE** (a believable-but-untrue claim), so
  "true" isn't automatic. Mix true and false answers across the T/F questions.
- Each question: unique `id` (e.g. `"was-rodman-<slug>"`), a `prompt`, and a warm one-sentence `revealFact`
  (the "learn"/delight payoff). 8–15 questions per player (aim ~10). One player per team.
- Also write a warm one-line `tagline` for each player.
- **`jerseyNumber`:** take it from the player's line above (the `#N`). If a player's line shows no number
  (ESPN didn't have it), do ONE quick lookup of her current squad number and use that — a plain integer,
  required by the schema. Don't make it a research detour.

## OUTPUT — one JSON document, nothing else

Output ONLY this JSON (no prose around it), **every player above included** in the `players` array:

```json
{
  "weekKey": "<<WEEK_KEY>>",
  "season": <<SEASON>>,
  "players": [
    {
      "teamAbbreviation": "WAS",
      "espnAthleteId": "317423",
      "playerName": "Trinity Rodman",
      "jerseyNumber": 2,
      "position": "Forward",
      "tagline": "<warm one-liner>",
      "questions": [
        {
          "id": "was-rodman-<slug>",
          "category": "herWorld",
          "prompt": "Which of these has Trinity Rodman actually done?",
          "options": ["<true one>", "<plausible false>", "<plausible false>", "<plausible false>"],
          "correctIndex": 0,
          "revealFact": "<one warm sentence>"
        }
      ]
    }
  ]
}
```

After the JSON, list (for MY review only, outside the JSON) the source(s) you used for each human fact per
player — noting which are gold-tier — so I can spot-check before it goes live.
