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
  The assembled output IS the prompt; run it on a web-search-enabled model and POST the JSON to
  /knowher/ingest (see scripts/knowher-weekly-routine.md). This file changes nothing live.

  HUMAN-ONLY (2026-07-23): the model no longer writes the stat (`herGame`) questions. They are generated
  in CODE from the same verified numbers shown below (scripts/knowher-stat-questions.mjs) and merged in by
  scripts/inject_stat_questions.mjs before validation. A stat question's answer IS the number and its
  distractors are just values around it — deriving that in code costs nothing, is consistently gettable
  (the model kept producing minutes options a few apart, i.e. a mental-arithmetic test), and buys the
  model's whole budget for the human questions, which is the only place it adds value.
-->

You're writing the **human half** of a quiz **for each player below** for a **women's soccer fandom app**. This is NOT a
stats app. The legacy sports apps are male-focused, stat-heavy, and when they cover women's sports they do a
lazy cookie-cutter port. We're doing the opposite: the **Olympic approach** — tell me who she IS so I feel a
connection and want to root for her. Female fans want a HYBRID that leans into **story and personality**, with
stats as texture. If a quiz feels like a stat sheet, it has failed. Make me *feel* something and maybe laugh (a
relatable detail like "she travels with her PS5" is gold).

## The players (verified 2026 stats — USE THESE NUMBERS, don't look stats up)

The stats are here as CONTEXT for your reveal facts, not as material for questions — the system writes the
stat questions itself from these exact numbers.

<<PLAYER_LIST>>

## What to produce PER PLAYER (8–9 questions) — HUMAN ONLY

**Write ONLY human questions. Do NOT write any `herGame` / stat questions — the system automatically adds 2
per player (goals, minutes, saves, and the like) from the verified numbers above.** Every question you write
is a story question, so spend the whole budget there.

- **All 8–9 must be HUMAN / STORY questions** (`herStory` / `herWorld` / `trueOrFalse`):
  personality, relatable quirks, life beyond soccer, origin story, career milestones. Most featured players
  have *tons* of these — but you have to SEARCH FOR PERSONALITY, not a résumé. Lead with terms like
  "<player> off the pitch / hobbies / fun facts / get to know / what she's like", NOT "<player> background"
  (that just returns draft position, college, and transfer fees — the stat-sheet trap). **Mine the official
  NWSL.com and her club's site** — their player Q&As, "get to know her" features, and her SIGNING-
  ANNOUNCEMENT story are gold-tier AND rich with the human detail you want (the PS5-in-the-suitcase kind).
  Warm, surprising, makes-you-smile details. VARY them throughout — don't cluster all the True/False
  together, and don't save the single best fact for last. (The system weaves its 2 stat questions into your
  run at the one-third and two-thirds marks, so you don't need to leave room for them.)
- ⚠️ **Coverage varies across 16 players — NEVER fabricate to reach the count.** A less-covered player (a
  backup keeper, a lower-profile international) may not have 8 clean, well-sourced *personality* facts. If so:
  use as many as genuinely exist, then fill the rest with **verifiable CAREER / IDENTITY questions** — previous
  clubs, college or youth club, how she arrived at this club (draft, transfer, signing), national-team caps or
  a first call-up, a debut, an honor. Those are documented for every professional, still tell you who she is,
  and are NOT stat questions (the system handles those). Make them THINK — no gimmes ("what position does she
  play?", "what's her number?"). A stretched or invented fun fact is the WORST failure: a solid career question
  beats a personality fact you had to reach for.

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
  ⭐ **For PERSONALITY, the official NWSL.com and club sites are your best gold-tier well** — "get to know",
  player Q&As, and signing-announcement features carry the warm/relatable detail a Wikipedia career summary never will.
- **General web (anything not gold-tier):** needs ≥2 DISTINCT reputable domains that agree.
- **NEVER:** fan wikis, gossip/tabloid, video-game DBs (futbin), retailer/sponsor pages, random YouTube/
  social, unsourced blogs. Only cite URLs you actually retrieved — if you can't verify, drop it.
- **Disambiguate:** confirm each fact is about THIS player (the correct NWSL player + her CURRENT club as
  listed above / her national team) — discard same-or-similar-name namesakes.
- **Search budget (soft):** aim for **~5–6 searches per player**. Well-covered players won't need that
  many; for a thin-coverage player, once you've spent ~5–6 and the personality well is dry, STOP — fall back
  to verifiable career/identity questions (per the coverage rule above) rather than hunting endlessly. A
  solid career question beats grinding a dozen searches for one more reached-for fact.

## Format — fix the True/False trap

- `category`: `herStory` / `herWorld` / `trueOrFalse` (never `herGame` — that's the system's). MC = exactly 4
  options; T/F = exactly 2 (`["True","False"]` in that order, so `correctIndex` 0 = True, 1 = False).
- A **single** fun fact must be an MC **"which of these has she actually done?"** — ONE true option among
  3–4 plausible-but-false ones (forces real knowledge). Do NOT make a lone fun fact a hyper-specific
  True/False ("True or false: she did <ultra-specific thing>") — the answer is obviously TRUE, a free
  guess. BANNED.
- Only use **True/False when some statements are plausibly FALSE** (a believable-but-untrue claim), so
  "true" isn't automatic. **Roughly HALF of your T/F answers across all players must be FALSE.** If you find
  yourself writing "True or false: <impressive true achievement>" over and over (answer: True), STOP — that
  IS the banned obvious-true pattern; make the claim a believable-but-FALSE one, or convert it to an MC
  "which of these has she actually done?". A pool that is mostly-"True" will be REJECTED by the validator.
- Each question: unique `id` (e.g. `"was-rodman-<slug>"` — always three parts, club-player-slug, so it can't
  collide with the system's `was-stat-goals` ids), a `prompt`, and a warm one-sentence `revealFact` (the
  "learn"/delight payoff). **8–9 questions per player — 8 is the FLOOR.** The system appends 2 stat questions,
  so the published quiz lands at 10–11; a richer player may go to 13 (published 15). One player per team.
  ⚠️ Fewer than 8 and the merged quiz falls under the app's 10-question floor and the whole run is rejected.
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
