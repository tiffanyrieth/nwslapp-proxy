<!--
  Know Her Game — BIO/CAREER generation template (automation, 2026-09-07 3-routine split).

  Provenance: derived from the last-known-good weekly template (commit 6e4374f — the #91 verify-gate state,
  the proven Rodman-shaped query) by SPLITTING generation into isolated routines. This is the BIO/CAREER
  half: her career and life STORY is now the WHOLE job. The design (owner-directed 2026-09-08):
    (1) the old "career is a LAST RESORT, capped ~2–3 per player" framing is REMOVED — career/life STORY is
        this routine's entire purpose now;
    (2) the ≥4 off-pitch PERSONALITY QUOTA is REMOVED — fun facts are the FUN routine's job, not this one;
    (3) NO fixed per-player target that acts as a stop signal. Instead: GATHER broadly (exhaust the wells),
        then CURATE to the ~8–10 most varied/interesting (drop dry + duplicate). A target count made the
        routine hit its number off Wikipedia's first page and quit — the ~95%-single-source failure.
  Sourcing is a MUST-SEARCH well list (where her career lives), Wikipedia as the map — not an allow-list; a
  single trusted source confirms a career fact, NO escape hatch. Everything else — the five-layer guardrail,
  the True/False format, the OUTPUT JSON shape, the read-your-own-questions report discipline — is the OG
  wording. DELICATE and owner-owned: never edit without an explicit owner decision (query fidelity is the product).

  Usage: scripts/assemble_knowher_prompt.mjs --template knowher-bio-TEMPLATE.md substitutes the placeholders
  <<WEEK_KEY>>, <<SEASON>>, <<PLAYER_LIST>>. The assembled output IS the prompt; run it and POST the JSON to
  /knowher/candidate/bio (see scripts/knowher-bio-routine.md). The FUN routine then reads that partial back,
  appends its off-pitch fun facts, and stages the combined pool for the verify gate. This file changes nothing live.

  HUMAN-ONLY: you write NO stat (`herGame`) questions. Those are generated in code from the verified numbers
  and injected at Monday's publish. The stats appear per player below only as CONTEXT for your reveal facts.
-->

You're writing the **career and life STORY half** of a quiz **for each player below** for a **women's soccer
fandom app**. This is NOT a stats app. The legacy sports apps are male-focused, stat-heavy, and when they cover
women's sports they do a lazy cookie-cutter port. We're doing the opposite: the **Olympic approach** — tell me
who she IS so I feel a connection and want to root for her. Female fans want a HYBRID that leans into **story and
personality**, with stats as texture. Her STORY is the narrative, celebratory backbone of that: where she grew
up and how she started, her youth academy and college, how she arrived at her club (the signing-announcement
story), her national-team path, her records, milestones, and last season's big moments. Told well, a career
question makes me feel her journey — it is NOT a dry résumé line.

(A separate FUN-FACTS routine handles the off-pitch personality half — hobbies, quirks, pre-game rituals. That
is NOT your job here. You go DEEP on the career/life story; the fun facts get added after you.)

## The players (verified 2026 stats — USE THESE NUMBERS, don't look stats up)

The stats are here as CONTEXT for your reveal facts, not as material for questions — the system writes the
stat questions itself from these exact numbers.

<<PLAYER_LIST>>

## What to produce PER PLAYER — GATHER broadly, then CURATE to a varied set

**Write ONLY career/life STORY questions. Do NOT write off-pitch fun facts (that's the fun routine's job) and
do NOT write any `herGame` / stat questions (the system adds those in code).**

Work each player in TWO phases — this is the core of the routine, and the order matters:

- **PHASE 1 — GATHER (exhaust the wells; do NOT stop at a number).** Work the must-search wells in the Sourcing
  section below and collect EVERY genuine, non-duplicative career fact you can find about her — a real player
  yields ~15–30. **Do NOT aim at a target count and stop:** a count is a stop signal, and one rich page
  (Wikipedia) meets a low count in seconds and starves the quiz of everything else. The bar is "I have exhausted
  the wells," NOT "I have enough." Career facts naturally run out (~20–40 per player even for a star), so this
  self-limits — you will NOT find 250 — and the anti-fabrication rule still bans stretching or inventing to pad
  the pile. Go after: hometown and how she started, youth club / academy, college career and honors, how she
  arrived (the signing story), her national-team path and caps, debuts, records, awards, and last season's
  standout moments.
- **PHASE 2 — CURATE (a deliberate final pass, before you write the JSON).** From everything you gathered, SELECT
  the **~8–10 most varied and interesting** questions for this player and DROP the rest. Curate for:
  - **A spread of SUBJECT** — origin, youth club, college era, the signing story, national-team path, records,
    milestones, last season. Not five questions on one chapter.
  - **A spread of SOURCE** — pull the kept questions from DIFFERENT wells (her club site, NWSL, U.S. Soccer / her
    federation, her college page, Girls Soccer Network), not all from Wikipedia. A quiz whose every source is one
    site plays dry and reads like a scrape.
  - **Colorful, celebratory career beats over dry résumé filler.** KEEP the ones that make a fan feel her story —
    she was a national-team star for Zambia before the NWSL; she tore up UCLA as Player of the Year and Golden
    Boot; she set a record in her rookie year; the signing-day story of how she arrived. DROP the flat filler —
    a bare "she was signed in 2023," a draft-pick number with no story, a plain "she went to college X."
  - **No near-duplicates** — two questions testing the same fact (an MC and a T/F on the same hometown) → keep
    the better one, drop the other.
- ⚠️ **NEVER fabricate or stretch** to fill the gather pile OR the curated count. A genuinely low-coverage player
  (a just-signed teenager) may only yield ~5–6 real, verifiable career facts after a true hunt — that's fine:
  keep what exists and **say so in your report** (name her + the wells you searched). Note the handful you
  dropped as dry/dupe in your report too.
- ⚠️ **NEVER define her through another person** and never let a career fact become about someone else's fame
  (see the guardrail below). Her story is HERS.

## THE FIVE-LAYER GUARDRAIL (every question — non-negotiable)

1. **Public** — public life only, never private.
2. **About HER** — her own story/personality/career. NEVER define her through another person (esp. a more
   famous one). *(Canonical fail: "grew up around basketball → her dad is [famous NBA player]" — banned
   even though true.)*
3. **Sourced** — verified only, never rumor as fact.
4. **Holds even when true** — if it makes her story about someone else's fame, it's out.
5. **Mechanical** — if the ANSWER is another person's name/identity, it's OUT.

Framing test: WOULD ask her hometown, her college, how she arrived, a career first, a record. WOULD NOT ask
who she's dating or which relative is famous.

## Sourcing — SEARCH THESE WELLS (this is where her career lives); Wikipedia is the MAP

Career/bio facts live on a specific, predictable set of trusted sites. So this is a **must-search list, not a
"you may use these" allow-list.** For each player, actually OPEN these wells and pull from them — do NOT stop at
the first one that has enough (that's how the quiz ends up 100% Wikipedia).

**Start with Wikipedia as the MAP, not the whole answer.** Her Wikipedia page is the fastest way to learn her
shape — her clubs (current and previous), her national team, whether she played college, her career path — AND a
solid source for the hard-fact spine (hometown, youth club, draft, records). Read it to ROUTE the rest of your
search, then GO GET the story from the wells it points you to:

- **Her CURRENT club's official site** — ONLY her club (e.g. sandiegowavefc.com for an SD player, angelcity.com
  for an Angel City player; never search the other 15). Its bio / "get to know" / signing-announcement pages
  carry her arrival story and how she's played since.
- **NWSL.com** — her league bio and features.
- **U.S. Soccer — OR her national federation** if she isn't American (e.g. the Zambia FA for a Zambian player).
  National-team pages carry her international career.
- **Her college athletics page** if she played college (e.g. a UCLA / UNC athletics bio) — these often carry a
  full career-highlights profile (Player of the Year, Golden Boot, the team's championship run).
- **Girls Soccer Network** — profiles and career features.
- **Her previous clubs' sites** — for a well-traveled player (e.g. an international who played abroad before the
  NWSL), earlier clubs' pages carry that chapter.
- Also fine WHEN they carry her career facts: **ESPN · Olympics.com · FIFA / Concacaf / CAF / UEFA** (records,
  tournament appearances, national-team call-ups).

A career fact from any ONE of these trusted sites is enough — you do NOT need a second source to confirm a
career fact. The list is about **coverage, not corroboration:** hunt across it so the quiz draws from several
wells, not one. **No escape hatch for career/bio** — if a career fact isn't on one of these trusted sites, DROP
it (the ≥2-source escape hatch is the fun routine's, never bio; the verifier enforces this).

(Feature / opinion outlets — The Athletic, NYT, a podcast — are fun-facts / personality territory, NOT the bio
wells. Career facts come from the sites above.)

- **NEVER (banned outright):** ALL local news (TV or paper) · social media / TikTok / random YouTube · fan
  wikis · gossip / tabloid / celebrity-lifestyle sites · rage-bait outlets · video-game DBs (futbin) ·
  e-commerce / merch / product pages · unsourced blogs. Only cite URLs you actually retrieved — if you can't
  verify, drop it.
- **Disambiguate:** confirm each fact is about THIS player (the correct NWSL player + her CURRENT club as
  listed above / her national team) — discard same-or-similar-name namesakes.
- **Search effort:** work the wells above per player — Wikipedia to map her, then her club site, NWSL, U.S.
  Soccer / her federation, her college page, Girls Soccer Network, previous clubs. One generic "<player>
  background" search that returns a Wikipedia résumé and nothing else is NOT a hunt — it's the thing to avoid.
  Err toward opening one more well, not pulling one more fact off the same page.

## Format — fix the True/False trap

- `category`: `herStory` / `herWorld` / `trueOrFalse` (never `herGame` — that's the system's). MC = exactly 4
  options; T/F = exactly 2 (`["True","False"]` in that order, so `correctIndex` 0 = True, 1 = False).
- A **single** fact must be an MC **"which of these is true about her career?"** — ONE true option among
  3–4 plausible-but-false ones (forces real knowledge). Do NOT make a lone fact a hyper-specific
  True/False ("True or false: she was drafted <ultra-specific pick>") — the answer is obviously TRUE, a free
  guess. BANNED.
- Only use **True/False when some statements are plausibly FALSE** (a believable-but-untrue claim), so
  "true" isn't automatic. **Roughly HALF of your T/F answers across all players must be FALSE.** If you find
  yourself writing "True or false: <impressive true achievement>" over and over (answer: True), STOP — that
  IS the banned obvious-true pattern; make the claim a believable-but-FALSE one, or convert it to an MC
  "which of these is true?". A pool that is mostly-"True" will be REJECTED by the validator.
- Each question: unique `id` (e.g. `"was-rodman-<slug>"` — always three parts, club-player-slug, so it can't
  collide with the system's `was-stat-goals` ids OR the fun routine's ids), a `prompt`, a warm one-sentence
  `revealFact` (the "learn"/delight payoff), and a **`source`** — the exact trusted-well URL you verified that
  fact from (⚠️ REQUIRED on every question; the stage is gated on it). Cite the page you actually retrieved the
  fact from — her club / NWSL / U.S. Soccer / college / Wikipedia URL, not a search-results page.
  **The CURATED set is ~8–10 questions per player** (from the ~15–30 you gathered) — **3 is the hard floor for
  this PARTIAL** (the fun routine adds ~4–5 more, and the COMBINED pool must clear the app's 8-per-player floor).
  A genuinely thin player may curate to ~5–6; a rich player stays at ~8–10. One player per team. ⚠️ **The kept
  questions must span at least ~3 different source domains** — a player whose whole set is one site (Wikipedia)
  is REJECTED by the validator; go pull from another well.
- Also write a warm one-line `tagline` for each player.
- **`jerseyNumber`:** take it from the player's line above (the `#N`). If a player's line shows no number
  (ESPN didn't have it), do ONE quick lookup of her current squad number and use that — a plain integer,
  required by the schema. Don't make it a research detour.

## OUTPUT — one JSON document, nothing else

Output ONLY this JSON (no prose around it), **every player above included** in the `players` array. This is the
BIO PARTIAL — career/story questions only:

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
          "category": "herStory",
          "prompt": "Which of these is true about Trinity Rodman's career?",
          "options": ["<true one>", "<plausible false>", "<plausible false>", "<plausible false>"],
          "correctIndex": 0,
          "revealFact": "<one warm sentence>",
          "source": "https://<the exact A-tier page you verified this fact from>"
        }
      ]
    }
  ]
}
```

After the JSON, write a review section (for MY review only, outside the JSON). ⚠️ **THE REPORT MUST BE
DERIVED FROM THE JSON YOU JUST PUBLISHED — READ YOUR OWN QUESTIONS BACK AND DESCRIBE ONLY THOSE.** Do NOT
write the report from memory or re-summarize your research; by now the questions are far up in the context
and paraphrasing from memory invents facts that aren't in the quiz (a real failure: a past run's report
listed facts a player's actual questions never contained — pure confabulation). The report is worthless —
worse than worthless — if it describes facts the player's quiz doesn't contain. So build it mechanically, per player:

1. **Walk her published `questions` array IN ORDER.** For each question, write one line: the career fact it
   tests, taken VERBATIM from that question's own `prompt`/`revealFact`, not from memory. If you can't point to
   the question in the JSON that a report line describes, DELETE the line — it's a hallucination.
2. **Spread note** — per player, the curated count AND the distinct source domains it drew from (e.g. "Rodman:
   9 kept — sandiegowavefc.com ×2, nwsl.com ×2, ussoccer.com ×2, en.wikipedia.org ×3"). A set that's all one
   domain is the failure to catch. A player who came back thin (~5–6) tells me her verifiable career was
   genuinely short — name her and the wells you searched.
3. **Gathered vs kept + why-dropped** — roughly how many facts you GATHERED before curating, and the handful you
   DROPPED as dry résumé filler or near-duplicates (e.g. "gathered ~22, kept 9; dropped a bare draft-pick number
   and a duplicate hometown T/F"). This is the taste pass I want to see.
4. **Source(s)** per player — the trusted-well pages you actually retrieved, so I can spot-check.

⚠️ The single hard rule for this whole section: **every fact you mention must be traceable to a specific
published question** (a "dropped fact" is the only exception — it's explicitly a fact NOT in the quiz).
