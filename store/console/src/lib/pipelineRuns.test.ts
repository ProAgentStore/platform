import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstRunError, runDuration, runHasErrors, type Run, type RunTraceEvent } from "./pipelineRuns";

const run = (over: Partial<Run>): Run => ({
	run_id: "run-1",
	pipeline: "lead-finder",
	trigger: "api",
	status: "completed",
	started_at: 1_000_000,
	finished_at: 1_065_000,
	seen: 83,
	added: 43,
	skipped: 0,
	errors: 0,
	detail: "3 step(s)",
	...over,
});

let n = 0;
const ev = (event: string, level: string, message: string, context?: Record<string, unknown>): RunTraceEvent => ({
	id: `e${++n}`,
	ts: 1_000_000 + n,
	level,
	event,
	message,
	context: context ? JSON.stringify(context) : null,
});

describe("a FAILED run (#834)", () => {
	const failed = run({ status: "failed", errors: 1, detail: "Failed at step 1 (web_search): 429 rate limited" });
	const trace = [
		ev("pipeline.start", "info", 'Run "lead-finder" (api)'),
		ev("pipeline.step", "warn", "step 1 web_search → hits: 429 rate limited", { step: 1, tool: "web_search", success: false }),
		ev("pipeline.end", "warn", "Failed at step 1 (web_search): 429 rate limited", { failedStep: 1, tool: "web_search" }),
	];

	it("is flagged as having errors even when the count alone would be ambiguous", () => {
		expect(runHasErrors(failed)).toBe(true);
		expect(runHasErrors({ status: "failed", errors: 0 })).toBe(true);
	});

	it("surfaces the first failing step from the trace", () => {
		expect(firstRunError(trace)).toEqual({ where: "step 1 · web_search", message: "step 1 web_search → hits: 429 rate limited", scope: null });
	});

	it("does not mistake a coverage cap for the failure", () => {
		const capped = [ev("pipeline.capped", "warn", "capped at 50 of 200", { step: 0, tool: "web_search" }), ...trace];
		expect(firstRunError(capped)?.where).toBe("step 1 · web_search");
	});
});

describe("a COMPLETED run with partial errors (#834, #642)", () => {
	const partial = run({ errors: 40, detail: "3 step(s); enrich → http_reachable failed on 40 of 83 record(s) — ECONNREFUSED" });
	const trace = [
		ev("pipeline.start", "info", 'Run "lead-finder" (api)'),
		ev("pipeline.partial", "warn", "enrich → http_reachable failed on 40 of 83 record(s) — ECONNR", {
			step: 2,
			tool: "enrich",
			dispatched: "http_reachable",
			bind: "probed",
			failed: 40,
			total: 83,
			firstError: "ECONNREFUSED 203.0.113.9:443 (https://example.test)",
		}),
		ev("pipeline.end", "info", 'Completed "lead-finder": 3 step(s)'),
	];

	it("is flagged as having errors although its status is completed", () => {
		expect(runHasErrors(partial)).toBe(true);
	});

	it("reads the untruncated firstError from context, not the clipped message", () => {
		expect(firstRunError(trace)).toEqual({
			where: "step 2 · enrich → http_reachable",
			message: "ECONNREFUSED 203.0.113.9:443 (https://example.test)",
			scope: "40 of 83 record(s) failed",
		});
	});

	it("falls back to the event message when context was truncated past valid JSON", () => {
		const clipped = { ...trace[1], context: '{"step":2,"firstError":"ECONN' };
		expect(firstRunError([clipped])).toEqual({ where: null, message: trace[1].message, scope: null });
	});
});

describe("a ZERO-error run (#834)", () => {
	const ok = run({});
	const trace = [ev("pipeline.start", "info", 'Run "lead-finder" (api)'), ev("pipeline.end", "info", 'Completed "lead-finder": 3 step(s)')];

	it("is not flagged, and its trace yields no error", () => {
		expect(runHasErrors(ok)).toBe(false);
		expect(firstRunError(trace)).toBeNull();
		expect(firstRunError([])).toBeNull();
	});
});

describe("runDuration", () => {
	it("formats finished runs and says nothing for a running one", () => {
		expect(runDuration({ started_at: 0, finished_at: 450 })).toBe("450ms");
		expect(runDuration({ started_at: 0, finished_at: 3_200 })).toBe("3.2s");
		expect(runDuration({ started_at: 0, finished_at: 65_000 })).toBe("1m 05s");
		expect(runDuration({ started_at: 0, finished_at: 7_440_000 })).toBe("2h 04m");
		expect(runDuration({ started_at: 0, finished_at: null })).toBeNull();
	});
});

describe("Data → Runs wiring (#834)", () => {
	const dataTab = readFileSync(join(__dirname, "../tabs/DataTab.tsx"), "utf8");
	const panel = readFileSync(join(__dirname, "../components/PipelineRunDetails.tsx"), "utf8");

	it("opens details from a real control, not a hover-only row tooltip", () => {
		expect(dataTab).not.toMatch(/title=\{r\.detail/);
		expect(dataTab).toContain("aria-expanded={openRun === r.run_id}");
		expect(dataTab).toContain("<PipelineRunDetails");
	});

	it("reads the run's own trace by trace_id = run_id", () => {
		expect(panel).toMatch(/\/trace\?trace_id=\$\{encodeURIComponent\(run\.run_id\)\}/);
	});
});
