import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { needsHuman, statusFor, type LoopStopReason } from "./agent-loop.js";
import { codingCrashReport, INTERRUPTED_CLASSES, runOutcomeNote } from "./coding-run-report.js";
import { classifyCodingFailure } from "./coding-failure.js";
import { stopReasonFor } from "./coding-pause.js";
import { RunnerGoneError } from "./runner-unreachable.js";

describe("a platform interruption is not the objective failing (#546)", () => {
	// Verbatim from the eight production occurrences the ticket was measured on.
	const INTERNAL = "WorkflowInternalError: Attempt failed due to internal workflows error";
	const CEILING =
		"Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits";
	const RESET = "Durable Object reset because its code was updated";

	it("covers exactly the three classes where the platform cut the invocation off", () => {
		// G1: the set is asserted, not assumed. Adding a class here without a reason — or losing
		// one — changes what the owner is told about a whole population of dead runs.
		expect([...INTERRUPTED_CLASSES].sort()).toEqual(["infra_transient", "platform_ceiling", "workflow_internal"]);
		for (const message of [INTERNAL, CEILING, RESET]) {
			expect(INTERRUPTED_CLASSES.has(classifyCodingFailure(new Error(message)).class), message).toBe(true);
		}
	});

	it("drops the `run error:` prefix, which reads as a crash, and says the work is intact", () => {
		for (const message of [INTERNAL, CEILING, RESET]) {
			const r = codingCrashReport(new Error(message));
			expect(r.detail, message).not.toContain("run error:");
			expect(r.detail, message).toContain(message);
			// The half that changes what the owner DOES. Two of the five occurrences carried
			// `Acts: pushed directly to the trunk origin main` and were reported as failures, so he
			// re-ran work that was already on the trunk.
			expect(r.detail, message).toContain("already committed or pushed is unaffected");
			expect(r.stopReason, message).toBe("interrupted");
		}
	});

	it("leaves the two endings that already had a sentence exactly as they were", () => {
		// #341 wrote the runner sentence deliberately: "the runner did not come back" is a finding,
		// not a crash, and it must not be replaced by the generic interruption wording.
		const gone = codingCrashReport(new RunnerGoneError("waited 10 minutes; the machine did not come back"));
		expect(gone.detail).toBe("waited 10 minutes; the machine did not come back");
		expect(gone.stopReason).toBeNull();
		// A genuine crash keeps the prefix, because for it the prefix is true.
		const crash = codingCrashReport(new Error("Cannot read properties of undefined (reading 'pane')"));
		expect(crash.detail).toBe("run error: Cannot read properties of undefined (reading 'pane')");
		expect(crash.stopReason).toBeNull();
	});

	it("is total — a thrown string, null or object does not break the report", () => {
		for (const junk of [null, undefined, "boom", 7, {}]) {
			expect(() => codingCrashReport(junk)).not.toThrow();
			expect(codingCrashReport(junk).stopReason).toBeNull();
		}
	});
});

describe("`interrupted` is distinguishable from a run whose objective failed (#546 AC 2)", () => {
	it("does not collide with any reason an outcome can produce", () => {
		// The AC in one assertion: whatever the loop reports about the OBJECTIVE, it can never
		// produce `interrupted`, so a reader seeing that reason knows the invocation was cut off.
		const outcomes = ["done", "failed", "stuck", "needs_input", "max_steps", "cancelled", "waiting"] as const;
		expect(outcomes.length, "every CodingOutcome must be covered here").toBe(7);
		for (const o of outcomes) expect(stopReasonFor(o), o).not.toBe("interrupted");
	});

	it("lands in Needs you, not Failed — the owner has to look before re-running", () => {
		expect(statusFor("interrupted")).toBe("needs_human");
		expect(needsHuman("interrupted")).toBe(true);
		// And it is genuinely a different column from a failure, which is the point.
		expect(statusFor("failed")).toBe("failed");
	});

	it("maps every stop reason to a status, so no reason can land nowhere", () => {
		// G1/G3: the reason list is read off the type's own source rather than retyped, so a
		// reason added without a status mapping fails here instead of silently defaulting.
		const source = readFileSync(join(__dirname, "agent-loop.ts"), "utf8");
		const decl = /export type LoopStopReason =([\s\S]*?);\n/.exec(source);
		expect(decl, "LoopStopReason's declaration shape changed — re-read this guard").not.toBeNull();
		const reasons = [...decl![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) as LoopStopReason[];
		expect(reasons.length, "found no reasons — the regex stopped measuring").toBeGreaterThanOrEqual(8);
		expect(reasons).toContain("interrupted");
		for (const r of reasons) {
			expect(["completed", "failed", "needs_human", "cancelled"], r).toContain(statusFor(r));
		}
	});
});

describe("runOutcomeNote — the line both the run row and the card carry", () => {
	it("names a breach ahead of the act summary, and keeps the authority line", () => {
		expect(
			runOutcomeNote({
				outcome: "done",
				detail: "opened PR #12",
				breach: "merged to main without authority",
				authorityNote: "Authority: may not merge",
				actLine: "Acts: pushed a branch",
			}),
		).toBe("outcome: done — opened PR #12 | POLICY VIOLATION: merged to main without authority | Authority: may not merge | Acts: pushed a branch");
	});

	it("drops every empty part rather than emitting bare separators", () => {
		expect(runOutcomeNote({ outcome: "failed", detail: "", breach: "", authorityNote: null, actLine: null })).toBe("outcome: failed");
	});
});
