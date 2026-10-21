// NEW-DEVICE EMAIL ALERT (2026-10-21) — emails the owner when the app is opened by a device outside the
// usual testers (e.g. an App Review session) while the app is still pre-launch.
//
// Reads ONLY the anonymous counters `/analytics` already receives: `active_week` / `active_month` with param
// "new" | "returning" (each device decides that itself from local state; no id, no IP ever reaches us).
// Nothing new is collected and the app is unchanged.
//
// Two triggers, checked when a batch carries one of those counters:
//   1. a NEW install (`active_week`/`active_month` param "new")
//   2. more devices active THIS ISO week than the baseline (default 2) — catches a reused review device,
//      which reports "returning". A tester skipping a week can't trip it: that week just has fewer devices.
//
// Off unless the `NEW_DEVICE_ALERT` secret is "1"/"on" — flip it off before launch (at 1k users every
// install would email). A per-day cap in the ContentStore DO (never KV) bounds the worst case either way.

export interface NewDeviceAlertEnv {
	NEW_DEVICE_ALERT?: string;
	NEW_DEVICE_ALERT_BASELINE?: string;
}

export interface AnalyticsEvent { event: string; param: string; n: number }

export const NEW_DEVICE_DAILY_CAP = 5;
const DEFAULT_BASELINE = 2;

export function newDeviceAlertEnabled(env: NewDeviceAlertEnv): boolean {
	const v = (env.NEW_DEVICE_ALERT ?? "").trim().toLowerCase();
	return v === "1" || v === "on" || v === "true";
}

export function newDeviceBaseline(env: NewDeviceAlertEnv): number {
	const n = Number(env.NEW_DEVICE_ALERT_BASELINE);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_BASELINE;
}

/** Does this batch carry an activity counter worth checking? (`active_week` arrives once per device per week.) */
export function hasActivityCounter(events: AnalyticsEvent[]): boolean {
	return events.some((e) => e.event === "active_week" || e.event === "active_month");
}

/** True when the batch reports a never-before-seen install. */
export function isNewInstall(events: AnalyticsEvent[]): boolean {
	return events.some((e) => (e.event === "active_week" || e.event === "active_month") && e.param === "new");
}

/** Monday (UTC, "YYYY-MM-DD") of the ISO week containing `now` — the same UTC week the app keys `active_week` on. */
export function isoWeekStartDay(now: Date): string {
	const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d.toISOString().slice(0, 10);
}

/** The email to send for this batch, or null. `weekDevices` = this week's `active_week` total AFTER the batch
 *  was counted (null when it couldn't be read — the new-install trigger still works without it). */
export function decideNewDeviceAlert(
	events: AnalyticsEvent[],
	weekDevices: number | null,
	baseline: number,
): { subject: string; reason: string } | null {
	if (isNewInstall(events)) {
		return { subject: "a new device opened the app", reason: "A device that has never opened the app before just opened it (a first-ever install)." };
	}
	// Only a batch that ADDED to this week's total can push it over the baseline — otherwise the same
	// over-baseline week would re-alert on every returning device's monthly counter.
	const addedThisWeek = events.some((e) => e.event === "active_week");
	if (addedThisWeek && weekDevices != null && weekDevices > baseline) {
		return {
			subject: `${weekDevices} devices active this week`,
			reason: `${weekDevices} devices have opened the app this week (usual: ${baseline}). The newest one has opened it before, so it counted as returning, not new.`,
		};
	}
	return null;
}

export function osLine(events: AnalyticsEvent[]): string {
	const os = events.find((e) => e.event === "session_os")?.param;
	return os ? `iOS version: ${os}` : "iOS version: not reported";
}
