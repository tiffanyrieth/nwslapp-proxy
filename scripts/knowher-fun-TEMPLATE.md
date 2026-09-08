<!--
  Know Her Game — FUN-FACTS generation template (automation, 2026-09-07 3-routine split).

  Provenance: derived from the last-known-good weekly template (commit 6e4374f — the #91 verify-gate state,
  the proven Rodman-shaped query) by SPLITTING generation into isolated routines. This is the FUN-FACTS half:
  off-pitch personality is now the WHOLE job. The wording is the OG's PERSONALITY language — the hunt-hard,
  follow-the-player, "go FIND them" floor logic — carried over, with two frames applied:
    (1) TARGET ~4–5 fun facts per player (overshoot; the verifier trims to ~2–3), the OG personality floor;
    (2) career/bio is BANNED here — a separate BIO routine already wrote her career story, so this routine
        writes NO "where did she go to college" questions. Fun facts only.
  Sourcing is the finalized A-TIER allow-list PLUS the fun-facts-only escape hatch (≥2 independent agreeing
  sources for anything not A-tier) — the escape-hatch wording is UNCHANGED because it works. Everything else —
  the five-layer guardrail, the True/False format rules, the OUTPUT JSON shape, the report discipline — is the
  OG wording. DELICATE and owner-owned: never edit without an explicit owner decision (query fidelity is the product).

  Usage: the FUN routine reads the staged BIO PARTIAL, then runs
  scripts/assemble_knowher_prompt.mjs --template knowher-fun-TEMPLATE.md --roster <bio partial> to fill the
  placeholders <<WEEK_KEY>>, <<SEASON>>, <<PLAYER_LIST>> from that exact roster. The assembled output IS the
  prompt; run it, write the fun-ONLY pool, then scripts/merge_knowher_fun.mjs joins it onto the bio partial and
  the routine stages the COMBINED pool at /knowher/candidate (see scripts/knowher-fun-routine.md). Nothing live.

  HUMAN-ONLY: you write NO stat (`herGame`) questions and NO career/bio questions. Just the fun facts.
-->

You're writing the **fun-facts (off-pitch personality) half** of a quiz **for each player below** for a
**women's soccer fandom app**. This is NOT a stats app, and it is NOT a résumé. Female fans want to feel a
connection and laugh — a relatable detail like "she travels with her PS5" is gold. The whole point of THIS
routine is her life beyond soccer: a hobby, a relatable habit, a pre-game ritual, a pet, a second passion, an
unusual skill, a get-to-know-her answer. Warm, surprising, makes-you-smile details. **Make me *feel* something
and maybe laugh.**

(A separate BIO routine already wrote each player's career/life STORY — hometown, college, draft, caps,
records. That is DONE. Do NOT write career/bio questions here — no "where did she go to college", no "which
club drafted her". Your ONLY job is the off-pitch fun facts.)

## The players (the exact roster the bio routine covered)

<<PLAYER_LIST>>

## What to produce PER PLAYER (~4–5 fun facts) — HUMAN, OFF-PITCH ONLY

**Write ONLY off-pitch fun facts. Do NOT write career/bio questions (that routine already ran) and do NOT
write any `herGame` / stat questions (the system adds those in code).**

- ⭐ **FUN FACTS — GATHER broadly, then CURATE to the ~4–5 best.** Work in two phases, same as the bio routine:
  first **GATHER** every genuine off-pitch fun fact you can find across the wells below (don't stop at a number —
  a count is a stop signal); then **CURATE** to the **~4–5 most fun and varied** for the quiz, dropping the dull
  or duplicate ones (the verifier trims further to ~2–3). Off-pitch personality only: a hobby, a relatable habit,
  a pre-game ritual, a pet, a second passion, an unusual skill, a get-to-know-her answer (the "she travels with
  her PS5" kind). ~4–5 kept is the floor that makes the game work — hold to it.
- ⭐ **You have to GO FIND them — SEARCH FOR PERSONALITY, not a résumé.** These facts EXIST for almost every
  professional — they're in the "get to know", the club Q&A, the feature interview, the pro-women interview
  wells. Your job is to hunt them out. **Run a GENUINE, EXHAUSTIVE off-pitch hunt for EVERY player** in the
  pro-women interview wells (Girls Soccer Network, Just Women's Sports, Beats & Rhymes FC, Fangirl Sports
  Network) plus the club "get to know" / Q&A features — actually search each player by name in them and OPEN the
  results; do not claim "no off-pitch content" after a shallow look. Lead with terms like "<player> off the
  pitch / hobbies / fun facts / get to know / what she's like", and follow the specific threads each surfaces.
- ⚠️ **Falling short of ~4 is acceptable ONLY when a documented hunt genuinely came up short** — then flag her
  in your report (name her + the wells you actually searched + what each yielded). But "I didn't really look" is
  NOT a shortfall. A player who HAS findable fun facts but comes back thin because the hunt stopped early is a
  FAILURE. Under-searching the off-pitch angle is the #1 way this game degrades — err toward one more targeted
  search, not one fewer fun fact.
- ⚠️ **NEVER fabricate to reach the count** — a stretched or invented fun fact is the worst failure. If a
  genuinely low-coverage player truly yields fewer than ~4 off-pitch facts after a REAL hunt, use what exists
  and say so in your report — do NOT pad. (Her career story already carries her; you don't need to backfill.)
- **International players — extend the hunt to her language/country.** For a non-US player (or one who played
  abroad), her off-pitch color often lives in **reputable foreign-language outlets** the English wells miss —
  search in her language too (e.g. Spanish for a Venezuelan player, German for a Bundesliga player). Those are
  the **escape hatch**, so a fun fact from them needs **≥2 independent agreeing sources**. Don't leave an
  international player fun-fact-less just because the English wells were quiet.
- **AUTONOMY + CELEBRATION:** a fun fact must be something SHE says or does — her own direct quote or a
  documented act — never a third-party assertion about her, and never a fact that pivots to a spouse / parent /
  more-famous relative. The celebration is always about HER. (This is the five-layer guardrail below.)

## THE FIVE-LAYER GUARDRAIL (every question — non-negotiable)

1. **Public** — public life only, never private.
2. **About HER** — her own story/personality. NEVER define her through another person (esp. a more
   famous one). *(Canonical fail: "grew up around basketball → her dad is [famous NBA player]" — banned
   even though true.)*
3. **Sourced** — verified only, never rumor as fact.
4. **Holds even when true** — if it makes her story about someone else's fame, it's out.
5. **Mechanical** — if the ANSWER is another person's name/identity, it's OUT.

Framing test: WOULD ask her hobbies, quirks, a relatable travel habit, a pre-game ritual. WOULD NOT ask who
she's dating or which relative is famous.

## Sourcing — the A-TIER allow-list (single source) + a fun-facts escape hatch (≥2)

- **A-TIER — one of these ALONE is enough** (trusted, no independent corroboration needed). Use for a fun-fact
  quote the player gives DIRECTLY in an A-tier interview:
  - **Authoritative:** Wikipedia · official club sites · NWSL.com · ESPN · U.S. Soccer · Olympics.com ·
    college / university athletics sites · FIFA.com · CAF / UEFA / Concacaf · a player's national federation.
  - **Major outlets:** The Athletic · Sports Illustrated · AP · Reuters · NYT · Washington Post · People ·
    NBC (NBC Olympics / Sports) · CBS Sports · Yahoo Sports · BBC.
  - **Pro-women interview wells:** Girls Soccer Network · Just Women's Sports · Beats & Rhymes FC · Fangirl Sports Network.
  - **Approved editorial extras:** Nike (about.nike.com magazine) · CLIF (athlete features) · Grant Wahl ("Fútbol with Grant Wahl").
  ⭐ For FUN FACTS, the club "get to know" / Q&A features and the interview wells are your best well.
- **ESCAPE HATCH — FUN FACTS ONLY, and only with ≥2 independent agreeing sources.** For a genuine off-pitch fun
  fact on a REPUTABLE source NOT on the A-tier list (e.g. a reputable foreign-language outlet for an international
  player), use it ONLY if **two independent reputable sources agree** on it. One source alone — even a quote —
  can be a fabricated or parody claim you can't detect at scale, so the two-source wall is structural. (The
  verifier enforces the ≥2 rule.)
- **NEVER (banned outright, even via the escape hatch):** ALL local news (TV or paper) · social media / TikTok /
  random YouTube · fan wikis · gossip / tabloid / celebrity-lifestyle sites · rage-bait outlets · video-game DBs
  (futbin) · e-commerce / merch / product pages · unsourced blogs. Only cite URLs you actually retrieved — if you
  can't verify, drop it.
- **Disambiguate:** confirm each fact is about THIS player (the correct NWSL player + her CURRENT club as
  listed above / her national team) — discard same-or-similar-name namesakes.
- **Search effort — an exhaustive off-pitch hunt:** do **at least ~5–6 searches per player**, aimed at the
  off-pitch angle — search each player by name in the interview wells ("<player> Beats and Rhymes FC", "<player>
  Girls Soccer Network", "<player> Just Women's Sports", "<player> get to know / off the pitch / interview") and
  OPEN them; for an international, add her-language searches. Never stop at a shallow skim; never pad a thin count.

## Format — fix the True/False trap

- `category`: `herWorld` / `trueOrFalse` (prefer `herWorld` for fun facts; never `herStory`/`herGame`). MC =
  exactly 4 options; T/F = exactly 2 (`["True","False"]` in that order, so `correctIndex` 0 = True, 1 = False).
- A **single** fun fact must be an MC **"which of these has she actually done?"** — ONE true option among
  3–4 plausible-but-false ones (forces real knowledge). Do NOT make a lone fun fact a hyper-specific
  True/False ("True or false: she did <ultra-specific thing>") — the answer is obviously TRUE, a free
  guess. BANNED.
- Only use **True/False when some statements are plausibly FALSE** (a believable-but-untrue claim), so
  "true" isn't automatic. **Roughly HALF of your T/F answers across all players must be FALSE.** If you find
  yourself writing "True or false: <impressive true thing>" over and over (answer: True), STOP — that IS the
  banned obvious-true pattern; make the claim a believable-but-FALSE one, or convert it to an MC "which of these
  has she actually done?". A pool that is mostly-"True" will be REJECTED by the validator.
- Each question: unique `id` (e.g. `"was-rodman-fun-<slug>"` — always three parts minimum, club-player-slug, so
  it can't collide with the system's `was-stat-goals` ids OR the bio routine's ids; the `fun` marker keeps them
  distinct), a `prompt`, a warm one-sentence `revealFact` (the "learn"/delight payoff), and a **`source`** — the
  exact URL you verified that fact from (⚠️ REQUIRED on every question; the stage is gated on it). Cite the page
  you actually retrieved the fact from — an A-tier or escape-hatch URL, not a search-results page.
  **~4–5 fun facts per player.** They're merged onto the bio partial afterward; the COMBINED pool then clears
  the app's 8-per-player floor. One player per team.

## OUTPUT — one JSON document, nothing else (fun-ONLY)

Output ONLY this JSON (no prose around it), **every player above included** in the `players` array, each with
ONLY her fun-fact questions (the merge step re-attaches the bio questions):

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
          "id": "was-rodman-fun-<slug>",
          "category": "herWorld",
          "prompt": "Which of these has Trinity Rodman actually done?",
          "options": ["<true one>", "<plausible false>", "<plausible false>", "<plausible false>"],
          "correctIndex": 0,
          "revealFact": "<one warm sentence>",
          "source": "https://<the exact page you verified this fact from>"
        }
      ]
    }
  ]
}
```

Keep the `teamAbbreviation`, `espnAthleteId`, `playerName`, `jerseyNumber`, `position`, and `tagline` from the
roster above verbatim (the merge matches on `espnAthleteId`). Your `questions` array holds ONLY the fun facts.

After the JSON, write a review section (for MY review only, outside the JSON). ⚠️ **THE REPORT MUST BE
DERIVED FROM THE JSON YOU JUST PUBLISHED — READ YOUR OWN QUESTIONS BACK AND DESCRIBE ONLY THOSE.** Do NOT
write the report from memory or re-summarize your research; paraphrasing from memory invents facts that aren't
in the quiz (a real failure: a past run's report listed facts a player's actual questions never contained). So
build it mechanically, per player:

1. **Walk her published `questions` array IN ORDER.** For each, write one line: the fun fact it tests, taken
   VERBATIM from that question's own `prompt`/`revealFact`, not from memory. If you can't point to the question
   in the JSON that a report line describes, DELETE the line — it's a hallucination.
2. **Fun-fact count + off-pitch hunt log** — per player, the number of fun facts, PLUS a one-line note of the
   wells/searches you ACTUALLY ran and what each yielded (e.g. "GSN: 2 quotes; Beats&Rhymes: none; club
   get-to-know: 1"). A LOW count MUST be justified by that documented hunt: a thin count with a real, listed
   off-pitch search behind it is fine; a thin count with "no off-pitch content" and no wells actually searched
   is the FAILURE to catch.
3. **Source(s)** per player — the A-tier / escape-hatch pages you actually retrieved, so I can spot-check.
4. **Rejected facts** — any fun fact you FOUND but did NOT use, and why (couldn't verify / only one non-A-tier
   source / banned source / failed a guardrail / too private). "None rejected" is fine.

⚠️ The single hard rule for this whole section: **every fact you mention must be traceable to a specific
published question** (a "rejected fact" is the only exception — it's explicitly a fact NOT in the quiz).
