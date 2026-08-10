// The attendance backstop (2026-08-11): pure pieces + a mocked end-to-end sweep→enrich run.
// fetchMock is used for the same reason as recovery-ladder.spec.ts — the sweep's job only
// exists against upstream states (ESPN missing a figure the league has) that live curl can't
// produce on demand.
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import worker, { chooseSummaryTTL } from "../src/index";
import {
	attendanceSweep,
	decodeAttendanceRecord,
	enrichSummaryAttendance,
	isSweepCandidate,
	joinSdpMatch,
	patchAttendance,
} from "../src/attendance";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ESPN = "https://site.api.espn.com";
const SDP = "https://api-sdp.nwslsoccer.com";

const settledSummary = (attendance: number) =>
	JSON.stringify({
		header: {
			competitions: [
				{ status: { type: { state: "post", name: "STATUS_FULL_TIME", completed: true } } },
			],
		},
		gameInfo: { venue: { fullName: "Audi Field" }, attendance },
	});

const toBuf = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const fromBuf = (b: ArrayBuffer): unknown => JSON.parse(new TextDecoder().decode(b));

describe("attendance pure pieces", () => {
	it("isSweepCandidate wants settled matches with no crowd figure", () => {
		const event = (state: string, completed: boolean | undefined, attendance: number) => ({
			id: "1",
			status: { type: { state, completed } },
			competitions: [{ attendance }],
		});
		expect(isSweepCandidate(event("post", true, 0))).toBe(true);
		expect(isSweepCandidate(event("post", undefined, 0))).toBe(true); // sparse payload scores as settled (fail-open)
		expect(isSweepCandidate(event("post", true, 7102))).toBe(false); // already has its figure
		expect(isSweepCandidate(event("post", false, 0))).toBe(false); // suspended — 0 means "not over", not "unreported"
		expect(isSweepCandidate(event("in", true, 0))).toBe(false);
		expect(isSweepCandidate(event("pre", undefined, 0))).toBe(false);
	});

	it("joinSdpMatch joins by home acronym + UTC day, tolerating the ±1-day listing boundary", () => {
		const sdp = [
			{ matchId: "m-was", matchDateUtc: "2026-08-02T20:00:00Z", home: { acronymName: "WAS" } },
			{ matchId: "m-sea", matchDateUtc: "2026-08-10T01:00:00Z", home: { acronymName: "SEA" } },
		];
		expect(joinSdpMatch({ dateUTC: "2026-08-02T20:00Z", homeAbbr: "WAS" }, sdp)).toBe("m-was");
		// A late-evening local kickoff lists on the next UTC day on one side — still joins.
		expect(joinSdpMatch({ dateUTC: "2026-08-09T23:30Z", homeAbbr: "SEA" }, sdp)).toBe("m-sea");
		// Same day, different home team → no join (never guess).
		expect(joinSdpMatch({ dateUTC: "2026-08-02T20:00Z", homeAbbr: "ORL" }, sdp)).toBeNull();
		expect(joinSdpMatch({ dateUTC: "garbage", homeAbbr: "WAS" }, sdp)).toBeNull();
	});

	it("patchAttendance fills exactly the one field, and only when it should", () => {
		// The allowed case: settled + zero → filled, and the result re-parses with the figure.
		const patched = patchAttendance(toBuf(settledSummary(0)), 19897);
		expect(patched).not.toBeNull();
		const parsed = fromBuf(patched!) as { gameInfo: { attendance: number; venue: { fullName: string } } };
		expect(parsed.gameInfo.attendance).toBe(19897);
		expect(parsed.gameInfo.venue.fullName).toBe("Audi Field"); // neighbors untouched

		// Refusals: a real figure is never overwritten; unsettled matches are never patched;
		// junk bodies never throw.
		expect(patchAttendance(toBuf(settledSummary(7102)), 19897)).toBeNull();
		const suspended = settledSummary(0).replace('"completed":true', '"completed":false');
		expect(patchAttendance(toBuf(suspended), 19897)).toBeNull();
		expect(patchAttendance(toBuf("not json"), 19897)).toBeNull();
		expect(patchAttendance(toBuf(settledSummary(0)), 0)).toBeNull();
	});

	it("a patched body settles IMMUTABLE under chooseSummaryTTL (the point of enrich-before-TTL)", () => {
		const patched = patchAttendance(toBuf(settledSummary(0)), 19897);
		expect(chooseSummaryTTL(patched!)).toBe(31536000);
	});

	it("ledger records decode defensively", () => {
		expect(decodeAttendanceRecord('{"n":7102,"source":"nwsl","at":"2026-08-11T00:00:00Z"}'))
			.toEqual({ n: 7102, source: "nwsl", at: "2026-08-11T00:00:00Z" });
		expect(decodeAttendanceRecord(null)).toBeNull();
		expect(decodeAttendanceRecord("junk")).toBeNull();
		expect(decodeAttendanceRecord('{"n":0,"source":"espn"}')).toBeNull();
		expect(decodeAttendanceRecord('{"n":5,"source":"guess"}')).toBeNull();
	});
});

describe("attendance sweep + enrich (mocked upstreams)", () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	const scoreboardBody = JSON.stringify({
		events: [
			{
				id: "401853961",
				date: "2026-08-02T20:00Z",
				status: { type: { state: "post", completed: true } },
				competitions: [
					{
						attendance: 0,
						competitors: [
							{ homeAway: "home", team: { abbreviation: "WAS" } },
							{ homeAway: "away", team: { abbreviation: "SD" } },
						],
					},
				],
			},
		],
	});
	const sdpMatchesBody = JSON.stringify([
		{ matchId: "m-was", matchDateUtc: "2026-08-02T20:00:00Z", home: { acronymName: "WAS" } },
	]);

	it("the ESPN-blank / league-has-it case: sweep banks the NWSL figure, /summary serves it", async () => {
		// Sweep upstreams: windowed scoreboard → the zero match; ESPN summary probe → still 0;
		// SDP season list → join table; matchfacts → the league's 19,897.
		fetchMock.get(ESPN)
			.intercept({ path: (p) => p.includes("/scoreboard") })
			.reply(200, scoreboardBody, { headers: { "Content-Type": "application/json" } });
		fetchMock.get(ESPN)
			.intercept({ path: (p) => p.includes("/summary") })
			.reply(200, settledSummary(0), { headers: { "Content-Type": "application/json" } });
		fetchMock.get(SDP)
			.intercept({ path: (p) => p.endsWith("/matches") })
			.reply(200, sdpMatchesBody, { headers: { "Content-Type": "application/json" } });
		fetchMock.get(SDP)
			.intercept({ path: (p) => p.includes("/matchfacts") })
			.reply(200, JSON.stringify({ enviroment: { numberOfSpectators: 19897 } }),
				{ headers: { "Content-Type": "application/json" } });

		const diags: string[] = [];
		const report = await attendanceSweep(env, (k, d) => diags.push(`${k}: ${d}`), true);
		expect(report).toEqual({ ran: true, candidates: 1, found: 1 });
		expect(decodeAttendanceRecord(await env.FEED_TAGS.get("attendance:401853961")))
			.toMatchObject({ n: 19897, source: "nwsl" });
		expect(diags.some((d) => d.startsWith("attendanceSweep"))).toBe(true);

		// Now the serving half: a /summary MISS for that event gets the figure patched in.
		fetchMock.get(ESPN)
			.intercept({ path: (p) => p.includes("/summary") })
			.reply(200, settledSummary(0), { headers: { "Content-Type": "application/json" } });
		const request = new IncomingRequest("https://proxy.test/summary?event=401853961");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const served = (await response.json()) as { gameInfo?: { attendance?: number } };
		expect(served.gameInfo?.attendance).toBe(19897);
	});

	it("a gated (non-forced) sweep is a no-op inside the 6h window", async () => {
		// Isolated per-test storage: seed the gate stamp ourselves, then confirm the gate holds.
		await env.FEED_TAGS.put("attendance-sweep:last", String(Date.now()));
		const report = await attendanceSweep(env, () => {}, false);
		expect(report.ran).toBe(false);
	});

	it("enrichSummaryAttendance passes non-applicable bodies through untouched", async () => {
		// A body that already has its figure never even reads KV — same reference back.
		const withFigure = toBuf(settledSummary(7102));
		expect(await enrichSummaryAttendance(env, "999", withFigure)).toBe(withFigure);
		// No event id → untouched reference back.
		const zeroBody = toBuf(settledSummary(0));
		expect(await enrichSummaryAttendance(env, null, zeroBody)).toBe(zeroBody);
		// Applicable but no ledger entry → original bytes.
		const unledgered = await enrichSummaryAttendance(env, "12345", zeroBody);
		expect(new TextDecoder().decode(unledgered)).toBe(settledSummary(0));
	});
});
