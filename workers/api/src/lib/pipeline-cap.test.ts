import { describe, expect, it } from "vitest";
import { capStepOutput } from "./pipeline.js";
import type { StepResult } from "./pipeline.js";

const ok = (output: unknown): StepResult => ({ tool: "flatten", bind: "s3", success: true, content: "fine", output });

describe("capStepOutput — an oversize step must fail the STEP, not the run", () => {
	it("turns a >1MiB output into an ordinary failed step with actionable guidance", () => {
		// Seen in production: lead_finder died several steps in with
		//   "Step s3-flatten-1 output is too large. Maximum allowed size is 1MiB."
		// Cloudflare journals every step.do return value and rejects an oversize one with a
		// WorkflowInternalError that kills the RUN. A sweep that happened to match a lot of places
		// lost everything to an infrastructure error naming an internal step id, with no
		// indication of what to do about it.
		const huge = ok(Array.from({ length: 20_000 }, (_, i) => ({ id: i, blurb: "x".repeat(80) })));
		const capped = capStepOutput(huge, "flatten", 3);
		expect(capped.success).toBe(false);
		expect(capped.output).toBeNull(); // the oversize payload must not be journaled
		expect(capped.content).toMatch(/over the 1MiB per-step limit/);
		expect(capped.content).toMatch(/slice/); // names the primitive that exists for exactly this
		expect(capped.content).toMatch(/step 3 \(flatten\)/);
	});

	it("leaves an ordinary result completely untouched", () => {
		const small = ok([{ place_id: "p1" }, { place_id: "p2" }]);
		expect(capStepOutput(small, "flatten", 0)).toBe(small);
	});

	it("passes a large-but-legal output through", () => {
		// The cap sits below 1MiB with headroom; it must not start failing normal sweeps.
		const sized = ok([{ blob: "y".repeat(400_000) }]);
		expect(capStepOutput(sized, "flatten", 1).success).toBe(true);
	});

	it("does not throw on an unserializable output — that is the engine's error to report", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => capStepOutput(ok(cyclic), "map", 2)).not.toThrow();
		expect(capStepOutput(ok(cyclic), "map", 2).success).toBe(true);
	});
});
