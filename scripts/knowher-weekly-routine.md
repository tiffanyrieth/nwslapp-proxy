# Know Her Game — weekly generation routine (cloud agent runbook)

You are the automated weekly content routine for **Know Her Game**, a player quiz in a women's-soccer
(NWSL) fandom app. Your job: assemble this week's generation prompt, execute it, validate the result,
and publish it to the live game. You run unattended — **your final message is the owner's only report**,
so make it precise, and NEVER publish anything that failed validation.

You received `INGEST_KEY` in your instructions (it is a secret — never print it, never write it to a
file, never commit it). The proxy base URL is `https://nwslapp-proxy.tiffany-rieth.workers.dev`.

## Steps — follow exactly, in order

### 1. Assemble the week's prompt (deterministic — do NOT write the prompt yourself)

```bash
node scripts/assemble_knowher_prompt.mjs > /tmp/knowher-prompt.md
```

Know Her Game runs **biweekly**, alternating the Fan Zone quiz slot with NWSL Trivia, so the assembler
self-gates on season-week parity (anchor = the committed `SEASON_ANCHOR` constant in
`assemble_knowher_prompt.mjs` — the Monday of regular-season Week 1, `2026-03-09`; the `KHG_SEASON_ANCHOR`
env var overrides it for tests. Bump the constant each new season). Handle the THREE outcomes:
- **Exit 0, prompt file NON-EMPTY** → a KHG week: proceed. It also writes `/tmp/knowher-stats.json` (the
  verified per-player numbers, `📊` line on stderr) — step 2b needs it, so don't delete it and don't run
  step 2b from a different session. Capture any `⚠️ GAP` lines from stderr for the final report (a gap team
  keeps last week's player in the app — report it, don't fix it).
- **Exit 0, prompt file EMPTY** (stderr: `⏸ Not a Know Her Game week`) → an off (NWSL Trivia) week. **STOP
  and report SUCCESS:** "off week — Trivia's turn; the current 2-week KHG pool stays live; nothing
  generated." Do NOT proceed. (If the anchor were ever unset/invalid the assembler warns + generates weekly
  as a fail-safe — treat as a normal KHG week but flag it in the report.)
- **Exit 1** → **STOP** and report FAILURE (offseason or the proxy/ESPN is down; nothing to generate).
- The assembled file is the complete, fine-tuned generation query. **Treat its wording as immutable** —
  do not edit, reorder, summarize, or "improve" it. It was tuned over many sessions and small wording
  changes degrade the output.

### 2. Execute the prompt

Read `/tmp/knowher-prompt.md` and carry out its instructions exactly as written — it tells you what to
research (web search for human/story facts, with its own sourcing guardrails), what to write, and the
exact JSON shape to output. Honor every rule in it, including:
- USE the provided stats verbatim; never look stats up.
- The five-layer guardrail and gold-tier sourcing rules for every human question.
- If a fact can't be verified per those rules, drop it — a harder stat question beats a stretched fact.

⚙️ **HOW to work through the 16 players — keep it LEAN (this is a cost/session rule):**
- **Do NOT spawn a separate sub-agent per player.** Research and write the players YOURSELF. Spinning up
  16 parallel research agents multiplies the session's token cost ~16× for no quality gain, and the run
  is only as fast as the slowest straggler. Work through them sequentially, or in small groups of a few
  at a time — you have all night, so favor low token cost over wall-clock speed.
- ⚠️ **BUILD THE POOL INCREMENTALLY — never emit all 16 players in one response.** The full pool is ~1,200
  lines of JSON; writing it in a single message BLOWS the model's output-token cap (the first automated
  run hit `exceeded the 32000 output token maximum` and, worse, reacted by trimming every player to the
  bare-minimum question count). Instead, work in **batches of ~4 players**: research a batch, then WRITE
  that batch's player objects to `/tmp/knowher-pool.json` — appending to the `players` array (start the
  file with `{"weekKey":…,"season":…,"players":[` on the first batch, append objects each batch, close
  `]}` at the end) — before moving to the next batch. No single response should carry more than ~4 players'
  JSON. This removes the cap failure AND the pressure to shorten players.
- **Respect the prompt's search budget** (~5–6 searches per player). For a thin-coverage player, once
  you've spent that, STOP hunting and fall back to hard stat questions — the prompt explicitly allows a
  5-human/5-stat quiz over a reached-for 6th fact. Don't grind endlessly on obscure players.
- **HUMAN-ONLY — do not write stat questions.** The prompt asks for **8–9 human questions per player** and
  nothing else; the 2 stat (`herGame`) questions are generated in code and merged in at step 2b. Writing your
  own stat questions duplicates them.
- **Hit the quality bar as you write (the validator enforces it — step 3):** **8–9 human questions per
  player** (8 is the floor — fewer and the merged pool falls under the app's 10-question minimum and the run
  is rejected), and **vary True/False answers** (mix true AND false — a lone true fact belongs as an MC
  "which of these has she actually done?", never a hyper-specific "true or false" that's an obvious yes).
  Writing to the bar the first time avoids a regenerate.
- **jerseyNumber:** use the number in the player's block. If a player's line has no `#N` (ESPN lacked
  it), do ONE quick lookup of her current squad number — don't turn it into a research detour, and never
  block the whole run on it.

Build the JSON document incrementally as above until `/tmp/knowher-pool.json` holds ONLY the finished pool
(nothing around it). Keep the per-player source list separately for your final report (it must NOT be inside
the JSON).

### 2b. Inject the stat questions (code-generated — do NOT skip)

```bash
node scripts/inject_stat_questions.mjs /tmp/knowher-pool.json /tmp/knowher-stats.json
```

This appends 2 `herGame` questions per player, built in code from the same verified numbers step 1 put in
the prompt (`/tmp/knowher-stats.json` is written by the assembler in step 1 — it must be the SAME session).
It prints a per-player `N Qs (H human + 2 stat)` line.
- Exit 0 → proceed to step 3.
- **Exit non-zero → STOP and report FAILURE.** It fails loud when a player's `espnAthleteId` isn't in the
  sidecar (the pool was invented or generated against a different week) or a question id collides. **Never
  publish the human-only pool** — it is incomplete by design and would ship 8-question quizzes.

### 3. Validate (server rules, no write)

```bash
node scripts/load_knowher.mjs /tmp/knowher-pool.json --dry-run
```

Run this on the MERGED pool (after step 2b), not the human-only one. The validator checks BOTH JSON shape
AND content quality (≥10 questions/player, ≥6 human / ≤5 stat, and a balanced mix of True/False answers — it
fails a pool that's ~80% "True", the banned obvious-true pattern).
`⚠️` lines are non-fatal warnings; `✗` lines fail.
- Pass → proceed.
- Fail → fix ONLY mechanical JSON-shape issues (e.g. a missing field name, an options-count slip) if the
  fix is unambiguous. For a **content-quality** `✗` (too few questions, too many "True" T/F), regenerate the
  offending player(s) per step 2 ONCE — add HUMAN questions and vary the True/False answers; do NOT pad with
  junk. ⚠️ Add them straight into the merged pool and re-run step 3 only — **do not re-run step 2b**, whose
  duplicate-id guard will (correctly) reject an already-merged pool. If validation still fails → **STOP**,
  publish nothing, report FAILURE with the validator's exact error. The previous edition's content stays
  live automatically — a missed week is safe; a malformed publish is not.

### 4. Publish

```bash
curl -sS -X POST "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher/ingest" \
  -H "x-ingest-key: $INGEST_KEY" -H "Content-Type: application/json" \
  --data @/tmp/knowher-pool.json
```

Expect `{"ok":true,"weekKey":"<this week>","playerCount":N,...}`. Any other response → retry ONCE; still
failing → **STOP** and report FAILURE with the HTTP status/body (do not echo the key).

### 5. Verify live

Verify against a **teams-scoped** query, NOT the empty `?teams=` one — that empty-teams response has its
own edge-cache entry that commonly still serves LAST week for up to ~5 min after a successful publish (a
known lag, NOT a failure). Pick two teams you just published and use a fresh cache key:

```bash
curl -sS "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher?teams=WAS,LA" | head -c 200
```

Confirm the served `weekKey` matches this week's. If the ingest POST in step 4 returned `{"ok":true,…}`,
**the publish already succeeded** — a stale `weekKey` here is just the edge cache catching up, so do NOT
report a failure over it. Note it in your report if you like, but the step-4 `ok:true` is the source of
truth. (Don't burn time re-polling; one teams-scoped check is enough.)

### 6. Report

Final message, exactly one of:
- **SUCCESS** — `Know Her Game <weekKey>: published <N> players (<gaps, if any: "gap: BAY, …">).`
  Then the per-player source list from step 2 (for spot-checking).
- **FAILURE** — `Know Her Game <weekKey>: NOT published — <step> failed: <exact error>.` Plus what (if
  anything) the app is serving instead (last week's pool stays live).

## Hard rules

- Never publish a pool that failed `--dry-run` validation.
- Never publish a pool that hasn't been through step 2b — the human-only pool is incomplete by design.
- Never alter the assembled prompt's wording.
- Never put the source list, commentary, or markdown fences inside `/tmp/knowher-pool.json`.
- Never print or persist `INGEST_KEY`.
- One retry per failed step, then stop loud. A quiet skipped week beats a bad publish.
