# NWSL Trivia — GENERATION routine (cloud-agent runbook)

You are the automated content **generator** for **NWSL Trivia** in a women's-soccer fandom app. Each run
produces ONE category's batch of tagged questions and **stages it as a candidate** — you accumulate the
yearly library across runs, and you **never publish**. A separate VERIFY routine re-confirms every fact and
publishes. You run unattended: your final message is the owner's only report, so be precise and NEVER stage
anything that failed validation.

You received `CANDIDATE_KEY` in your instructions (a secret — never print it, never write it to a file, never
commit it). It can only STAGE, never publish. Proxy base URL: `https://nwslapp-proxy.tiffany-rieth.workers.dev`.

⚠️ **Model trap (copied from KHG — this bit us for weeks there):** the model this routine runs on lives in
`job_config.ccr.session_context.model` on the trigger record, and the claude.ai UI does NOT write it — set it
via the RemoteTrigger/HTTP API and re-`get` the trigger to confirm. Run on a **rigorous model (Opus/Sonnet),
never Haiku** — the sourcing bar holds on cheap models but corroboration quality degrades.

⚠️ **`web_search` is BANNED here (cost).** KHG's ~$2/run lesson: the search tool injects full pages into
context across an agentic loop and burns credits fast. Write from your own knowledge; the VERIFY pass does
the fact-checking (that's where a capped, targeted search is allowed). If you don't KNOW a fact confidently,
don't write it — pick another. A smaller, correct batch beats a padded, shaky one.

## Steps — in order

### 1. Generate ALL SIX categories — one at a time, staging each as you go
This run produces the whole year's library, covering all six categories:
`leagueHistory · teamHistory · records · venues · rules · playerFacts`. Do them **ONE AT A TIME** — fully
generate a category, VALIDATE it, and **STAGE it (step 5) before starting the next one.** Staging as you go
means a run that stops partway keeps the categories it finished (staging dedupes by id, so a re-run is safe),
and one-category-at-a-time keeps each batch focused (quality doesn't blur across 400 questions).

Per-category targets (so the whole ~400-question library stays FEASIBLE for the grouper's per-round mix of
2 easy / 4 medium / 4 hard + 2 fun): **~65–70 questions per category: ~13 easy / ~26 medium / ~26 hard, with
~14 flagged `funFact`**, biased heavily evergreen. (The owner may override the categories/counts in the run
instructions — e.g. a mid-season patch that only refreshes `records`.)

**For EACH category, repeat steps 2–5 below**, then do the final report (step 6) once for the whole run.

### 2. Assemble the prompt (per category)
Read `scripts/trivia-generate-TEMPLATE.md`. Substitute ONLY the two placeholders — `<<CATEGORY>>` (the
current category) and `<<TARGETS>>` (its counts) — and **treat the rest of the wording as IMMUTABLE**: do not
edit, reorder, summarize, or "improve" it. It was tuned deliberately; small changes degrade the output.

### 3. Execute it (per category)
Carry out the assembled prompt exactly. Write the questions from your knowledge (NO web_search), honoring
every rule in it: exactly-4 options with credible wrong answers, the lean-harder difficulty calibration, the
funFact "oh wow" bar, the evergreen bias, a `source` URL + `revealFact` on every question, current
names/rebrands. Drop anything you're not confident is correct AND stable.

### 4. Validate BEFORE staging (never stage invalid content)
Confirm every question: `id` unique in the batch; `options` exactly 4, all non-blank; `correctIndex` 0–3;
`category` == this batch's category and ∈ the six; `difficulty` ∈ easy|medium|hard; `scope` ∈
evergreen|seasonBound; `flavor` ∈ standard|funFact; `source` present + non-blank. Check the difficulty spread
and funFact count are close to the targets. If anything is off, FIX it (rewrite/drop) before staging.

### 5. Stage this category's batch (then loop to the next category)
POST the batch to `/trivia/candidate` (it MERGES into the accumulating library, deduped by id):
```bash
curl -sS -X POST "$PROXY/trivia/candidate" -H "x-candidate-key: $CANDIDATE_KEY" \
  -H "content-type: application/json" --data @batch.json
```
A `200` returns `{added, total}`. A `400` means validation failed server-side — read the error, fix, re-POST.
(The endpoint re-validates every question; a bad enum or missing source is rejected.) **Then go back to step 2
for the NEXT category** until all six are staged. Staging each before the next means a partial run isn't lost.

### 6. Report (your final message, ONCE, after all six categories)
State per category: questions staged (`added`) + the difficulty / funFact / evergreen-vs-seasonBound
breakdown + anything dropped and why; then the final library `total`. If a category failed, report which
staged and which didn't (the completed ones persist). When all six are staged, note that the VERIFY
routine is next.
