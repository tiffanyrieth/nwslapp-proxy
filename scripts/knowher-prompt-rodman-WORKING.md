# Know Her Game — content generation (Trinity Rodman only)

You're writing a ~10-question quiz for a **women's soccer fandom app**. This is NOT a stats app.
The legacy sports apps are male-focused, stat-heavy, and when they cover women's sports they do a lazy
cookie-cutter port. We're doing the opposite: the **Olympic approach** — tell me who she IS so I feel a
connection and want to root for her. Female fans want a HYBRID that leans into **story and personality**,
with stats as texture. If the quiz feels like a stat sheet, it has failed. Make me *feel* something and
maybe laugh (a relatable detail like "she travels with her PS5" is gold).

## The player (verified 2026 stats — USE THESE NUMBERS, don't look stats up)

- **Trinity Rodman** — Washington Spirit (WAS) — Forward, #2 — age 24, USA — espnAthleteId 317423
  2026 season: 11 starts, 906 minutes, 11 appearances, 3 goals, 4 assists, 36 shots (14 on target)

## What to produce (~10 questions) — HUMAN-FIRST

- **At LEAST 6 of the ~10 must be HUMAN / STORY questions** (`herStory` / `herWorld` / `trueOrFalse`):
  personality, relatable quirks, life beyond soccer, origin story, career milestones. Trinity Rodman has
  *tons* of these — dig (Google "Trinity Rodman fun facts", inside and outside soccer). Warm, surprising,
  makes-you-smile details. INTERLEAVE them throughout (never dump them at the end).
- **At MOST ~4 stat/identity questions** (`herGame`), and make them THINK — MC options that are genuinely
  CLOSE (e.g. minutes with several plausible 900-range options). NO gimmes ("what position?", "what's her
  number?", "how many games has a star started?" → obviously ~all). A star's basic stats are boring.

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
  Soccer Network, The Athletic, ESPN, Sports Illustrated, AP, Reuters, official NWSL / Washington Spirit /
  U.S. Soccer / Olympics.com, and major national outlets (NYT, Washington Post, People). A fact from any
  ONE of these is trusted — do NOT drop it for lack of a second source.
- **General web (anything not gold-tier):** needs ≥2 DISTINCT reputable domains that agree.
- **NEVER:** fan wikis, gossip/tabloid, video-game DBs (futbin), retailer/sponsor pages, random YouTube/
  social, unsourced blogs. Only cite URLs you actually retrieved — if you can't verify, drop it.
- Disambiguate: confirm each fact is about THIS Trinity Rodman (Washington Spirit / USWNT).

## Format — fix the True/False trap

- `category`: `herGame` / `herStory` / `herWorld` / `trueOrFalse`. MC = exactly 4 options; T/F = exactly 2.
- A **single** fun fact must be an MC **"which of these has she actually done?"** — ONE true option among
  3–4 plausible-but-false ones (forces real knowledge). Do NOT make a lone fun fact a hyper-specific
  True/False ("True or false: she did <ultra-specific thing>") — the answer is obviously TRUE, a free
  guess. BANNED.
- Only use **True/False when some statements are plausibly FALSE** (a believable-but-untrue claim), so
  "true" isn't automatic. Mix true and false answers across the T/F questions.
- Each question: unique `id`, `prompt`, warm one-sentence `revealFact` (the "learn"/delight payoff).
- Also write a warm one-line `tagline` for her.

## OUTPUT — one JSON document, nothing else

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

After the JSON, list the source(s) you used for each human fact (for my review), noting which are gold-tier.