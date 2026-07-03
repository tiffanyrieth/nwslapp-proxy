# Know Her Game — quiz content generation prompt (canonical + reusable)

**What this is.** The single source of truth for generating a ~10-question Know Her Game quiz for one
featured player. This is the refined prompt used for the Trinity Rodman generation, generalized into a
reusable template.

**Workflow (MANUAL — this file changes nothing live).** Generation is human-run, not automated:
1. Fill in the **PLAYER BLOCK** below with that week's VERIFIED stats (the model must *use* these numbers,
   never look them up).
2. Run everything under **THE PROMPT** against a capable, web-search-enabled model.
3. Paste the JSON output into the proxy's `/knowher/admin` portal (`upsertPlayer` op).
Nothing is live until step 3 — editing this template never touches the served `/knowher` pool.

**This is the MANUAL path (web-search OK).** Run interactively, one player at a time, with a web-search
model — cost is a non-issue for one-offs. This is intentionally SEPARATE from the *automated* cost-viable
pipeline sketched in the app repo's `docs/know-her-game.md` (Haiku + Wikipedia extract, NO `web_search`,
built for 16-players/week scale). Don't wire this web-search prompt into an automated loop — that's the
exact ~$2/player cost trap the design doc warns against.

**Provenance.** Refined from the first player generation → the **Trinity Rodman** iteration. It encodes the
playthrough learnings recorded in the app repo's `docs/know-her-game.md` §7: gimme-stat ban, difficulty via
plausible-close options (not obscurity), 2–3 fun-fact questions interleaved throughout, and the
lone-hyper-specific-True/False → MC "which of these has she actually done?" fix. **Supersedes the old
`knowher_prototype.mjs`**, whose embedded guidance ("use hyper-specific true/false") is now BANNED.

---

## PLAYER BLOCK — fill in with VERIFIED stats before running

> The model must USE these numbers, not look stats up. Verify each against a gold-tier source first.

```
- <Full Name> — <Club> (<ABBR>) — <Position>, #<number> — age <age>, <country> — espnAthleteId <id>
  <season> season: <starts> starts, <minutes> minutes, <appearances> appearances,
  <goals> goals, <assists> assists, <shots> shots (<on-target> on target)
```

Reference example (the Rodman run this template came from):

```
- Trinity Rodman — Washington Spirit (WAS) — Forward, #2 — age 24, USA — espnAthleteId 317423
  2026 season: 11 starts, 906 minutes, 11 appearances, 3 goals, 4 assists, 36 shots (14 on target)
```

---

## THE PROMPT (everything below is fed to the model)

You're writing a ~10-question quiz for a **women's soccer fandom app**. This is NOT a stats app.
The legacy sports apps are male-focused, stat-heavy, and when they cover women's sports they do a lazy
cookie-cutter port. We're doing the opposite: the **Olympic approach** — tell me who she IS so I feel a
connection and want to root for her. Female fans want a HYBRID that leans into **story and personality**,
with stats as texture. If the quiz feels like a stat sheet, it has failed. Make me *feel* something and
maybe laugh (a relatable detail like "she travels with her PS5" is gold).

### The player (verified stats — USE THESE NUMBERS, don't look stats up)

*(Paste the filled-in PLAYER BLOCK here.)*

### What to produce (~10 questions) — HUMAN-FIRST

- **At LEAST 6 of the ~10 must be HUMAN / STORY questions** (`herStory` / `herWorld` / `trueOrFalse`):
  personality, relatable quirks, life beyond soccer, origin story, career milestones. A star of this
  caliber has *tons* of these — dig (Google "<player> fun facts", inside and outside soccer). Warm,
  surprising, makes-you-smile details. INTERLEAVE them throughout (never dump them at the end).
- **At MOST ~4 stat/identity questions** (`herGame`), and make them THINK — MC options that are genuinely
  CLOSE (e.g. minutes with several plausible 900-range options). NO gimmes ("what position?", "what's her
  number?", "how many games has a star started?" → obviously ~all). A star's basic stats are boring.

### THE FIVE-LAYER GUARDRAIL (every human question — non-negotiable)

1. **Public** — public life only, never private.
2. **About HER** — her own story/personality/career. NEVER define her through another person (esp. a more
   famous one). *(Canonical fail: "grew up around basketball → her dad is [famous NBA player]" — banned
   even though true.)*
3. **Sourced** — verified only, never rumor as fact.
4. **Holds even when true** — if it makes her story about someone else's fame, it's out.
5. **Mechanical** — if the ANSWER is another person's name/identity, it's OUT.

Framing test: WOULD ask her hobbies, quirks, a relatable travel habit, a career first. WOULD NOT ask who
she's dating or which relative is famous.

### Sourcing — GOLD-TIER sources can be a SINGLE source

- **GOLD-TIER (one of these alone is enough — trusted editorial desks):** Just Women's Sports, Girls
  Soccer Network, The Athletic, ESPN, Sports Illustrated, AP, Reuters, official NWSL / club /
  U.S. Soccer / Olympics.com, and major national outlets (NYT, Washington Post, People). A fact from any
  ONE of these is trusted — do NOT drop it for lack of a second source.
- **General web (anything not gold-tier):** needs ≥2 DISTINCT reputable domains that agree.
- **NEVER:** fan wikis, gossip/tabloid, video-game DBs (futbin), retailer/sponsor pages, random YouTube/
  social, unsourced blogs. Only cite URLs you actually retrieved — if you can't verify, drop it.
- Disambiguate: confirm each fact is about THIS player (correct club / national team).

### Format — fix the True/False trap

- `category`: `herGame` / `herStory` / `herWorld` / `trueOrFalse`. MC = exactly 4 options; T/F = exactly 2.
- A **single** fun fact must be an MC **"which of these has she actually done?"** — ONE true option among
  3–4 plausible-but-false ones (forces real knowledge). Do NOT make a lone fun fact a hyper-specific
  True/False ("True or false: she did <ultra-specific thing>") — the answer is obviously TRUE, a free
  guess. BANNED.
- Only use **True/False when some statements are plausibly FALSE** (a believable-but-untrue claim), so
  "true" isn't automatic. Mix true and false answers across the T/F questions.
- Each question: unique `id`, `prompt`, warm one-sentence `revealFact` (the "learn"/delight payoff).
- Also write a warm one-line `tagline` for her.

### OUTPUT — one JSON document, nothing else

```json
{
  "weekKey": "<season>-W<week>",
  "season": <season>,
  "players": [
    {
      "teamAbbreviation": "<ABBR>",
      "espnAthleteId": "<id>",
      "playerName": "<Full Name>",
      "jerseyNumber": <number>,
      "position": "<Position>",
      "tagline": "<warm one-liner>",
      "questions": [
        {
          "id": "<abbr>-<lastname>-<slug>",
          "category": "herWorld",
          "prompt": "Which of these has <player> actually done?",
          "options": ["<true one>", "<plausible false>", "<plausible false>", "<plausible false>"],
          "correctIndex": 0,
          "revealFact": "<one warm sentence>"
        }
      ]
    }
  ]
}
```
