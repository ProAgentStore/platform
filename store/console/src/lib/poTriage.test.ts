import { describe, expect, it } from "vitest";
import { type PoTriageReport, reportSummary } from "./poTriage";

const report = (over: Partial<PoTriageReport> = {}): PoTriageReport => ({
	id: "r1",
	slot: "2026-10-12T01:17:00.000Z",
	dryRun: false,
	status: "completed",
	digest: null,
	error: null,
	createdAt: "2026-10-12 01:17:00",
	report: { gate: null, items: [], counts: { queued: 1, wouldQueue: 0, alreadyQueued: 0, ready: 1, waiting: 1, blocked: 1, needsDetail: 1, commented: 1 } },
	...over,
});

describe("reportSummary (#1027)", () => {
	it("one line per wake, from its counts", () => {
		expect(reportSummary(report())).toBe("queued 1 · 1 waiting on you · 1 blocked · 1 needs detail");
	});
	it("says when it was a dry run, when it held, and when it failed", () => {
		const dry = report({ dryRun: true, report: { gate: "The instance is paused, so nothing is queued.", items: [], counts: { queued: 0, wouldQueue: 2, alreadyQueued: 0, ready: 2, waiting: 0, blocked: 0, needsDetail: 0, commented: 0 } } });
		expect(reportSummary(dry)).toBe("would queue 2 — held: The instance is paused, so nothing is queued. (dry run)");
		expect(reportSummary(report({ status: "failed", error: "GitHub 502", report: null }))).toBe("failed: GitHub 502");
	});
});
