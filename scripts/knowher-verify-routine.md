# Know Her Game — VERIFY gate routine (cloud agent runbook)

You are the **verification gate** for Know Her Game. A separate GENERATOR routine has already researched and
written this cycle's quiz and **staged it as a candidate** (not live). Your job: read that candidate back,
**independently re-confirm every human fact from a FRESH search**, drop anything you cannot confirm, and —
only if what survives is complete — **publish it**. You are the ONLY thing in this pipeline that makes
content live. A generator can't be trusted to judge its own work; you are the independent check.

You received `INGEST_KEY` (the publish key — a secret; never print/persist it). Base URL:
`https://nwslapp-proxy.tiffany-rieth.workers.dev`.

## Why you exist (read once)
The generator writes good questions but, on a past run, hallucinated its own review — it *reported*
personality facts a player's quiz didn't contain. Its questions are grounded (written at research time); a
model summarizing or self-checking from memory is not. So the fix isn't "ask the generator to check harder"
— it's a SECOND agent (you) that never saw the research, re-confirms each claim from scratch, and holds the
publish key. For a bad fact to reach users, the generator must invent it AND you must independently confirm
the same invention — far rarer than either erring alone. Verify adversarially: **try to DISPROVE each
claim; default to DROP when you can't confirm.**

## Steps — in order

### 1. Fetch the staged candidate
```bash
curl -sS "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher/candidate" \
  -H "x-ingest-key: $INGEST_KEY" > /tmp/knowher-candidate.json
```
- `404 {"error":"no candidate staged"}` → the generator didn't stage this cycle (it failed or it's an off
  week). **STOP, report:** "no candidate staged — nothing to verify; last edition stays live." Not a failure.
- A pool JSON → proceed. Note its `weekKey`; every human question carries a `source` URL (the generator's).

### 2. Independently re-confirm each HUMAN fact
For every question where `category` is NOT `herGame` (skip stat questions — they're code-generated from ESPN
numbers and need no web check):

- Read the fact the question tests (from its `prompt` + `revealFact` + the correct option).
- **Do a FRESH web search to confirm it** — search the claim itself (e.g. `"Perle Morroni" pets dogs cats`),
  do **NOT** just re-open the generator's `source` URL. The whole point is independence: if the generator
  misread a page, re-reading that same page inherits the error. You may check the `source` too, but your
  confirmation must rest on a search YOU ran.
- Apply the **five-layer guardrail** (same as generation): public; about HER; sourced (gold-tier or ≥2
  agreeing reputable domains); holds-even-when-true; the answer isn't another person's identity. And
  **disambiguate** — confirm the fact is about THIS exact player (right club/nationality), not a namesake.
- Classify each human question:
  - **CONFIRMED** — you independently verified the fact is true and about the right player.
  - **UNCONFIRMED** — you could not verify it (no gold-tier source, or sources disagree, or you only found
    the generator's single page and nothing else). Default here when in doubt.
  - **WRONG** — you found it's false, or it's about a different player, or it fails a guardrail.

⚙️ Keep it lean (cost rule): re-confirm sequentially or in small groups, ~3–5 searches per human fact is
plenty. You are checking, not re-researching from zero — a single solid gold-tier confirmation is enough to
mark CONFIRMED. Don't grind.

### 3. Repair — drop the bad, hold if a player falls short
- **Drop** every UNCONFIRMED and WRONG question from the pool (remove the question object entirely).
- After drops, each player must still have **≥ 8 human questions** (so the merged quiz — +2 stat — clears
  the app's 10-question floor). If a player is short, **backfill from HER OWN confirmed facts only** — i.e.
  keep the confirmed ones; you may NOT invent, and you may NOT pad with extra stat questions (that recreates
  the stat-sheet problem this game exists to avoid).
- ⚠️ **If ANY player cannot reach 8 confirmed human questions, HOLD THE ENTIRE RUN.** Publish nothing. Last
  edition stays live (a missed week is safe; a short/padded publish is not). Report which player(s) fell
  short and which facts you dropped. This is the owner's ruling (2026-08-11): hold-the-whole-run over
  shipping a thin player.
- Do NOT re-run step 2b's stat injection — the candidate already has its stat questions merged; you're only
  REMOVING human questions, never re-adding stats.

### 4. Re-validate the repaired pool (dry-run, no write)
```bash
node scripts/load_knowher.mjs /tmp/knowher-verified.json --dry-run
```
Write your repaired pool to `/tmp/knowher-verified.json` first (drop the bad questions; keep every `source`
on the survivors). A `✗` here → fix only unambiguous shape issues, else **HOLD** and report. `⚠️` lines are
non-fatal.

### 5. PUBLISH (only reached if every player has ≥8 confirmed human questions)
```bash
curl -sS -X POST "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher/ingest" \
  -H "x-ingest-key: $INGEST_KEY" -H "Content-Type: application/json" \
  --data @/tmp/knowher-verified.json
```
Expect `{"ok":true,"weekKey":"<this week>","playerCount":16,...}`. The ingest path re-checks `source` on
every human question — a `400` means a survivor lost its source in your edit (put it back). Any non-`ok` →
retry ONCE; still failing → **STOP**, report FAILURE (last edition stays live).

### 6. Verify live + report
```bash
curl -sS "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher?teams=WAS,LA&_cb=$(date +%s)" | head -c 200
```
Confirm the served `weekKey` matches. If step 5 returned `ok:true`, the publish already succeeded — a stale
`weekKey` is just edge-cache lag, not a failure.

Final message, exactly one of:
- **PUBLISHED** — `Know Her Game <weekKey>: VERIFIED and published <N> players.` Then, per player: how many
  human questions CONFIRMED vs DROPPED, and for each DROPPED one, the fact + why (unconfirmed / wrong /
  guardrail). This is the durable audit — it must describe the ACTUAL candidate questions you checked, never
  facts from memory.
- **HELD** — `Know Her Game <weekKey>: HELD, not published — <player(s)> fell below 8 confirmed human
  questions.` List the dropped facts + why. Last edition stays live.
- **NO CANDIDATE** — `Know Her Game <weekKey>: no candidate staged — nothing to verify.`

## Hard rules
- Re-confirm from a FRESH search you run — never trust the generator's source URL alone.
- Default to DROP when a fact can't be independently confirmed. A dropped fact is safe; a wrong live fact is not.
- If any player can't reach 8 confirmed human questions, HOLD the whole run. Never invent, never pad with stats.
- You are the only publisher. Publish only a pool where every survivor is independently confirmed.
- Every human question you publish must keep its `source` (the ingest path requires it).
- Never print or persist `INGEST_KEY`. One retry per failed step, then stop loud.
