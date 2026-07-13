# Know Her Game — content generation prompt (16 players, batch)

This is the **fine-tuned Rodman-WORKING template scaled to 16 players** (one per NWSL club). It replaces the
old stat-heavy batch prompt (that one produced dry, gimme-heavy quizzes with weak facts — the reason we
narrowed to a single player to tune). Everything below is the KNOWN-GOOD single-player approach
(`knowher-prompt-rodman-WORKING.md`), applied to the whole roster. Run it against a capable, web-search-enabled
model; paste the JSON into the proxy's `/knowher/admin` portal. Manual run — this file changes nothing live.

You're writing a ~10-question quiz **for each player below** for a **women's soccer fandom app**. This is NOT a
stats app. The legacy sports apps are male-focused, stat-heavy, and when they cover women's sports they do a
lazy cookie-cutter port. We're doing the opposite: the **Olympic approach** — tell me who she IS so I feel a
connection and want to root for her. Female fans want a HYBRID that leans into **story and personality**, with
stats as texture. If a quiz feels like a stat sheet, it has failed. Make me *feel* something and maybe laugh (a
relatable detail like "she travels with her PS5" is gold).

## The players (verified 2026 stats — USE THESE NUMBERS, don't look stats up)

- Sveindís Jónsdóttir — Angel City FC (LA) — Forward, #32 — age 25, Iceland — espnAthleteId 317692
  2026 season: 7 starts, 625 minutes, 7 appearances, 3 goals, 2 assists
- Racheal Kundananji — Bay FC (BAY) — Forward, #9 — age 26, Zambia — espnAthleteId 310652
  2026 season: 6 starts, 558 minutes, 8 appearances, 1 goal, 0 assists
- Nichelle Prince — Boston Legacy FC (BOS) — Forward, #12 — age 31, Canada — espnAthleteId 225339
  2026 season: 11 starts, 909 minutes, 12 appearances, 1 goal, 2 assists
- Mallory Swanson — Chicago Stars FC (CHI) — Forward, #9 — age 28, USA — espnAthleteId 233163
  2026 season: 1 start, 122 minutes, 3 appearances, 1 goal, 0 assists
- Yazmeen Ryan — Denver Summit FC (DEN) — Forward, #9 — age 27, USA — espnAthleteId 263902
  2026 season: 10 starts, 903 minutes, 11 appearances, 2 goals, 3 assists
- Rose Lavelle — Gotham FC (GFC) — Midfielder, #16 — age 31, USA — espnAthleteId 209984
  2026 season: 7 starts, 660 minutes, 9 appearances, 2 goals, 0 assists
- Jane Campbell — Houston Dash (HOU) — Goalkeeper, #1 — age 31, USA — espnAthleteId 212207
  2026 season: 11 starts, 983 minutes, 11 appearances, 3 clean sheets
- Temwa Chawinga — Kansas City Current (KC) — Forward, #6 — age 27, Malawi — espnAthleteId 379824
  2026 season: 8 starts, 545 minutes, 8 appearances, 7 goals, 2 assists
- Ashley Sanchez — North Carolina Courage (NC) — Midfielder, #2 — age 27, USA — espnAthleteId 279297
  2026 season: 11 starts, 942 minutes, 11 appearances, 7 goals, 1 assist
- Marta — Orlando Pride (ORL) — Forward, #10 — age 40, Brazil — espnAthleteId 158712
  2026 season: 2 starts, 223 minutes, 7 appearances, 1 goal, 0 assists
- Sophia Wilson — Portland Thorns FC (POR) — Forward, #9 — age 25, USA — espnAthleteId 43770
  2026 season: 10 starts, 922 minutes, 13 appearances, 5 goals, 1 assist
- Emma Sears — Racing Louisville FC (LOU) — Midfielder, #13 — age 25, USA — espnAthleteId 293305
  2026 season: 9 starts, 774 minutes, 10 appearances, 2 goals, 3 assists
- Ludmila — San Diego Wave FC (SD) — Forward, #17 — age 31, Brazil — espnAthleteId 258819
  2026 season: 12 starts, 934 minutes, 13 appearances, 1 goal, 0 assists
- Jess Fishlock — Seattle Reign FC (SEA) — Midfielder, #10 — age 39, Wales — espnAthleteId 259621
  2026 season: 5 starts, 345 minutes, 5 appearances, 1 goal, 0 assists
- Cloé Lacasse — Utah Royals (UTA) — Midfielder, #24 — age 32, Canada — espnAthleteId 317623
  2026 season: 12 starts, 954 minutes, 12 appearances, 4 goals, 3 assists
- Trinity Rodman — Washington Spirit (WAS) — Forward, #2 — age 24, USA — espnAthleteId 317423
  2026 season: 11 starts, 906 minutes, 11 appearances, 3 goals, 4 assists, 36 shots (14 on target)

## What to produce PER PLAYER (~10 questions) — HUMAN-FIRST

- **At LEAST 6 of the ~10 should be HUMAN / STORY questions** (`herStory` / `herWorld` / `trueOrFalse`):
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
- Keep it TIGHT: **≤ ~3 web searches per player.**

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

## OUTPUT — one JSON document, nothing else

Output ONLY this JSON (no prose around it), **every player above included** in the `players` array:

```json
{
  "weekKey": "2026-W27",
  "season": 2026,
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
