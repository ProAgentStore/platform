/**
 * Is this Scout scheduled? (#980)
 *
 * The live state: a connected Scout with leads, no configured trigger, and no way for the owner to
 * tell whether anything was going to happen. The machinery existed (#962's `run_local_browser` cron
 * action); the READ of it as "the Scout's schedule" did not.
 *
 * The rule these tests pin hardest: an unconfigured schedule is reported as unconfigured. The
 * platform does not pick a cadence, because a scan spends the owner's machine and their engine
 * subscription.
 */
import { describe, expect, it } from "vitest";
import { type ScanTriggerRow, SCAN_TRIGGER_ACTION, UNSCHEDULED, scanScheduleOf, scanScheduleSummary } from "./schedule.js";

const row = (over: Partial<ScanTriggerRow> = {}): ScanTriggerRow => ({
	id: "trig-1",
	name: "Scheduled scan",
	type: "cron",
	action: SCAN_TRIGGER_ACTION,
	enabled: 1,
	schedule: "0 7 * * 1-5",
	config: JSON.stringify({ objective: "Senior TypeScript roles in Sydney" }),
	last_run_at: "2026-10-08T07:00:00.000Z",
	next_run_at: "2026-10-09T07:00:00.000Z",
	next_slot_at: "2026-10-09T07:00:00.000Z",
	failure_count: 0,
	last_error: null,
	...over,
});

describe("the schedule these trigger rows amount to", () => {
	it("no rows is UNCONFIGURED — not 'off', and never a cadence we chose", () => {
		expect(scanScheduleOf([])).toEqual(UNSCHEDULED);
		expect(scanScheduleOf([]).cadence).toBeNull();
		expect(scanScheduleSummary(scanScheduleOf([]))).toMatch(/No scan schedule/);
		expect(scanScheduleSummary(scanScheduleOf([]))).toMatch(/set a cadence/);
	});

	it("a cron row with the scan action IS the schedule, with its cadence, objective and times", () => {
		expect(scanScheduleOf([row()])).toMatchObject({
			configured: true,
			enabled: true,
			cadence: "0 7 * * 1-5",
			objective: "Senior TypeScript roles in Sydney",
			triggerId: "trig-1",
			nextRunAt: "2026-10-09T07:00:00.000Z",
			lastRunAt: "2026-10-08T07:00:00.000Z",
			failureCount: 0,
		});
	});

	it("ignores rows that are not a scheduled scan — a webhook, or another action", () => {
		expect(scanScheduleOf([row({ type: "webhook" })])).toEqual(UNSCHEDULED);
		expect(scanScheduleOf([row({ action: "run_pipeline" })])).toEqual(UNSCHEDULED);
	});

	it("a configured-but-disabled schedule says SWITCHED OFF, keeping the cadence visible", () => {
		const s = scanScheduleOf([row({ enabled: 0 })]);
		expect(s).toMatchObject({ configured: true, enabled: false, cadence: "0 7 * * 1-5" });
		expect(scanScheduleSummary(s)).toMatch(/SWITCHED OFF/);
		// `configured: false` and `enabled: false` are different answers and must stay so: one is
		// "nobody set this up", the other is "the owner paused it".
		expect(s.configured).not.toBe(s.enabled);
	});

	it("the ENABLED row wins when there is a choice — it is the one that will fire", () => {
		const s = scanScheduleOf([row({ id: "old", enabled: 0, schedule: "0 * * * *" }), row({ id: "live", enabled: 1, schedule: "@daily" })]);
		expect(s).toMatchObject({ triggerId: "live", cadence: "@daily", enabled: true });
	});

	it("reports consecutive failures and the last reason, which is why nothing is appearing", () => {
		const s = scanScheduleOf([row({ failure_count: 3, last_error: "No runner is connected." })]);
		expect(s).toMatchObject({ failureCount: 3, lastError: "No runner is connected." });
		expect(scanScheduleSummary(s)).toMatch(/3 consecutive failure\(s\): No runner is connected\./);
	});

	it("an objective nobody wrote reads as null rather than an empty string", () => {
		expect(scanScheduleOf([row({ config: "{}" })]).objective).toBeNull();
		expect(scanScheduleOf([row({ config: JSON.stringify({ objective: "   " }) })]).objective).toBeNull();
		expect(scanScheduleOf([row({ config: null })]).objective).toBeNull();
	});

	it("survives a row the sweeper has not touched yet — no next run is not an error", () => {
		const s = scanScheduleOf([row({ next_run_at: null, next_slot_at: null, last_run_at: null })]);
		expect(s).toMatchObject({ configured: true, nextRunAt: null, lastRunAt: null });
		expect(scanScheduleSummary(s)).toMatch(/next run not yet scheduled, has not run yet/);
	});

	it("the summary and the fields never disagree about the state", () => {
		// A surface that showed only the sentence would have to parse it back to render a control,
		// so both are reported — and these are the four states they must agree on.
		expect(scanScheduleSummary(scanScheduleOf([]))).toMatch(/No scan schedule/);
		expect(scanScheduleSummary(scanScheduleOf([row({ enabled: 0 })]))).toMatch(/SWITCHED OFF/);
		expect(scanScheduleSummary(scanScheduleOf([row()]))).toMatch(/^Scanning 0 7 \* \* 1-5 — next/);
		expect(scanScheduleSummary(scanScheduleOf([row({ failure_count: 1, last_error: "boom" })]))).toMatch(/1 consecutive failure/);
	});
});
