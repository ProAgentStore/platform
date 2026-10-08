/**
 * What the console says about a Scout's schedule and one scan's activity (#980).
 *
 * Values here, wiring as a source guard at the bottom — the pattern `Dashboard.instances.test.ts`
 * explains: this console has no component harness, and the defect #980 reports is an ABSENCE (no
 * schedule anywhere, no run on the board), which no unit test of a component can see.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CADENCE_OPTIONS, type ScanSchedule, type ScanTelemetry, cadenceLabel, scheduleHeadline, telemetryRows, whenLabel } from "./scanSchedule";

const schedule = (over: Partial<ScanSchedule> = {}): ScanSchedule => ({
	configured: true,
	enabled: true,
	cadence: "0 7 * * 1-5",
	objective: "Senior TypeScript roles in Sydney",
	triggerId: "trig-1",
	name: "Scheduled scan",
	nextRunAt: "2026-10-09T07:00:00.000Z",
	lastRunAt: "2026-10-08T07:00:00.000Z",
	nextSlotAt: "2026-10-09T07:00:00.000Z",
	failureCount: 0,
	lastError: null,
	...over,
});

const telemetry = (over: Partial<ScanTelemetry> = {}): ScanTelemetry => ({
	runId: "run-1",
	status: "completed",
	startedBy: "trigger",
	startedAt: "2026-10-08T07:00:00.000Z",
	endedAt: "2026-10-08T07:04:00.000Z",
	durationMs: 240_000,
	configured: { engine: "claude", authMode: "subscription", sources: ["jobs.example.com", "boards.example.org"], denied: [], collection: "job_leads", keyField: "url", maxPages: 30, maxMinutes: 15 },
	sources: { configured: 2, reached: 1, unreachable: 1, reach: [{ domain: "boards.example.org", pages: 0, blocked: 0, failed: "login_required" }, { domain: "jobs.example.com", pages: 4, blocked: 1, failed: null }] },
	seen: { pages: 4, snapshots: 2, findings: 3 },
	leads: { added: 1, duplicates: 1, skipped: 0, pending: 1, recordIds: ["lead-7"] },
	rejections: [{ reason: "duplicate", count: 1 }, { reason: "pending", count: 1 }],
	handoffs: { emitted: 0, note: "A Scout hands a lead to the Tailor when you Apply to it." },
	warnings: [{ code: "browser.blocked", count: 1 }],
	errors: [{ code: "source:login_required", count: 1 }],
	terminal: { outcome: "completed", errorCode: null, reason: "1 lead(s) added from 3 result(s) across 4 page(s)." },
	...over,
});

describe("the schedule, as the owner reads it", () => {
	it("unconfigured says SO — the console never shows a cadence nobody chose (#980)", () => {
		expect(scheduleHeadline(null)).toMatchObject({ tone: "muted" });
		expect(scheduleHeadline(null).text).toMatch(/Not scheduled/);
		expect(scheduleHeadline(schedule({ configured: false })).text).toMatch(/only when you start a scan/);
		// The picker offers cadences; none of them is a default.
		expect(CADENCE_OPTIONS.length).toBeGreaterThan(2);
		expect(CADENCE_OPTIONS.map((o) => o.value)).not.toContain("");
	});

	it("distinguishes paused from unconfigured, which is the distinction the issue is about", () => {
		expect(scheduleHeadline(schedule({ enabled: false }))).toMatchObject({ tone: "warning" });
		expect(scheduleHeadline(schedule({ enabled: false })).text).toMatch(/Paused — Weekday mornings is set but switched off/);
		expect(scheduleHeadline(schedule())).toMatchObject({ tone: "success" });
	});

	it("leads with the FAILURE when scheduled scans are failing — that is why nothing is appearing", () => {
		const h = scheduleHeadline(schedule({ failureCount: 2, lastError: "No runner is connected." }));
		expect(h).toMatchObject({ tone: "danger" });
		expect(h.text).toMatch(/2 failed attempt\(s\): No runner is connected\./);
	});

	it("names a known cadence in words and passes a hand-written one through", () => {
		expect(cadenceLabel("0 7 * * 1-5")).toBe("Weekday mornings");
		expect(cadenceLabel("*/13 * * * *")).toBe("*/13 * * * *");
		expect(cadenceLabel(null)).toBe("not set");
	});

	it("a missing or unparseable time is a dash, not an Invalid Date", () => {
		expect(whenLabel(null)).toBe("—");
		expect(whenLabel("soon")).toBe("—");
		expect(whenLabel("2026-10-09T07:00:00.000Z")).not.toBe("—");
	});
});

describe("one scan's structured activity", () => {
	it("answers the questions in the order an owner asks them", () => {
		const rows = telemetryRows(telemetry());
		expect(rows.map((r) => r.label)).toEqual([
			"Started by",
			"Sources configured",
			"Source reachability",
			"Pages read",
			"Results found",
			"Leads added to Data",
			"Rejected",
			"Handoffs emitted",
			"Warnings",
			"Errors",
			"Outcome",
		]);
	});

	it("says which source failed and why, and marks it", () => {
		const row = telemetryRows(telemetry()).find((r) => r.label === "Source reachability");
		expect(row?.value).toContain("boards.example.org: unreachable (login_required)");
		expect(row?.value).toContain("jobs.example.com: 4 pages, 1 blocked");
		expect(row?.tone).toBe("warning");
	});

	it("reports rejections by reason, and 'none' rather than an empty cell", () => {
		expect(telemetryRows(telemetry()).find((r) => r.label === "Rejected")?.value).toBe("1 duplicate · 1 pending");
		expect(telemetryRows(telemetry({ rejections: [] })).find((r) => r.label === "Rejected")?.value).toBe("none");
	});

	it("drops the warning and error rows when there are none — a clean scan says nothing about them", () => {
		const labels = telemetryRows(telemetry({ warnings: [], errors: [] })).map((r) => r.label);
		expect(labels).not.toContain("Warnings");
		expect(labels).not.toContain("Errors");
	});

	it("ends with the server's own sentence about the outcome", () => {
		expect(telemetryRows(telemetry()).at(-1)).toMatchObject({ label: "Outcome", value: "1 lead(s) added from 3 result(s) across 4 page(s)." });
	});

	it("says a scan with no configured sources is not a scan with none allowed", () => {
		const row = telemetryRows(telemetry({ configured: { ...telemetry().configured, sources: [] } })).find((r) => r.label === "Sources configured");
		expect(row?.value).toMatch(/none — every site is allowed by the agent's own list/);
	});
});

describe("where it is rendered (source guard)", () => {
	const research = readFileSync("store/console/src/tabs/ResearchTab.tsx", "utf8");
	const runView = readFileSync("store/console/src/tabs/research/ResearchRunView.tsx", "utf8");
	const board = readFileSync("store/console/src/tabs/BoardTab.tsx", "utf8");

	it("the Research tab shows the schedule card, fed by the settings read", () => {
		expect(research).toContain("<ScanScheduleCard");
		expect(research).toMatch(/local-browser\/settings/);
	});

	it("the schedule card can start a scan now — the manual control #980 asks for", () => {
		expect(research).toMatch(/onScanNow=\{\(what\) => start\(what\)\}/);
	});

	it("the run view shows the telemetry panel, from the server's projection", () => {
		expect(runView).toContain("run.telemetry");
		expect(runView).toContain("telemetryRows(run.telemetry)");
	});

	it("the board renders the scan face beside the other card faces", () => {
		expect(board).toContain("<ScanRunFace item={item} />");
	});
});
