// IMAGE MODERATION RUNNER (2026-10-20) — the player-image safety pass, run inside a Durable Object.
//
// WHY: the pass (`moderateSnapshotTick`) fetches a resized image + asks Workers AI per unjudged thumbnail.
// Inline in the shared 5-min tick, and then (#158) in its own Worker invocation, it was still bound by the
// Free plan's 10 ms Worker CPU cap and got killed with `exceededCpu` across the post-scrape window
// (13:15–13:50 UTC on 10/20, 12:05/12:10 on 10/19) — those ticks saved no verdicts. A Durable Object request
// gets 30 s of CPU on Free AND Paid (Cloudflare's DO limits page, verified 2026-10-20), and an ALARM handler
// has its own long wall-time budget, so the caller never waits on a slow image fetch or AI call either.
//
// Contract: the 5-min tick (inside the 12–14 UTC window) calls `kick()` — one fast RPC that only arms an
// alarm. `alarm()` runs the UNCHANGED pass (same trim / batch / carry-forward, same KV write sites, so the
// KV write allowlist is unchanged). Nothing is stored here; the alarm is the only state.

import { DurableObject } from "cloudflare:workers";
import { emitDiag, moderateSnapshotTick } from "./index.ts";

export class ModerationRunner extends DurableObject<Env> {
	/** Arm one pass. A pass already pending/running isn't doubled up — the next tick kicks again. */
	async kick(): Promise<{ armed: boolean }> {
		if ((await this.ctx.storage.getAlarm()) !== null) return { armed: false };
		await this.ctx.storage.setAlarm(Date.now());
		return { armed: true };
	}

	async alarm(): Promise<void> {
		// The pass expects an ExecutionContext for its fire-and-forget writes (diags, the drop log) — map it to
		// this object's own waitUntil.
		const ctx = { waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p), passThroughOnException() {} } as unknown as ExecutionContext;
		try {
			await moderateSnapshotTick(this.env, ctx);
		} catch (e) {
			emitDiag(this.env, ctx, "moderationTickFail", String((e as Error)?.message ?? e).slice(0, 80));
		}
	}
}
