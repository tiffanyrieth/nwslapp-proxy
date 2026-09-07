<!--
  Know Her Game — CANONICAL weekly generation template (automation).

  ⛔ SUPERSEDED 2026-09-07: the single-generator content model below (INVERTED mix / uncapped bio / no-floor
  fun) caused a bio-only regression and was ROLLED BACK. Generation is now SPLIT into two isolated routines,
  derived from the last-known-good OG language (commit 6e4374f): knowher-bio-TEMPLATE.md (career/bio, target
  ~7-8) + knowher-fun-TEMPLATE.md (fun facts, target ~4-5). This file is kept only as the assembler's default
  template for the existing tests; the LIVE pipeline fills the two split templates. Do not run this one.

  Provenance: this is the PROVEN Rodman-WORKING query (scripts/knowher-prompt-rodman-WORKING.md — the
  gold standard, keep untouched) scaled to 16 players, with the owner's 2026-07-13 fidelity rulings
  applied: ">=6 MUST be human" (not "should"), NO web-search cap, thin-coverage anti-fabrication rule
  kept, and all operator notes moved into THIS comment so the model receives exactly the Rodman-shaped
  query. Owner ruling 2026-09-07 applied: career/life STORY is now the deep, UNCAPPED majority — ONLY the old
  ~2-3 CAREER CAP was removed (the bio cap, not the fun-fact floor, was what starved thin players like SD). The
  fun-fact FLOOR is KEPT: produce ~4-5 fun facts (verifier trims to ~2-3), so fun facts stay mandatory. Also
  replaced the source rules with a strict A-TIER allow-list (single source) plus a fun-facts-only escape hatch
  requiring >=2 sources, banning all local news. The wording below is DELICATE and owner-owned — never change it
  without an explicit owner decision (query fidelity is the product).

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

- **The human questions are TWO buckets: her career/life STORY (the majority, ~5–6) + a real ~4–5 fun-fact set
  (the verifier trims fun to ~2–3)** (`herStory` / `herWorld` / `trueOrFalse`). This is a fandom quiz, not a stat sheet — but "story" is NOT a dry
  résumé. Her STORY is narrative and celebratory: where she grew up and how she started, her youth academy and
  college, how she arrived (the signing-announcement story), her national-team path, her records, milestones, and
  last season's big moments. THAT is the backbone and should be the **largest share (~5–6 per player)**. Mine it
  DEEPLY from the A-tier sources below — a club's signing announcement alone introduces her whole pre-club story,
  and her Wikipedia / NWSL / U.S. Soccer / college pages are rich with verifiable career facts. (This reverses the
  old rule that capped career facts — career/life STORY is now the core of the quiz, not a fallback.)
- **FUN FACTS — TARGET ~4–5 per player (a real requirement, not a soft suggestion).** Off-pitch personality: a
  hobby, a relatable habit, a pre-game ritual, a pet, a second passion, an unusual skill, a get-to-know-her
  answer (the "she travels with her PS5" kind — warm, surprising, makes you smile). **Produce ~4–5 fun facts**
  (the verifier trims to a final ~2–3, so overshoot on purpose). This is the FLOOR that makes the game work —
  hold to it. **Falling short of ~4 is acceptable ONLY when a documented hunt genuinely came up short**: then
  flag her in your report, and her **(now UNCAPPED)** career story fills the rest — never pad or invent to hit
  the number. But "I didn't really look" is NOT a shortfall. Uncapping bio is NOT permission to skip the hunt. Fun facts are the
  HARD part and the whole point of this game (the Rodman standard); bio is the fast, always-there route, so the
  trap is to fill up on bio and phone in the fun facts — DO NOT do that. Run a GENUINE, EXHAUSTIVE off-pitch hunt
  for EVERY player in the pro-women interview wells (Girls Soccer Network, Just Women's Sports, Beats & Rhymes FC,
  Fangirl Sports Network) plus the club "get to know" / Q&A features, and include EVERY quality fun fact you find.
  A player who HAS findable fun facts but comes back all-bio because bio was easier is a FAILURE. VARY questions
  throughout — don't cluster all the True/False, don't save the best fact for last. (The system weaves its 2 stat
  questions in at the one-third and two-thirds marks, so leave no room for them.)
- ⚠️ **NEVER fabricate** — a stretched or invented fun fact is the worst failure. A **bio-led player is a normal,
  successful outcome, not a gap to paper over**: if a low-coverage player yields few off-pitch facts after a
  genuine look, use what exists and let her career story carry her. (Note what you searched in your report if you
  like — but "bio-heavy" is a success here, not a shortfall.)

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

## Sourcing — the A-TIER allow-list (single source) + a fun-facts-only escape hatch (≥2)

- **A-TIER — one of these ALONE is enough** (trusted, no independent corroboration needed). Use for CAREER/BIO,
  and for a fun-fact quote the player gives DIRECTLY in an A-tier interview:
  - **Authoritative:** Wikipedia · official club sites · NWSL.com · ESPN · U.S. Soccer · Olympics.com ·
    college / university athletics sites · FIFA.com · CAF / UEFA / Concacaf · a player's national federation.
  - **Major outlets:** The Athletic · Sports Illustrated · AP · Reuters · NYT · Washington Post · People ·
    NBC (NBC Olympics / Sports) · CBS Sports · Yahoo Sports · BBC.
  - **Pro-women interview wells:** Girls Soccer Network · Just Women's Sports · Beats & Rhymes FC · Fangirl Sports Network.
  - **Approved editorial extras:** Nike (about.nike.com magazine) · CLIF (athlete features) · Grant Wahl ("Fútbol with Grant Wahl").
  ⭐ For CAREER/BIO, lead with the authoritative sources (her signing story, her club / NWSL / U.S. Soccer bio,
  Wikipedia, her college page). For FUN FACTS, the club "get to know" / Q&A features and the interview wells are best.
- **ESCAPE HATCH — FUN FACTS ONLY, and only with ≥2 independent agreeing sources.** For a genuine off-pitch fun
  fact on a REPUTABLE source NOT on the A-tier list (e.g. a reputable foreign-language outlet for an international
  player), use it ONLY if **two independent reputable sources agree** on it. **CAREER/BIO must come from A-tier —
  never from the escape hatch.** (The verifier enforces the ≥2 rule.)
- **NEVER (banned outright, even via the escape hatch):** ALL local news (TV or paper) · social media / TikTok /
  random YouTube · fan wikis · gossip / tabloid / celebrity-lifestyle sites · rage-bait outlets · video-game DBs
  (futbin) · e-commerce / merch / product pages · unsourced blogs. Only cite URLs you actually retrieved — if you
  can't verify, drop it.
- **Disambiguate:** confirm each fact is about THIS player (the correct NWSL player + her CURRENT club as
  listed above / her national team) — discard same-or-similar-name namesakes.
- **Search effort — deep bio AND an exhaustive fun-fact hunt (NOT either/or; NOT bio-then-a-token-pass).** Do
  **at least ~5–6 searches per player**, and a real share MUST target the off-pitch angle: actually search each
  player in the interview wells by name — "<player> Beats and Rhymes FC", "<player> Girls Soccer Network",
  "<player> Just Women's Sports", "<player> get to know / off the pitch / interview" — and OPEN them; do not
  claim "no off-pitch content" after a shallow look. Mine the A-tier bio sources deeply for the career story AND
  dig just as hard for the fun facts; do NOT let the easy bio route crowd out the hard hunt. Under-searching the
  off-pitch angle and filling up on quick bio is the #1 way this game degrades — err toward one more off-pitch
  search, not one more career fact. Never stop at a shallow skim; never pad a thin fun-fact count.
- **International players — extend the hunt to her language/country.** For a non-US player (or one who played
  abroad), her off-pitch color often lives in **reputable foreign-language outlets** the English wells miss —
  search in her language too (e.g. Spanish for Maitane/Palacios/Ascanio's Venezuelan side, German for a Bundesliga
  player). Those are the **escape hatch**, so a fun fact from them needs **≥2 independent agreeing sources**
  (career/bio still comes from A-tier only). Don't leave an international player fun-fact-less just because the
  English wells were quiet.

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
  collide with the system's `was-stat-goals` ids), a `prompt`, a warm one-sentence `revealFact` (the
  "learn"/delight payoff), and a **`source`** — the exact URL you verified that fact from (⚠️ REQUIRED on
  every question you write; the publish is now gated on it). The `source` is what lets an independent VERIFY
  pass re-confirm each fact before it goes live, and it keeps every published fact auditable. Cite the page
  you actually retrieved the fact from — an A-tier club/NWSL/editorial URL, not a search-results page.
  **8–9 questions per player — 8 is the FLOOR.** The system appends 2 stat questions,
  so the published quiz lands at 10–11; a richer player may go to 13 (published 15). One player per team.
  ⚠️ Fewer than 8 and the merged quiz falls under the app's 10-question floor and the whole run is rejected.
  ⚠️ **Hitting 8 is NOT "done" — the count is the floor, DEPTH is the bar.** A player with 8 SHALLOW questions
  (one fact skimmed off each source) is INCOMPLETE — go back and mine her career story deeper before moving on;
  a rich player should go well past 8. And **no two questions per player may test the SAME fact** (e.g. an MC "where
  did she grow up?" and a T/F re-asking the same hometown, or three questions all restating one comeback
  story) — vary the SUBJECT, not just the phrasing. Repetition is the tell that the hunt stopped early.
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
listed "art school, architecture, bookstores" for a player whose actual questions were about her twin
sister and hometown — pure confabulation). The report is worthless — worse than worthless — if it
describes facts the player's quiz doesn't contain. So build it mechanically, per player:

1. **Walk her published `questions` array IN ORDER.** For each NON-stat question (skip `herGame`), write one
   line: the fact it tests, tagged `[P]` off-pitch personality or `[C]` career/identity — taken VERBATIM
   from that question's own `prompt`/`revealFact`, not from memory. If you can't point to the question in
   the JSON that a report line describes, DELETE the line — it's a hallucination.
2. **Mix tally + off-pitch hunt log** = per player, the `[P]` (fun fact) vs `[C]` (career/bio) count (e.g.
   "Sams: 3 fun / 6 career"), PLUS a one-line note of the OFF-PITCH wells/searches you ACTUALLY ran and what each
   yielded (e.g. "GSN: 2 quotes; Beats&Rhymes: none; club get-to-know: 1"). It must equal her real question mix.
   Career/bio can be the majority — but a LOW fun-fact count MUST be justified by that documented hunt: a thin
   count with a real, listed off-pitch search behind it is fine; a thin count with "no off-pitch content" and no
   wells actually searched is the FAILURE to catch. Bio-heavy is only OK when the fun facts genuinely weren't there.
3. **Source(s)** per player — the A-tier / escape-hatch pages you actually retrieved, so I can spot-check.
4. **Rejected facts** — any interesting fact you FOUND in research but did NOT put in a question, and why
   (couldn't verify / banned source / failed a guardrail / too private). "None rejected" is fine. A fact you
   never used does NOT go in the count above — only published questions are counted.

⚠️ The single hard rule for this whole section: **every fact you mention must be traceable to a specific
published question.** A "rejected fact" is the only exception (it's explicitly a fact NOT in the quiz). If
you catch yourself writing a personality trait you didn't turn into a question, it doesn't belong in the
count — it's either a rejected fact (say so) or a memory-confabulation (delete it).
