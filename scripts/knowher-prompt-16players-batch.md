# Know Her Game — content generation prompt

You are generating content for **Know Her Game**, a weekly "how well do you know this player?" quiz inside a women's soccer (NWSL) fandom app. For EACH player below, write ~10 quiz questions and output ONE JSON document in the exact schema at the end. This is a FANDOM feature — warm, get-to-know-her energy — not a dry stats quiz.

## The players (verified ESPN stats already provided — USE THESE NUMBERS, do not look stats up)

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
  2026 season: 11 starts, 906 minutes, 11 appearances, 3 goals, 4 assists

## What to produce per player (~10 questions)

- **~8 STAT / IDENTITY questions — build these straight from the numbers above.** Do NOT research or invent stats; use the provided goals/assists/starts/minutes/appearances/jersey/position/age/nationality. Make wrong multiple-choice options plausible (near the real value).
- **1–2 FUN-FACT questions** — a genuinely human detail about HER (personality, life beyond soccer, a career milestone or origin story). These are the emotional hook. If a player has zero clean, well-sourced fun facts, doing 10 stat/identity questions is completely fine — do NOT force a weak or dubious fun fact.

## THE FIVE-LAYER GUARDRAIL (apply to every fun-fact question — non-negotiable)

1. **Public** — public life only, never private/personal-life details.
2. **About HER** — her own career/achievements/personality/story. NEVER define her through, attribute her to, or introduce her via another person (especially a more famous one).
3. **Sourced** — official/verified only; never fan theory or rumor stated as fact.
4. **Holds even when true** — canonical failure: "grew up around basketball → her dad is [famous NBA player]." REJECT it even if true, because it makes her story about a man's fame.
5. **Mechanical rule** — if the ANSWER to a question is another person's name/identity/achievement, it's OUT.

**Framing test (imagine the player were Taylor Swift):** you WOULD ask — how many cats, her cats' names, did she play a sport growing up, a hobby she's spoken about. You would NOT ask — who she's dating, which ex a song is about. The rule isn't "no personal life" — it's "nothing that defines her through someone else."

## Sourcing rules for fun facts (all must hold, or DROP the fact)

- **≥ 2 DISTINCT-DOMAIN reputable sources** agree (mainstream outlets, official league/club/federation sites, established women's-soccer desks, reputable player-profile pieces). NOT fan wikis, video-game DBs, retailers/sponsors, or ragebait.
- **Only cite URLs you actually retrieved.** If you can't verify a fact from real, resolvable sources, DROP it — do not fabricate a citation.
- **Disambiguation:** confirm each fact is about the RIGHT NWSL player (discard same/similar-name namesakes) AND her CURRENT club as listed above.
- Keep it TIGHT: ≤ ~3 web searches per player.

## Question format rules (must match the schema exactly)

- `category` is one of: `herGame` (stats/on-the-pitch), `herStory` (career/identity/origin), `herWorld` (personality/life beyond soccer), `trueOrFalse`.
- Multiple-choice questions: **exactly 4** options, `correctIndex` 0–3.
- `trueOrFalse` questions: **exactly 2** options, and they MUST be `["True","False"]` in that order (so `correctIndex` 0 = True, 1 = False).
- Every question needs a unique `id` (e.g. `"was-rodman-goals"`), a `prompt`, and a short `revealFact` (one friendly sentence shown after answering — the "learn" payoff).
- 8–15 questions per player (aim ~10). One player per team.
- `tagline` = one warm one-line intro hook for the player.

## OUTPUT — one JSON document, nothing else

Output ONLY this JSON (no prose around it), every player above included:

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
      "tagline": "The electric forward at the heart of the Spirit's attack.",
      "questions": [
        {
          "id": "was-rodman-position",
          "category": "herGame",
          "prompt": "What position does Trinity Rodman play for the Spirit?",
          "options": ["Defender", "Midfielder", "Forward", "Goalkeeper"],
          "correctIndex": 2,
          "revealFact": "She's a forward — pace, dribbling and end product all in one."
        },
        {
          "id": "was-rodman-funfact",
          "category": "trueOrFalse",
          "prompt": "True or false: <a hyper-specific, well-sourced fun fact about her>.",
          "options": ["True", "False"],
          "correctIndex": 0,
          "revealFact": "One friendly sentence explaining the fact."
        }
      ]
    }
  ]
}
```

After the JSON, list (for MY review only, outside the JSON) the sources you used per fun fact, so I can spot-check corroboration before it goes live.