import { describe, it, expect } from "vitest";
import {
	roleLabelToGroup,
	gateTeamIdentity,
	gateShape,
	gateContinuity,
	diffPlayers,
	overlapRatio,
	sdpNameIndex,
	assembleReport,
	activeOverrides,
	applyOverrides,
	overrideExpiry,
	OVERRIDE_TTL_DAYS,
	type EspnTeamRoster,
	type SdpSquad,
	type OverrideMap,
} from "../src/roster-truth";

// Every fixture below is a REAL specimen observed on 2026-07-30 (docs/roster-source-research.md
// §10). The point of pinning them is that each one encodes a rule that cost something to learn:
// Bethi/Ngock were briefly recorded as ESPN fabrications, and a cross-check built on that reading
// would delete new signings.

const ABBRS = ["LA", "BAY", "BOS", "CHI", "DEN", "GFC", "HOU", "KC", "NC", "ORL", "POR", "LOU", "SD", "SEA", "UTA", "WAS"];

const norm = (s: string) =>
	s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

function espn(abbr: string, players: { id: string; name: string; jersey?: number | null; pos?: string }[]): EspnTeamRoster {
	return {
		teamAbbr: abbr,
		espnTeamId: "1",
		players: players.map((p) => ({
			id: p.id,
			display: p.name,
			name: norm(p.name),
			jersey: p.jersey === undefined ? 1 : p.jersey,
			group: (p.pos ?? "M") as never,
			rawPosition: p.pos ?? "M",
		})),
	};
}

function sdp(abbr: string, players: { name: string; short?: string; jersey?: string | null; role?: string; minutes?: number }[]): SdpSquad {
	return {
		teamAbbr: abbr,
		teamGuid: "g",
		teamName: abbr,
		players: players.map((p, i) => ({
			guid: `guid-${i}`,
			name: norm(p.name),
			short: norm(p.short ?? ""),
			shirt: "",
			display: p.name,
			jersey: p.jersey === undefined ? "1" : p.jersey,
			role: (p.role ?? "M") as never,
			minutes: p.minutes ?? 0,
			games: 0,
		})),
	};
}

/** A well-formed 20-player squad: 3 keepers, unique numbers. */
const healthy = (abbr = "WAS") =>
	espn(
		abbr,
		Array.from({ length: 20 }, (_, i) => ({
			id: `a${i}`,
			name: `Player ${String.fromCharCode(65 + i)}`,
			jersey: i + 1,
			pos: i < 3 ? "G" : i < 9 ? "D" : i < 15 ? "M" : "F",
		})),
	);

describe("roleLabelToGroup", () => {
	it("maps the four NWSL role labels", () => {
		expect(roleLabelToGroup("Goalkeeper")).toBe("G");
		expect(roleLabelToGroup("Defender")).toBe("D");
		expect(roleLabelToGroup("Midfielder")).toBe("M");
		expect(roleLabelToGroup("Forward")).toBe("F");
	});
	it("never guesses on an unknown or empty label", () => {
		expect(roleLabelToGroup("Sweeper Keeper Coach")).toBe("G"); // contains "keeper"
		expect(roleLabelToGroup("Utility")).toBeNull();
		expect(roleLabelToGroup(undefined)).toBeNull();
		expect(roleLabelToGroup("")).toBeNull();
	});
});

describe("gateTeamIdentity (Gate A)", () => {
	it("passes when both feeds agree on the 16 clubs", () => {
		expect(gateTeamIdentity(ABBRS, ABBRS).ok).toBe(true);
	});
	it("FAILS when ESPN drops a club — the Orlando deletion replay", () => {
		const r = gateTeamIdentity(ABBRS.filter((a) => a !== "ORL"), ABBRS);
		expect(r.ok).toBe(false);
		expect(r.failures.join(" ")).toContain("ORL");
	});
	it("FAILS on a club ESPN invented (the rename-to-another-club case)", () => {
		const r = gateTeamIdentity([...ABBRS, "XYZ"], ABBRS);
		expect(r.ok).toBe(false);
		expect(r.failures.join(" ")).toContain("XYZ");
	});
	it("refuses to judge when SDP returns nothing (fail loud, never silently pass)", () => {
		expect(gateTeamIdentity(ABBRS, []).ok).toBe(false);
	});
});

describe("gateShape (Gate B)", () => {
	it("passes a normal squad", () => {
		expect(gateShape(healthy()).ok).toBe(true);
	});

	it("FAILS the live Portland collapse — 1 athlete, 0 keepers", () => {
		const por = espn("POR", [{ id: "d", name: "Daiane", jersey: 34, pos: "D" }]);
		const r = gateShape(por);
		expect(r.ok).toBe(false);
		expect(r.failures.join(" ")).toMatch(/squad size 1/);
		expect(r.failures.join(" ")).toMatch(/0 goalkeepers/);
	});

	it("FAILS the Spirit's five-goalkeeper incident but ALLOWS four", () => {
		const mk = (gk: number) =>
			espn("WAS", Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, name: `P ${i}`, jersey: i + 1, pos: i < gk ? "G" : "D" })));
		// WAS legitimately carried 4 keepers on 2026-07-30 — the threshold must not flag reality.
		expect(gateShape(mk(4)).ok).toBe(true);
		expect(gateShape(mk(5)).ok).toBe(false);
		expect(gateShape(mk(0)).ok).toBe(false);
	});

	it("FAILS on duplicate shirt numbers, ignoring players with none", () => {
		const dup = espn("KC", [
			...Array.from({ length: 18 }, (_, i) => ({ id: `a${i}`, name: `P ${i}`, jersey: i + 10, pos: i < 3 ? "G" : "D" })),
			{ id: "ball", name: "Elizabeth Ball", jersey: 7, pos: "D" },
			{ id: "bethune", name: "Croix Bethune", jersey: 7, pos: "M" },
			{ id: "gagne", name: "Clare Gagne", jersey: null, pos: "D" },
		]);
		const r = gateShape(dup);
		expect(r.ok).toBe(false);
		expect(r.failures.join(" ")).toContain("duplicate jersey(s): 7");
	});
});

describe("overlapRatio + the shortName index", () => {
	it("matches mononyms the full-name join misses (Debinha, Lorena, Ary Borges)", () => {
		const squad = sdp("KC", [
			{ name: "Débora Cristiane de Oliveira", short: "Debinha" },
			{ name: "Lorena da Silva Leite", short: "Lorena" },
			{ name: "Ariadina Alves Borges", short: "Ary Borges" },
		]);
		const idx = sdpNameIndex(squad);
		const names = ["Debinha", "Lorena", "Ary Borges"].map(norm);
		expect(overlapRatio(names, idx)).toBe(1);
		// Without the shortName index these would all miss — the measured 89-92% vs 96.3% gap.
		const fullOnly = new Set(squad.players.map((p) => p.name));
		expect(overlapRatio(names, fullOnly)).toBe(0);
	});
	it("is 0 for an empty name list rather than dividing by zero", () => {
		expect(overlapRatio([], new Set(["x"]))).toBe(0);
	});
});

describe("gateContinuity (Gate C)", () => {
	const roster = healthy();
	const matching = sdp("WAS", roster.players.map((p) => ({ name: p.display })));

	it("passes when the squads are the same people", () => {
		const r = gateContinuity(roster, matching, null);
		expect(r.ok).toBe(true);
		expect(r.sdpOverlap).toBe(1);
	});

	it("FAILS wholesale contamination — a plausible squad of entirely different humans", () => {
		// This is the case no size or shape check can see: 20 players, 3 keepers, unique numbers.
		const contaminated = espn(
			"GFC",
			Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, name: `Other Person ${i}`, jersey: i + 1, pos: i < 3 ? "G" : "D" })),
		);
		expect(gateShape(contaminated).ok).toBe(true); // shape says fine…
		const r = gateContinuity(contaminated, matching, null); // …continuity does not
		expect(r.ok).toBe(false);
		expect(r.sdpOverlap).toBe(0);
	});

	it("does not fail a club merely because the league feed lags a few signings", () => {
		// Two ESPN-only players out of 20 = 90% overlap, comfortably above the 80% floor.
		const withSignings = espn("WAS", [
			...roster.players.slice(0, 18).map((p) => ({ id: p.id, name: p.display, jersey: p.jersey, pos: p.group as string })),
			{ id: "ngock", name: "Monique Ngock", jersey: 8, pos: "M" },
			{ id: "bethi", name: "Melissa Bethi", jersey: null, pos: "M" },
		]);
		expect(gateContinuity(withSignings, matching, null).ok).toBe(true);
	});

	it("treats a first run (no prior names) as passing, not failing", () => {
		const r = gateContinuity(roster, matching, null);
		expect(r.priorOverlap).toBeNull();
		expect(r.ok).toBe(true);
	});

	it("FAILS when last night's squad has mostly vanished", () => {
		const prior = Array.from({ length: 20 }, (_, i) => norm(`Gone Person ${i}`));
		const r = gateContinuity(roster, matching, prior);
		expect(r.ok).toBe(false);
		expect(r.priorOverlap).toBe(0);
	});

	it("cannot fail on the SDP axis when the league feed is unavailable (fails open)", () => {
		const r = gateContinuity(roster, null, null);
		expect(r.ok).toBe(true);
		expect(r.sdpOverlap).toBe(1);
	});
});

describe("diffPlayers (Gate D)", () => {
	it("flags the Rodman position mismatch without picking a winner", () => {
		const e = espn("WAS", [{ id: "rodman", name: "Trinity Rodman", jersey: 2, pos: "M" }]);
		const s = sdp("WAS", [{ name: "Trinity Rodman", role: "F", minutes: 900 }]);
		const d = diffPlayers(e, s);
		expect(d.positionMismatches).toHaveLength(1);
		expect(d.positionMismatches[0]).toMatchObject({ name: "Trinity Rodman", espn: "M", sdp: "F" });
		// No "correct" field anywhere — adjudication is the owner's, via an override.
		expect(Object.keys(d.positionMismatches[0])).not.toContain("correct");
	});

	it("flags Sentnor's missing shirt number", () => {
		const e = espn("LA", [{ id: "sentnor", name: "Ally Sentnor", jersey: null, pos: "F" }]);
		const s = sdp("LA", [{ name: "Ally Sentnor", jersey: "21", role: "F" }]);
		const d = diffPlayers(e, s);
		expect(d.missingJerseys).toEqual([{ espnAthleteId: "sentnor", name: "Ally Sentnor", sdpJersey: "21" }]);
	});

	it("reports Ngock/Bethi as ESPN-only WITHOUT proposing removal — they are real signings", () => {
		const e = espn("WAS", [
			{ id: "rodman", name: "Trinity Rodman", jersey: 2, pos: "F" },
			{ id: "ngock", name: "Monique Ngock", jersey: 8, pos: "M" },
			{ id: "bethi", name: "Melissa Bethi", jersey: null, pos: "M" },
		]);
		const s = sdp("WAS", [{ name: "Trinity Rodman", role: "F" }]);
		const d = diffPlayers(e, s);
		expect(d.espnOnly.map((p) => p.name).sort()).toEqual(["Melissa Bethi", "Monique Ngock"]);
		// Bethi has no number because she has not reported yet — that is NOT a fillable gap.
		expect(d.missingJerseys).toHaveLength(0);
	});

	it("flags Fuller/Heaps-class erasures, but not zero-minute departures", () => {
		const e = espn("BAY", [{ id: "keep", name: "Someone Else", pos: "M" }]);
		const s = sdp("BAY", [
			{ name: "Someone Else", role: "M" },
			{ name: "Kennedy Fuller", jersey: "47", role: "M", minutes: 1119 }, // erased by ESPN
			{ name: "Jordan Brewster", jersey: "2", role: "D", minutes: 0 }, // never played — noise
		]);
		const d = diffPlayers(e, s);
		expect(d.sdpOnlyWithMinutes).toEqual([{ name: "Kennedy Fuller", jersey: "47", minutes: 1119 }]);
	});

	it("does NOT flag SDP's duplicate #7 as a jersey problem (its numbers are never authoritative)", () => {
		const e = espn("KC", [
			{ id: "ball", name: "Elizabeth Ball", jersey: 7, pos: "D" },
			{ id: "bethune", name: "Croix Bethune", jersey: 8, pos: "M" },
		]);
		const s = sdp("KC", [
			{ name: "Elizabeth Ball", jersey: "7", role: "D" },
			{ name: "Croix Bethune", jersey: "7", role: "M" }, // stale: really wears 8 at KC
		]);
		const d = diffPlayers(e, s);
		expect(d.missingJerseys).toHaveLength(0); // ESPN has both numbers; nothing to fill
		expect(d.positionMismatches).toHaveLength(0);
	});

	it("matches via shortName so a mononym is not reported as a difference", () => {
		const e = espn("KC", [{ id: "deb", name: "Debinha", jersey: 99, pos: "M" }]);
		const s = sdp("KC", [{ name: "Débora Cristiane de Oliveira", short: "Debinha", jersey: "99", role: "M" }]);
		const d = diffPlayers(e, s);
		expect(d.espnOnly).toHaveLength(0);
		expect(d.sdpOnlyWithMinutes).toHaveLength(0);
	});

	it("makes no claim when a name is ambiguous across two league records", () => {
		const e = espn("NC", [{ id: "x", name: "Same Name", pos: "M" }]);
		const s = sdp("NC", [
			{ name: "Same Name", role: "F", minutes: 500 },
			{ name: "Same Name", role: "D", minutes: 500 },
		]);
		const d = diffPlayers(e, s);
		expect(d.positionMismatches).toHaveLength(0);
		expect(d.espnOnly).toHaveLength(0);
	});

	it("returns empty diffs when the league feed is unavailable", () => {
		const d = diffPlayers(healthy(), null);
		expect(d).toEqual({ positionMismatches: [], missingJerseys: [], espnOnly: [], sdpOnlyWithMinutes: [] });
	});
});

describe("assembleReport", () => {
	it("counts gate failures and per-player findings across clubs", () => {
		const club = (abbr: string, posMismatches: number, failB: boolean) => ({
			abbr,
			espnCount: 20,
			sdpCount: 20,
			verified: true,
			gateB: failB ? { ok: false, failures: ["squad size 1"] } : { ok: true, failures: [] },
			gateC: { ok: true, failures: [], sdpOverlap: 1, priorOverlap: null },
			diffs: {
				positionMismatches: Array.from({ length: posMismatches }, () => ({
					espnAthleteId: "x", name: "P", espn: "M" as const, sdp: "F" as const, minutes: 100,
				})),
				missingJerseys: [],
				espnOnly: [],
				sdpOnlyWithMinutes: [],
			},
		});
		const r = assembleReport({
			ranAt: "2026-07-31T08:00:00.000Z",
			seasonId: "s",
			gateA: { ok: true, failures: [] },
			clubs: [club("POR", 0, true), club("WAS", 2, false)],
			espnNames: { WAS: ["a"] },
		});
		expect(r.summary.clubsVerified).toBe(2);
		expect(r.summary.gateFailures).toBe(1);
		expect(r.summary.positionMismatches).toBe(2);
		expect(r.espnNames).toEqual({ WAS: ["a"] });
	});
});

describe("overrides", () => {
	const NOW = Date.parse("2026-07-31T00:00:00.000Z");
	const pin = (over: Partial<OverrideMap[string]> = {}): OverrideMap => ({
		rodman: {
			espnAthleteId: "rodman",
			playerName: "Trinity Rodman",
			teamAbbr: "WAS",
			position: "F",
			setAt: new Date(NOW).toISOString(),
			expiresAt: overrideExpiry(NOW),
			...over,
		},
	});

	it("defaults to a 90-day life", () => {
		const days = (Date.parse(overrideExpiry(NOW)) - NOW) / 86400000;
		expect(days).toBe(OVERRIDE_TTL_DAYS);
		expect(days).toBe(90);
	});

	it("stops applying once expired — a stale ruling must not outlive its evidence", () => {
		const live = pin();
		expect(Object.keys(activeOverrides(live, NOW))).toEqual(["rodman"]);
		const later = NOW + 91 * 86400000;
		expect(activeOverrides(live, later)).toEqual({});
	});

	it("keeps the expired entry in the stored map so it stays renewable in the portal", () => {
		const all = pin({ expiresAt: new Date(NOW - 1000).toISOString() });
		expect(activeOverrides(all, NOW)).toEqual({});
		expect(all.rodman).toBeDefined(); // still on record, just not in force
	});

	it("rewrites position on the served payload and marks it", () => {
		const body = { athletes: [{ id: "rodman", displayName: "Trinity Rodman", position: { abbreviation: "M", displayName: "Midfielder" } }] };
		const { body: out, applied } = applyOverrides(body, pin(), NOW);
		const a = (out as { athletes: Record<string, unknown>[] }).athletes[0];
		expect((a.position as Record<string, string>).abbreviation).toBe("F");
		expect((a.position as Record<string, string>).displayName).toBe("Forward");
		expect(a.proxyOverridden).toBe(true);
		expect(applied).toEqual(["rodman"]);
	});

	it("fills a jersey without touching position", () => {
		const body = { athletes: [{ id: "sentnor", displayName: "Ally Sentnor", position: { abbreviation: "F" } }] };
		const ov: OverrideMap = {
			sentnor: { espnAthleteId: "sentnor", playerName: "Ally Sentnor", teamAbbr: "LA", jersey: 21, setAt: "", expiresAt: overrideExpiry(NOW) },
		};
		const a = (applyOverrides(body, ov, NOW).body as { athletes: Record<string, unknown>[] }).athletes[0];
		expect(a.jersey).toBe("21");
		expect((a.position as Record<string, string>).abbreviation).toBe("F");
	});

	it("leaves the payload untouched when nothing is in force", () => {
		const body = { athletes: [{ id: "other", displayName: "Someone" }] };
		expect(applyOverrides(body, {}, NOW).body).toBe(body);
		expect(applyOverrides(body, pin({ expiresAt: new Date(NOW - 1).toISOString() }), NOW).applied).toEqual([]);
	});

	it("can never add or remove a player — only correct one ESPN already lists", () => {
		const body = { athletes: [{ id: "a", displayName: "A" }, { id: "b", displayName: "B" }] };
		const ghost: OverrideMap = {
			nobody: { espnAthleteId: "nobody", playerName: "Ghost", teamAbbr: "WAS", position: "F", setAt: "", expiresAt: overrideExpiry(NOW) },
		};
		const out = applyOverrides(body, ghost, NOW);
		expect((out.body as { athletes: unknown[] }).athletes).toHaveLength(2);
		expect(out.applied).toEqual([]);
	});

	it("survives a malformed body without throwing", () => {
		expect(applyOverrides(null, pin(), NOW).body).toBeNull();
		expect(applyOverrides({ athletes: "nope" }, pin(), NOW).applied).toEqual([]);
	});
});
