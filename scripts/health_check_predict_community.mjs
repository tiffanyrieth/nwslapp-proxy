#!/usr/bin/env node
// Predict community health check — NO SILENT FAILURES gate for the DEADLINE.
//
// /predict/community is the read gate for Predict the XI's community pick percentages. The rule it
// enforces (app handoff §2a.6) is load-bearing: if those percentages were readable while fans are
// still picking, they'd copy the consensus and the distribution would flatten — destroying the data
// the share bars, consensus XI, standout picks and contrarian panel all depend on.
//
// Postgres can't enforce that (it has no idea when kickoff is), so the gate lives in the worker,
// which reads kickoff from its own cached /summary. That makes this check the only thing standing
// between a refactor and a silent leak — a leak that would look perfectly healthy in the app.
//
// The four properties gated here:
//   1. A match still BEFORE its close (kickoff − 2h) returns revealed:false AND carries no `picks`
//      key at all — not an empty array, not zeros. This is the leak test.
//   2. A FINISHED match returns revealed:true (an empty picks array is fine — that's zero
//      submissions, an honest answer).
//   3. An UNKNOWN event id FAILS CLOSED (revealed:false), never open and never 5xx.
//   4. Malformed params are rejected 400 rather than silently coerced.
//
// Usage:
//   node scripts/health_check_predict_community.mjs                       # against production
//   node scripts/health_check_predict_community.mjs http://localhost:8787 # against wrangler dev

const BASE = (process.argv[2] || process.env.PROXY_BASE || "https://nwslapp-proxy.tiffany-rieth.workers.dev").replace(/\/$/, "");
// ⚠️ A DATE RANGE, not the default window. The default scoreboard usually holds only upcoming
// fixtures, so the post-close REVEAL assertion — the half that proves the gate opens, not just that
// it shuts — would silently WARN-and-skip on most days. A check whose main positive assertion rarely
// runs isn't a gate. Look back two weeks so a finished match is essentially always in scope.
const today = new Date();
const back = new Date(today.getTime() - 14 * 24 * 3600 * 1000);
const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const ESPN_SCOREBOARD =
	`https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard?limit=500&dates=${fmt(back)}-${fmt(today)}`;
const CLOSE_LEAD_MS = 2 * 3600 * 1000;

async function scoreboardEvents() {
	const r = await fetch(ESPN_SCOREBOARD, { headers: { Accept: "application/json" } });
	if (!r.ok) throw new Error(`scoreboard HTTP ${r.status}`);
	const json = await r.json();
	return (Array.isArray(json?.events) ? json.events : [])
		.map((e) => ({
			id: e?.id,
			state: e?.status?.type?.state,
			kickoff: Date.parse(e?.date ?? ""),
			team: e?.competitions?.[0]?.competitors?.[0]?.team?.abbreviation,
			label: (e?.competitions?.[0]?.competitors ?? []).map((c) => c?.team?.abbreviation ?? "?").join("–"),
		}))
		.filter((e) => e.id && e.team && !Number.isNaN(e.kickoff));
}

async function ask(fixtures, season = "2026") {
	const qs = fixtures.map((f) => `f=${encodeURIComponent(f)}`).join("&");
	const r = await fetch(`${BASE}/predict/community?season=${season}&${qs}`);
	return { status: r.status, body: r.ok ? await r.json() : null };
}

const results = [];
const record = (verdict, name, note) => results.push({ verdict, name, note });

let events;
try {
	events = await scoreboardEvents();
} catch (e) {
	console.error(`\nPredict community health check — ❌ could not resolve scoreboard: ${e.message}\n`);
	process.exit(1);
}

console.log(`\nPredict community health check — ${BASE}\n`);

// ── 1. The leak test: a fixture whose close is still in the future must stay sealed ──────────
const sealed = events.find((e) => e.kickoff - CLOSE_LEAD_MS > Date.now());
if (!sealed) {
	record("WARN", "pre-close seal", "no upcoming fixture on the scoreboard — leak test not exercised");
} else {
	const { status, body } = await ask([`${sealed.id}:${sealed.team}:1`]);
	const f = body?.fixtures?.[0];
	if (status !== 200 || !f) {
		record("FAIL", "pre-close seal", `HTTP ${status} / no fixture in payload`);
	} else if (f.revealed !== false) {
		record("FAIL", "pre-close seal", `${sealed.label} revealed BEFORE its close — percentages are leaking`);
	} else if (f.picks !== undefined) {
		record("FAIL", "pre-close seal", `${sealed.label} sealed but still shipped a picks array`);
	} else {
		record("OK", "pre-close seal", `${sealed.label} sealed, closesAt ${f.closesAt ?? "?"}`);
	}
}

// ── 2. A finished fixture must reveal ────────────────────────────────────────────────────────
const finished = events.filter((e) => e.state === "post").sort((a, b) => b.kickoff - a.kickoff)[0];
if (!finished) {
	record("WARN", "post-close reveal", "NO finished fixture in a 14-day window — the reveal half of the gate went UNTESTED");
} else {
	const { status, body } = await ask([`${finished.id}:${finished.team}:1`]);
	const f = body?.fixtures?.[0];
	if (status !== 200 || !f) {
		record("FAIL", "post-close reveal", `HTTP ${status} / no fixture in payload`);
	} else if (f.revealed !== true) {
		record("FAIL", "post-close reveal", `${finished.label} still sealed after full time (kickoff lookup failing?)`);
	} else {
		record("OK", "post-close reveal", `${finished.label} revealed, ${f.submissions} submission(s)`);
	}
}

// ── 3. Fail-closed on an unresolvable event ──────────────────────────────────────────────────
{
	const { status, body } = await ask(["999999999:WAS:1"]);
	const f = body?.fixtures?.[0];
	if (status !== 200 || !f) {
		record("FAIL", "fail-closed", `unknown event returned HTTP ${status} instead of a sealed payload`);
	} else if (f.revealed !== false) {
		record("FAIL", "fail-closed", "unknown event revealed — the gate fails OPEN");
	} else {
		record("OK", "fail-closed", "unknown event sealed, as designed");
	}
}

// ── 4. Malformed params rejected ─────────────────────────────────────────────────────────────
for (const [name, qs] of [
	["bad season", "season=nope&f=1:WAS:1"],
	["bad fixture", "season=2026&f=abc"],
	["no fixture", "season=2026"],
]) {
	const r = await fetch(`${BASE}/predict/community?${qs}`);
	if (r.status === 400) record("OK", `reject ${name}`, "400");
	else record("FAIL", `reject ${name}`, `expected 400, got ${r.status}`);
}

const icon = { OK: "✅", WARN: "⚠️ ", FAIL: "❌" };
for (const r of results) console.log(`  ${icon[r.verdict]} ${r.name.padEnd(20)} ${r.note}`);

const failed = results.filter((r) => r.verdict === "FAIL");
console.log("");
if (failed.length > 0) {
	console.error(`❌ FAIL — ${failed.length} check(s) failed: ${failed.map((r) => r.name).join(", ")}`);
	console.error("   A revealed-too-early result means fans can read the consensus while picking.\n");
	process.exit(1);
}
console.log("✅ PASS — the community deadline gate holds and fails closed.\n");
