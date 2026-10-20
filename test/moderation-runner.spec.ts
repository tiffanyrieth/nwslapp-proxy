// MODERATION RUNNER (2026-10-20): the image-moderation pass runs inside a Durable Object (30 s CPU on Free,
// vs the Worker's 10 ms that kept killing it). The tick only KICKS it: one RPC that arms an alarm.
// Note: the test runtime fires an alarm armed for "now" immediately, so "already pending" is simulated with
// an explicit future alarm.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { ModerationRunner } from "../src/moderation-runner";

function stub(name: string) {
	const ns = env.MODERATION_RUNNER!;
	return ns.get(ns.idFromName(name)) as DurableObjectStub<ModerationRunner>;
}

describe("ModerationRunner", () => {
	it("kick arms an alarm when none is pending", async () => {
		expect(await stub("kick-fresh").kick()).toEqual({ armed: true });
	});

	it("a kick while a pass is already pending doesn't double up", async () => {
		const s = stub("kick-pending");
		await runInDurableObject(s, async (_obj, state) => {
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		expect(await s.kick()).toEqual({ armed: false });
	});

	it("the alarm runs the pass cleanly (outside the window / without AI it's a no-op) and clears", async () => {
		const s = stub("alarm-runs");
		await runInDurableObject(s, async (_obj, state) => {
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		expect(await runDurableObjectAlarm(s)).toBe(true); // the handler ran without throwing
		await runInDurableObject(s, async (_obj, state) => {
			expect(await state.storage.getAlarm()).toBeNull();
		});
		expect(await s.kick()).toEqual({ armed: true }); // re-armable for the next tick
	});
});
