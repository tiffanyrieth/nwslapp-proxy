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
- ⭐ **PERSONALITY QUOTA — the whole point of this game (non-negotiable).** At least **4 of each player's
  questions MUST come from OFF-PITCH personality / quirk / human-interest material** — a hobby, a relatable
  habit, a life-beyond-soccer detail, a get-to-know-her answer, a superstition, a pre-game ritual, a pet, a
  second passion, an unusual skill (the right-to-left-note-writer, the PS5-in-the-suitcase, the pregame-artist
  kind). These facts EXIST for almost every professional — they're in the "get to know", the club Q&A, the
  feature interview, the signing-day human-interest angle, the local paper. Your job is to GO FIND THEM. A
  quiz where every "human" question is really about college / draft / transfers / clubs is a FAILED quiz, even
  if every fact is true — that is the stat-sheet trap wearing a disguise.
- ⚠️ **Career/identity questions are a LAST RESORT, capped — not a safe default.** Previous clubs, college,
  how she arrived (draft/transfer/signing), caps, a debut, an honor ARE legitimate and NOT fabrication — but
  they are the FALLBACK you reach for ONLY after a genuine personality hunt comes up short, and **no more than
  ~2–3 per player.** If you catch yourself filling a player mostly with where-she-went-to-school facts, STOP:
  that means you bailed on the hunt too early. Go back and search the off-pitch angle harder before settling.
- ⚠️ **NEVER fabricate to reach the count** — a stretched or invented fun fact is still the worst failure. But
  "I couldn't find personality facts" is almost always "I didn't search the right way," not "they don't
  exist." If a genuinely low-coverage player (a just-signed backup, an obscure international) truly yields
  fewer than 4 off-pitch facts after a REAL hunt, use what exists, fall back within the ~2–3 career cap, and
  **say so in your report** (name her + what you searched) — do NOT paper over the gap with more résumé facts.
  A reported gap is useful; a quiz silently padded with college trivia hides the problem.

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
- **Search effort — a FLOOR, not a ceiling (spend it on personality):** do **at least ~5–6 searches per
  player**, and they must be aimed at the OFF-PITCH angle — a first pass ("<player> get to know / off the
  pitch / hobbies / fun facts / what she's like"), then follow the specific threads it surfaces (her club's
  player Q&A, a feature interview, a local-paper profile, her signing-day human-interest story). One generic
  "<player> background" search that returns a résumé is NOT a hunt — it's the thing to avoid. ⚠️ Do not treat
  the budget as permission to stop early: under-searching, then backfilling with college/draft facts, is the
  #1 way this game degrades. Only after a genuine personality hunt is exhausted do you fall back (within the
  ~2–3 career cap above). The failure mode to design against is quitting the hunt while easy personality facts
  are still one thread away — err toward one more targeted search, not one more college question.

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
  you actually retrieved the fact from — a gold-tier club/NWSL/editorial URL, not a search-results page.
  **8–9 questions per player — 8 is the FLOOR.** The system appends 2 stat questions,
  so the published quiz lands at 10–11; a richer player may go to 13 (published 15). One player per team.
  ⚠️ Fewer than 8 and the merged quiz falls under the app's 10-question floor and the whole run is rejected.
  ⚠️ **Hitting 8 is NOT "done" — the count is the floor, the personality quota is the bar.** A player with 8
  questions where fewer than 4 are genuine off-pitch personality is INCOMPLETE, not finished — go back and
  find more before moving on. And **no two questions per player may test the SAME fact** (e.g. an MC "where
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
          "source": "https://<the exact gold-tier page you verified this fact from>"
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
2. **Personality count** = the tally of `[P]` vs `[C]` lines you just wrote (e.g. "Sams: 5 personality / 3
   career"). It must equal her real question mix, because you counted the actual questions. A player heavy
   on `[C]` tells me the hunt fell short for her.
3. **Source(s)** per player — the gold-tier / general-web pages you actually retrieved, so I can spot-check.
4. **Rejected facts** — any interesting fact you FOUND in research but did NOT put in a question, and why
   (couldn't verify / banned source / failed a guardrail / too private). "None rejected" is fine. A fact you
   never used does NOT go in the count above — only published questions are counted.

⚠️ The single hard rule for this whole section: **every fact you mention must be traceable to a specific
published question.** A "rejected fact" is the only exception (it's explicitly a fact NOT in the quiz). If
you catch yourself writing a personality trait you didn't turn into a question, it doesn't belong in the
count — it's either a rejected fact (say so) or a memory-confabulation (delete it).
