import { describe, expect, it } from "vitest";
import { buildRunDetails, formatDuration, type PipelineRun, type PipelineRunTraceEvent } from "./runDetails";

const run = (over: Partial<PipelineRun>): PipelineRun => ({
	run_id: "run-1",
	pipeline: "lead-finder",
	trigger: "api",
	status: "completed",
	started_at: 1_700_000_000_000,
	finished_at: 1_700_000_083_000,
	seen: 10,
	added: 10,
	skipped: 0,
	errors: 0,
	detail: "3 step(s)",
	...over,
});

const ev = (over: Partial<PipelineRunTraceEvent>): PipelineRunTraceEvent => ({
	id: Math.random().toString(36),
	ts: 1_700_000_001_000,
	source: "pipeline",
	level: "info",
	event: "pipeline.step",
	message: "ok",
	context: null,
	...over,
});

describe("buildRunDetails (#834)", () => {
	it("failed run: surfaces the failing step from the trace", () => {
		const d = buildRunDetails(run({ status: "failed", errors: 1, detail: "Failed at step 1 (http): 500" }), [
			ev({ event: "pipeline.start" }),
			ev({ event: "pipeline.end", level: "warn", message: "Failed at step 1 (http): 500", context: JSON.stringify({ failedStep: 1, tool: "http" }) }),
		]);
		expect(d).toEqual({
			duration: "1m 23s",
			hasErrors: true,
			detailText: "Failed at step 1 (http): 500",
			firstError: { event: "pipeline.end", message: "Failed at step 1 (http): 500", firstError: null, failed: null, total: null, step: 1, tool: "http" },
			errorsOnlyInLog: false,
		});
	});

	it("completed run with partial errors: surfaces pipeline.partial's firstError, not the cap warning", () => {
		const d = buildRunDetails(run({ errors: 40, detail: "3 step(s); 40 of 83 failed" }), [
			ev({ event: "pipeline.capped", level: "warn", message: "capped at 100" }),
			ev({
				event: "pipeline.partial",
				level: "warn",
				message: "40 of 83 failed — No API key",
				context: JSON.stringify({ step: 2, tool: "http", failed: 40, total: 83, firstError: "No API key connected for the http connector" }),
			}),
			ev({ event: "pipeline.end", message: "Completed" }),
		]);
		expect(d.hasErrors).toBe(true);
		expect(d.errorsOnlyInLog).toBe(false);
		expect(d.firstError).toEqual({
			event: "pipeline.partial",
			message: "40 of 83 failed — No API key",
			firstError: "No API key connected for the http connector",
			failed: 40,
			total: 83,
			step: 2,
			tool: "http",
		});
	});

	it("zero-error run: no error section, even with a cap warning on the trace", () => {
		const d = buildRunDetails(run({}), [ev({ event: "pipeline.capped", level: "warn" }), ev({ event: "pipeline.end" })]);
		expect(d).toEqual({ duration: "1m 23s", hasErrors: false, detailText: "3 step(s)", firstError: null, errorsOnlyInLog: false });
	});

	it("errors that never reached the trace (sink failures) are flagged, not shown as nothing", () => {
		const d = buildRunDetails(run({ errors: 2 }), [ev({ event: "pipeline.end" })]);
		expect(d.firstError).toBeNull();
		expect(d.errorsOnlyInLog).toBe(true);
	});

	it("a running run has no duration", () => {
		expect(buildRunDetails(run({ status: "running", finished_at: null, detail: null }), []).duration).toBeNull();
	});
});

describe("formatDuration", () => {
	it.each([
		[400, "<1s"],
		[45_000, "45s"],
		[83_000, "1m 23s"],
		[7_500_000, "2h 5m"],
	])("%i ms → %s", (ms, out) => expect(formatDuration(ms)).toBe(out));
});
