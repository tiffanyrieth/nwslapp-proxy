# Know Her Game — WEEKEND generation routine (cloud agent runbook)

You are the automated content **generator** for **Know Her Game**, a player quiz in a women's-soccer
(NWSL) fandom app. Your job: assemble this week's generation prompt, execute it into a **HUMAN-ONLY**
pool, validate it, and **stage it as a candidate** for the verify gate. You run unattended — **your final
message is the owner's only report** — so make it precise, and NEVER stage anything that failed validation.

⚠️ **You are ONE of THREE stages (2026-08-12 weekend/Monday split):** (1) YOU generate + stage the human
questions on the **weekend**; (2) a separate **VERIFY** routine re-confirms each fact and stages a verified
pool; (3) the app's watcher **publishes on Monday**, injecting FRESH ESPN stats (so Sunday-night games
count) then going live for the Monday-10am nudge. So **you write ZERO stat questions and you never publish**
— stats and go-live are Monday's job. Generating over the weekend gives the owner time to catch any problem
before it reaches users Monday.

You received `CANDIDATE_KEY` in your instructions (it is a secret — never print it, never write it to a
file, never commit it). It can only STAGE a candidate, never publish. The proxy base URL is
`https://nwslapp-proxy.tiffany-rieth.workers.dev`.

## Steps — follow exactly, in order

### 1. Assemble the week's prompt (deterministic — do NOT write the prompt yourself)

```bash
node scripts/assemble_knowher_prompt.mjs > /tmp/knowher-prompt.md
```

⚠️ **Weekend targeting (2026-08-12 split):** you run on the WEEKEND, but the edition publishes the COMING
Monday — the ISO week AFTER your run. The assembler handles this: it stamps the weekKey + gates on the
**upcoming Monday** (`targetPublishMonday`), not today. So a Saturday run for the W35 edition correctly
stamps `2026-W35`, and on a Trivia-target weekend it no-ops. **Supervised-test override:** to force a
specific edition (e.g. the first-run test), prefix the command with `KHG_PUBLISH_MONDAY=YYYY-MM-DD` (a KHG-week
Monday), e.g. `KHG_PUBLISH_MONDAY=2026-08-24 node scripts/assemble_knowher_prompt.mjs > /tmp/knowher-prompt.md`.

Know Her Game runs **biweekly**, alternating the Fan Zone quiz slot with NWSL Trivia, so the assembler
self-gates on season-week parity (anchor = the committed `SEASON_ANCHOR` constant in
`assemble_knowher_prompt.mjs` — the Monday of regular-season Week 1, `2026-03-09`; the `KHG_SEASON_ANCHOR`
env var overrides it for tests. Bump the constant each new season). Handle the THREE outcomes:
- **Exit 0, prompt file NON-EMPTY** → a KHG week: proceed. It also writes `/tmp/knowher-stats.json` (the
  verified per-player numbers, `📊` line on stderr) — the prompt uses these as CONTEXT so you never look
  stats up; you no longer inject them (Monday's publish fetches fresh stats server-side), so the sidecar is
  now just context. Capture any `⚠️ GAP` lines from stderr for the final report (a gap team keeps last week's
  player in the app — report it, don't fix it).
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
  you've spent that, STOP hunting and fall back to more **career/identity** questions (previous clubs,
  college/youth club, position, caps, milestones) — solid, verifiable facts about who she is. Do NOT reach
  for a stretched fun fact, and do NOT write stat questions (Monday's code adds those). Don't grind endlessly.
- **HUMAN-ONLY — you write NO stat questions.** The prompt asks for **8–9 human questions per player** and
  nothing else; the 2 stat (`herGame`) questions are generated in code and injected **Monday, at publish**,
  from fresh ESPN numbers. Writing your own stat questions would duplicate them AND freeze stale numbers.
- **Hit the quality bar as you write (the validator enforces it — step 3):** **8–9 human questions per
  player** (8 is the floor — fewer and the pool is rejected), and **vary True/False answers** (mix true AND
  false — a lone true fact belongs as an MC
  "which of these has she actually done?", never a hyper-specific "true or false" that's an obvious yes).
  Writing to the bar the first time avoids a regenerate.
- **jerseyNumber:** use the number in the player's block. If a player's line has no `#N` (ESPN lacked
  it), do ONE quick lookup of her current squad number — don't turn it into a research detour, and never
  block the whole run on it.

Build the JSON document incrementally as above until `/tmp/knowher-pool.json` holds ONLY the finished pool
(nothing around it). Keep the per-player source list separately for your final report (it must NOT be inside
the JSON).

### 3. Validate the HUMAN-ONLY pool (server rules, no write)

```bash
node scripts/load_knowher.mjs /tmp/knowher-pool.json --dry-run --human-only
```

`--human-only` is the weekend mode: it validates the pool with a floor of **8 questions per player**, requires
a `source` on every question, all 16 clubs present, and a balanced mix of True/False answers (it fails a pool
that's ~80% "True", the banned obvious-true pattern) — and it FAILS if any stat (`herGame`) question is
present (stats are Monday's job, never yours).
`⚠️` lines are non-fatal warnings; `✗` lines fail.
- Pass → proceed.
- Fail → fix ONLY mechanical JSON-shape issues (e.g. a missing field name, an options-count slip) if the
  fix is unambiguous. For a **content-quality** `✗` (too few questions, too many "True" T/F, a stray stat
  question), regenerate the offending player(s) per step 2 ONCE — add HUMAN questions and vary the True/False
  answers; do NOT pad with junk. If validation still fails → **STOP**, stage nothing, report FAILURE with the
  validator's exact error. The previous edition's content stays live automatically — a missed week is safe.

### 4. STAGE the candidate (you do NOT publish — the verifier does)

⚠️ **You are the GENERATOR half of a two-routine pipeline (2026-08-11). You never make content live.** You
stage your pool as a *candidate*; a separate VERIFY routine then re-confirms every human fact from a fresh
search and publishes only what survives. This split exists because a generator can't be the judge of its own
work — a past run wrote good questions but then hallucinated its own review. Staging, not publishing, is the
fix. You hold a `CANDIDATE_KEY` (stage-only), NOT the publish key.

```bash
curl -sS -X POST "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher/candidate" \
  -H "x-candidate-key: $CANDIDATE_KEY" -H "Content-Type: application/json" \
  --data @/tmp/knowher-pool.json
```

Expect `{"ok":true,"weekKey":"<this week>","playerCount":16,"humanQuestions":N,"note":"Staged …"}`. The
endpoint validates shape + all-16-clubs + a per-fact `source` on every question — a `400` here almost always
means a question is missing its `source` URL (go add it) or the pool is short a club. Any non-`ok` response →
retry ONCE; still failing → **STOP** and report FAILURE with the HTTP status/body (do not echo the key). ⚠️ A
staged candidate is **NOT live** and does **NOT** advance the featured ledger — nothing has changed for users
yet. The VERIFY routine re-confirms each fact and stages a verified pool; the Monday publish adds stats + goes
live. You are done once staged.

### 5. Report (the generator does NOT verify live — there's nothing live yet)

Final message, exactly one of:
- **STAGED** — `Know Her Game <weekKey>: staged <N> players for verification (<gaps, if any>).` Then the
  per-player review section (built from the JSON per the OUTPUT rules — walk the questions, tag [P]/[C],
  count, sources, rejected facts). Note explicitly: *"Not yet live — awaiting the verify gate."*
- **FAILURE** — `Know Her Game <weekKey>: NOT staged — <step> failed: <exact error>.` Plus: last week's
  pool stays live (a missed week is safe).

## Hard rules

- Never stage a pool that failed `--dry-run --human-only` validation.
- The staged pool is **HUMAN-ONLY** — you write NO stat questions; Monday's publish injects fresh ones.
- Every question MUST carry a `source` URL — the stage endpoint rejects the pool otherwise.
- You do NOT publish. You have only a stage-only `CANDIDATE_KEY`. Staging is the end of your job.
- Never alter the assembled prompt's wording.
- Never put the source list, commentary, or markdown fences inside `/tmp/knowher-pool.json`.
- Never print or persist your key.
- One retry per failed step, then stop loud. A quiet skipped week beats a bad publish.
