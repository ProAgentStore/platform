/**
 * The run record a browser driver writes, so `stop_work` can reach it (#560).
 *
 * The denominator (ADR 0002) is `ApplyOutcome`'s OWN declaration, read out of `apply-loop.ts`
 * rather than re-typed here. A hand-written list of ten outcomes would pass forever while the union
 * grew an eleventh, which is precisely the failure #560 is the third instance of: a fix applied to
 * a list of known sites that missed one (#356 → #554 → #540).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROWSER_RUN_ROUNDS, BROWSER_RUN_STOP_REASONS, browserRunObjective, browserRunStopReason, handoffGiveUpAt, HANDOFF_POLL_MS } from "./browser-run.js";
import { statusFor, type LoopStopReason } from "./agent-loop.js";

const DIR = dirname(fileURLToPath(import.meta.url));

/** Every member of `ApplyOutcome`, from the union as written. */
function declaredOutcomes(): string[] {
	const src = readFileSync(join(DIR, "apply-loop.ts"), "utf8");
	const decl = /export type ApplyOutcome =([^;]*);/.exec(src);
	if (!decl) throw new Error("could not find the ApplyOutcome declaration — this guard has stopped measuring");
	return [...decl[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("the browser run's stop reason", () => {
	const outcomes = declaredOutcomes();

	it("reads a plausible ApplyOutcome union — G1/G2", () => {
		// Ten today. A parse that silently returned two would make every assertion below vacuous.
		expect(outcomes.length, `ApplyOutcome declares ${outcomes.length} outcomes`).toBeGreaterThanOrEqual(10);
		expect(outcomes).toContain("cancelled");
		expect(outcomes).toContain("submitted");
	});

	it("covers every declared outcome — no more, no fewer", () => {
		expect(Object.keys(BROWSER_RUN_STOP_REASONS).sort()).toEqual([...outcomes].sort());
	});

	it("gives every outcome a reason the board can already render", () => {
		// `statusFor` is the platform's ONE reason→column mapping. An outcome whose reason fell
		// through to something it does not handle is #553's defect arriving from a new direction.
		const columns = new Set(["completed", "failed", "needs_human", "cancelled"]);
		for (const o of outcomes) {
			const reason = browserRunStopReason(o as never);
			expect(columns.has(statusFor(reason as LoopStopReason)), `${o} → ${reason} → unrenderable column`).toBe(true);
		}
	});

	it("puts an unanswered human handoff in Needs you, never in Done or Failed", () => {
		// The exact defect #553 measured: three runs that had died waiting on a human, all three
		// shown as completed, with "Needs you" empty the whole time.
		for (const o of ["captcha", "stuck", "needs_input"] as const) {
			expect(browserRunStopReason(o)).toBe("escalated");
			expect(statusFor(browserRunStopReason(o))).toBe("needs_human");
		}
	});

	it("records a stopped run as cancelled, not as a failure", () => {
		// `stop_work` is the user's own decision. Filing it as `failed` would put the owner's
		// deliberate stop in the same column as a crash and invite a pointless Retry.
		expect(browserRunStopReason("cancelled")).toBe("cancelled");
		expect(statusFor("cancelled")).toBe("cancelled");
	});

	it("does not call a completed dry run a failure", () => {
		expect(statusFor(browserRunStopReason("ready"))).toBe("completed");
		expect(statusFor(browserRunStopReason("submitted"))).toBe("completed");
	});

	it("treats the step cap as a cap, not a fault", () => {
		expect(browserRunStopReason("max_steps")).toBe("max_iterations");
	});
});

describe("the handoff give-up instant", () => {
	it("names the same absolute moment as the polls run down", () => {
		// A Workflow replays. An instant computed as "now + the whole wait" would move forward on
		// every re-execution and the run would postpone its own deadline (#596).
		const t0 = 1_000_000;
		expect(handoffGiveUpAt(t0, 180)).toBe(t0 + 180 * HANDOFF_POLL_MS);
		// 60 polls later, 60 × 5s further into the wait: the same instant.
		expect(handoffGiveUpAt(t0 + 60 * HANDOFF_POLL_MS, 120)).toBe(t0 + 180 * HANDOFF_POLL_MS);
	});

	it("never reports a deadline in the past", () => {
		expect(handoffGiveUpAt(500, -3)).toBe(500);
	});
});

describe("the objective a run record carries", () => {
	it("names the site rather than leaving stop_work quoting an empty string", () => {
		expect(browserRunObjective("apply", { url: "https://jobs.dayforcehcm.com/x/y" })).toBe("Apply for the job at jobs.dayforcehcm.com");
	});

	it("prefers the browse task's own stated objective", () => {
		expect(browserRunObjective("browse", { url: "https://example.com", objective: "Book the 9am slot" })).toBe("Book the 9am slot");
	});

	it("falls back to the host when a browse task states nothing", () => {
		expect(browserRunObjective("browse", { url: "https://example.com/a", objective: "  " })).toBe("Browser task on example.com");
	});

	it("survives a URL that does not parse", () => {
		expect(browserRunObjective("apply", { url: "not a url" })).toContain("not a url");
	});
});

describe("the round cap", () => {
	it("is the number both workflows actually loop to", () => {
		// The run row's `max_iterations` and the loop bound are the same fact; nothing but this
		// assertion makes the two files agree about it.
		const sources = ["../workflows/job-apply.ts", "../workflows/browser-task.ts"];
		for (const rel of sources) {
			const src = readFileSync(join(DIR, rel), "utf8");
			expect(src, `${rel} no longer loops to BROWSER_RUN_ROUNDS`).toMatch(/round < BROWSER_RUN_ROUNDS/);
		}
		expect(BROWSER_RUN_ROUNDS).toBe(12);
	});
});
