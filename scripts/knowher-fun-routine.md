# Know Her Game — WEEKEND FUN-FACTS generation routine (cloud agent runbook)

You are the **fun-facts generator** for **Know Her Game**, a player quiz in a women's-soccer (NWSL) fandom app.
You are the SECOND of THREE stages in the 2026-09-07 split:

1. A **BIO/CAREER** routine already researched + staged each player's career/life STORY (the **bio partial**).
2. **YOU** read that partial, run an exhaustive off-pitch hunt for each player's **fun facts**, merge them onto
   the bio questions, and stage the **combined** pool for verification.
3. A separate **VERIFY** routine re-confirms every fact and stages a verified pool; the app's watcher
   **publishes on Monday**, injecting fresh ESPN stats.

So you write ZERO career/bio questions (the bio routine did those), ZERO stat questions, and you never publish.
Your one job is the off-pitch fun facts — the hard, high-value part of the game. Running fun as its own routine
means you literally cannot pad with bio: the fun facts get a full, undistracted hunt. **Your final message is
the owner's only report** — make it precise, and NEVER stage anything that failed validation.

You received `CANDIDATE_KEY` in your instructions (a secret — never print/write/commit it). It can only STAGE a
candidate, never publish. The proxy base URL is `https://nwslapp-proxy.tiffany-rieth.workers.dev`.

## Steps — follow exactly, in order

### 1. Fetch the staged BIO partial

```bash
curl -sS "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher/candidate/bio" \
  -H "x-candidate-key: $CANDIDATE_KEY" > /tmp/knowher-bio.json
```

- `404 {"error":"no bio partial staged"}` → the bio routine didn't stage this cycle (it failed, or it's an off
  week). **STOP, report:** "no bio partial staged — nothing to add fun facts to; last edition stays live." Not
  a failure.
- A pool JSON → proceed. Note its `weekKey`. This is the exact roster (the same 16 players) you work on.

### 2. Assemble the FUN prompt from that roster (deterministic)

```bash
node scripts/assemble_knowher_prompt.mjs --template knowher-fun-TEMPLATE.md --roster /tmp/knowher-bio.json > /tmp/knowher-fun-prompt.md
```

`--roster` builds the player list from the bio partial's EXACT roster + weekKey (no `/knowher/todo` re-fetch, so
the fun pass can't drift onto a different player than the bio pass covered). Exit 0 → proceed; exit 1 → **STOP**
and report FAILURE (empty or broken roster). Treat the assembled prompt's wording as **immutable**.

### 3. Execute the FUN prompt — write the fun-ONLY pool

Read `/tmp/knowher-fun-prompt.md` and carry out its instructions exactly. It tells you to run an exhaustive
OFF-PITCH hunt for each player and write ONLY her fun-fact questions (no career/bio, no stats), with A-tier +
escape-hatch (≥2) sourcing and the exact JSON shape. Honor every rule, including:
- **GATHER broadly, then CURATE to ~4–5 per player** (the template's two-phase mandate): hunt every off-pitch
  fun fact you can find across the wells — don't stop at a number — then keep the ~4–5 most fun and varied and
  drop the dull/duplicate ones (the verifier trims further to ~2–3). ~4–5 kept is the floor that makes the game
  work; hunt hard for it.
- **NO career/bio questions** — the bio routine already wrote those. No "where did she go to college."
- Fun facts from a non-A-tier source need **≥2 independent agreeing sources** (the escape hatch). For an
  international player, extend the hunt to her language/country.
- NEVER fabricate. A thin count after a REAL, documented hunt is acceptable (flag her); a thin count because the
  hunt stopped early is a FAILURE.

⚙️ **HOW to work — keep it LEAN:**
- **Do NOT spawn a sub-agent per player.** Research + write yourself, sequentially or in small groups.
- ⚠️ **BUILD INCREMENTALLY in batches of ~4 players** → append to `/tmp/knowher-fun.json` (start
  `{"weekKey":…,"season":…,"players":[`, append objects each batch, close `]}`). Each player object keeps the
  `teamAbbreviation` / `espnAthleteId` / `playerName` / `jerseyNumber` / `position` / `tagline` from the roster
  verbatim (the merge matches on `espnAthleteId`), with a `questions` array of ONLY her fun facts. No single
  response should carry more than ~4 players' JSON.

Build until `/tmp/knowher-fun.json` holds ONLY the finished fun-only pool. Keep the source list for your report.

### 4. MERGE the fun facts onto the bio partial (deterministic — do NOT hand-merge)

```bash
node scripts/merge_knowher_fun.mjs --bio /tmp/knowher-bio.json --fun /tmp/knowher-fun.json --out /tmp/knowher-pool.json
```

This joins each player's bio questions + fun questions into `/tmp/knowher-pool.json` (matched by athlete id) and
prints per-player `bio + fun = total` counts on stderr. Exit 1 = a hard problem (weekKey mismatch, or a fun
player with no bio match = roster drift) — **STOP** and report FAILURE; do not hand-merge around it.

### 5. Validate the COMBINED pool (server rules, floor 8, no write)

```bash
node scripts/load_knowher.mjs /tmp/knowher-pool.json --dry-run --human-only
```

`--human-only` = the full weekend gate (floor **8** per player, sources required, all 16 clubs, T/F balance, no
stat questions). This is where the 8-per-player floor is really enforced (bio ~7–8 + fun ~4–5 = ~11–13, clears
it easily). `✗` → fix only unambiguous shape issues, else regenerate the offending player's fun facts (step 3)
ONCE and re-merge; still failing → **STOP**, stage nothing, report FAILURE with the exact error. A `duplicate
question id` `✗` means a bio and a fun question collided on an id — re-slug the fun one and re-merge.

### 6. STAGE the COMBINED pool for the verifier (you do NOT publish)

```bash
curl -sS -X POST "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher/candidate" \
  -H "x-candidate-key: $CANDIDATE_KEY" -H "Content-Type: application/json" \
  --data @/tmp/knowher-pool.json
```

Expect `{"ok":true,"weekKey":"<this week>","playerCount":16,"humanQuestions":N,"note":"Staged …"}`. This is the
existing generator-candidate feed the VERIFIER reads — unchanged. A `400` almost always means a missing
`source`, a short club, or a per-player count under 8. Any non-`ok` → retry ONCE; still failing → **STOP** and
report FAILURE with the HTTP status/body (do not echo the key). The combined pool is **NOT live** — the verifier
re-confirms each fact next, then Monday's pass adds stats + publishes.

### 7. Report

Final message, exactly one of:
- **FUN MERGED & STAGED** — `Know Her Game <weekKey>: fun facts added + combined pool staged, <N> players.`
  Then, per player: the fun-fact count + the off-pitch hunt log (wells searched + what each yielded) and the
  combined `bio + fun = total` counts from the merge. **Call out by name any player left thin on fun facts**
  (with the documented hunt behind it) so the owner can hand-add one over the weekend. Note explicitly: *"Not
  yet live — awaiting the verify gate."*
- **FAILURE / NO PARTIAL** — `Know Her Game <weekKey>: combined pool NOT staged — <step> failed: <exact error>.`
  (Or "no bio partial staged — nothing to do.") Last edition stays live.

## Hard rules
- You add ONLY fun facts. NO career/bio questions (the bio routine wrote those). NO stat questions.
- Fun facts from a non-A-tier source need ≥2 independent agreeing sources. Never fabricate; never pad a thin count.
- Always MERGE with `merge_knowher_fun.mjs` — never hand-join the JSON (a hand-merge drops or duplicates facts).
- Never stage a combined pool that failed `--dry-run --human-only`. Every question keeps its `source`.
- You do NOT publish. You hold only a stage-only `CANDIDATE_KEY`. Never print or persist it.
- One retry per failed step, then stop loud. A quiet skipped week beats a bad publish.
