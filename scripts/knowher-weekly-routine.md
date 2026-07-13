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

- Exit 0 → proceed. Capture any `⚠️ GAP` lines from stderr for the final report (a gap team keeps last
  week's player in the app — report it, don't fix it).
- Exit 1 → **STOP** and report FAILURE (offseason or the proxy/ESPN is down; nothing to generate).
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

Save ONLY the JSON document (nothing around it) to `/tmp/knowher-pool.json`. Keep the per-player source
list separately for your final report (it must NOT be inside the JSON).

### 3. Validate (server rules, no write)

```bash
node scripts/load_knowher.mjs /tmp/knowher-pool.json --dry-run
```

- Pass → proceed.
- Fail → fix ONLY mechanical JSON-shape issues (e.g. a missing field name, an options-count slip) if the
  fix is unambiguous; otherwise regenerate the offending player(s) per step 2 ONCE. If validation still
  fails → **STOP**, publish nothing, report FAILURE with the validator's exact error. Last week's
  content stays live automatically — a missed week is safe; a malformed publish is not.

### 4. Publish

```bash
curl -sS -X POST "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher/ingest" \
  -H "x-ingest-key: $INGEST_KEY" -H "Content-Type: application/json" \
  --data @/tmp/knowher-pool.json
```

Expect `{"ok":true,"weekKey":"<this week>","playerCount":N,...}`. Any other response → retry ONCE; still
failing → **STOP** and report FAILURE with the HTTP status/body (do not echo the key).

### 5. Verify live

```bash
curl -sS "https://nwslapp-proxy.tiffany-rieth.workers.dev/knowher?teams=" | head -c 200
```

Confirm the served `weekKey` matches this week's and the player count matches what you published.
(The edge cache is ≤5 min; a just-published pool may take one refresh — check the `weekKey` in the KV-
backed response body, and if it still shows last week after 2 tries 60s apart, report it.)

### 6. Report

Final message, exactly one of:
- **SUCCESS** — `Know Her Game <weekKey>: published <N> players (<gaps, if any: "gap: BAY, …">).`
  Then the per-player source list from step 2 (for spot-checking).
- **FAILURE** — `Know Her Game <weekKey>: NOT published — <step> failed: <exact error>.` Plus what (if
  anything) the app is serving instead (last week's pool stays live).

## Hard rules

- Never publish a pool that failed `--dry-run` validation.
- Never alter the assembled prompt's wording.
- Never put the source list, commentary, or markdown fences inside `/tmp/knowher-pool.json`.
- Never print or persist `INGEST_KEY`.
- One retry per failed step, then stop loud. A quiet skipped week beats a bad publish.
