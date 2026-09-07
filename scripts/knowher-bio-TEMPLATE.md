<!--
  Know Her Game — BIO/CAREER generation template (automation, 2026-09-07 3-routine split).

  Provenance: derived from the last-known-good weekly template (commit 6e4374f — the #91 verify-gate state,
  the proven Rodman-shaped query) by SPLITTING generation into isolated routines. This is the BIO/CAREER
  half: her career and life STORY is now the WHOLE job. Two deliberate edits to the OG career language:
    (1) the old "career is a LAST RESORT, capped ~2–3 per player" framing is REMOVED — career/life STORY is
        this routine's entire purpose now, TARGET ~7–8 per player (overshoot; the verifier trims to ~5–6);
    (2) the ≥4 off-pitch PERSONALITY QUOTA is REMOVED — fun facts are the FUN routine's job, not this one.
  Sourcing is the finalized A-TIER allow-list (a single trusted source is enough), with NO escape hatch:
  career/bio must ALWAYS rest on an A-tier source. Everything else — the five-layer guardrail, the True/False
  format rules, the OUTPUT JSON shape, the read-your-own-questions report discipline — is the OG wording,
  unchanged. DELICATE and owner-owned: never edit without an explicit owner decision (query fidelity is the product).

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

## What to produce PER PLAYER (~7–8 career/life STORY questions) — HUMAN, BIO-ONLY

**Write ONLY career/life STORY questions. Do NOT write off-pitch fun facts (that's the fun routine's job) and
do NOT write any `herGame` / stat questions (the system adds those in code).** Every question you write is a
career/story question, so spend the whole budget there.

- **TARGET ~7–8 career/life STORY questions per player** (`herStory` / `herWorld` / `trueOrFalse`). This is an
  overshoot on purpose: the verify gate re-confirms each fact and drops any it can't, so aim high (~7–8) and the
  edition lands where it should (~5–6 confirmed) with room to spare. Do NOT go crazy — ~7–8 is the aim, not 15.
- **Mine her STORY DEEPLY from the A-tier sources below.** A club's signing announcement alone introduces her
  whole pre-club story; her Wikipedia / NWSL / U.S. Soccer / national-federation / college-athletics pages are
  rich with verifiable career facts. Go after: hometown and how she started, youth club / academy, college
  career and honors, how she arrived (draft / transfer / signing), her national-team path and caps, debuts,
  records, awards, and last season's standout moments. **VARY the subject** — don't ask three questions that all
  restate one comeback story; each question tests a DIFFERENT fact of her story.
- ⚠️ **DEPTH is the bar, not just the count.** ~7–8 SHALLOW questions (one fact skimmed off each source) is
  INCOMPLETE — go back and mine her story deeper. A rich, long-career player can go past 8; a genuinely
  low-coverage player (a just-signed young backup) may only support ~5–6 real career facts — that's fine, use
  what's verifiable and **say so in your report** (name her + what you searched). NEVER fabricate or stretch a
  fact to reach the number — a harder-to-confirm real fact beats an invented one.
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

## Sourcing — the A-TIER allow-list ONLY (a single trusted source is enough; NO escape hatch)

Career/bio must ALWAYS rest on an A-tier source — one of these alone confirms it, no second source needed:

- **Authoritative:** Wikipedia · official club sites · NWSL.com · ESPN · U.S. Soccer · Olympics.com ·
  college / university athletics sites · FIFA.com · CAF / UEFA / Concacaf · a player's national federation.
- **Major outlets:** The Athletic · Sports Illustrated · AP · Reuters · NYT · Washington Post · People ·
  NBC (NBC Olympics / Sports) · CBS Sports · Yahoo Sports · BBC.
- **Pro-women interview wells:** Girls Soccer Network · Just Women's Sports · Beats & Rhymes FC · Fangirl Sports Network.
- **Approved editorial extras:** Nike (about.nike.com magazine) · CLIF (athlete features) · Grant Wahl ("Fútbol with Grant Wahl").

⭐ For CAREER/BIO, lead with the authoritative sources — her signing story, her club / NWSL / U.S. Soccer bio,
Wikipedia, her college athletics page. Those carry the whole verifiable career.

- **NO escape hatch for career/bio.** There is a ≥2-source escape hatch for FUN FACTS in the other routine, but
  career/bio never uses it — if a career fact isn't on an A-tier source, DROP it. (The verifier enforces this.)
- **NEVER (banned outright):** ALL local news (TV or paper) · social media / TikTok / random YouTube · fan
  wikis · gossip / tabloid / celebrity-lifestyle sites · rage-bait outlets · video-game DBs (futbin) ·
  e-commerce / merch / product pages · unsourced blogs. Only cite URLs you actually retrieved — if you can't
  verify, drop it.
- **Disambiguate:** confirm each fact is about THIS player (the correct NWSL player + her CURRENT club as
  listed above / her national team) — discard same-or-similar-name namesakes.
- **Search effort — a FLOOR, not a ceiling:** do **at least ~5–6 searches per player**, aimed at her career
  story (her signing announcement, her club / NWSL / U.S. Soccer bio, her college page, her Wikipedia). Mine
  each A-tier source deeply rather than skimming one fact off each. Don't grind endlessly past a genuine depth.

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
  `revealFact` (the "learn"/delight payoff), and a **`source`** — the exact A-tier URL you verified that fact
  from (⚠️ REQUIRED on every question; the stage is gated on it). Cite the page you actually retrieved the fact
  from — an A-tier club/NWSL/editorial URL, not a search-results page.
  **~7–8 questions per player — 3 is the hard floor for this PARTIAL** (the fun routine adds ~4–5 more, and the
  COMBINED pool must clear the app's 8-per-player floor). Aim ~7–8; a rich player may go higher. One player per team.
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
2. **Depth note** — per player, the number of career questions and a one-line note on how deep her story went
   (e.g. "Rodman: 8 career — hometown, youth club, draft, 3 records, 2 last-season moments"). A player who came
   back thin (~5–6) tells me her verifiable career was genuinely short — name her and what you searched.
3. **Source(s)** per player — the A-tier pages you actually retrieved, so I can spot-check.
4. **Dropped facts** — any career fact you FOUND but did NOT use, and why (couldn't verify on A-tier / banned
   source / failed a guardrail). "None dropped" is fine.

⚠️ The single hard rule for this whole section: **every fact you mention must be traceable to a specific
published question** (a "dropped fact" is the only exception — it's explicitly a fact NOT in the quiz).
