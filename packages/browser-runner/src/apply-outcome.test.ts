/**
 * The runner's outcome→task disposition, and what keeps it total (#636).
 *
 * The defect was a NON-TOTAL mapping: a chain of `===` comparisons over ten possible outcomes
 * that named four of them and let the other six fall to `failed`. `cancelled` was one of the
 * six, so an application the owner deliberately Stopped was filed as an error, with a Retry
 * button on it, while the cloud's own run record for the same run said `cancelled`.
 *
 * So the denominator here is `ApplyOutcome`'s OWN declaration, read out of `apply-loop.ts`
 * (ADR 0002) rather than re-typed — the same technique `workers/api/src/lib/browser-run.test.ts`
 * uses one package over. A hand-written list of ten would pass forever while the union grew an
 * eleventh, which is the exact shape of the bug under test.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPLY_OUTCOME_DISPOSITION, dispositionForOutcome, isTerminalTaskStatus, settleTaskOutcome, TERMINAL_TASK_STATUSES } from "./apply-outcome.js";
import type { RunnerTask, TaskStatus } from "./types.js";

const DIR = dirname(fileURLToPath(import.meta.url));

/** Every member of the cloud's `ApplyOutcome`, from the union as written. */
function declaredOutcomes(): string[] {
	const src = readFileSync(join(DIR, "../../../workers/api/src/lib/apply-loop.ts"), "utf8");
	const decl = /export type ApplyOutcome =([^;]*);/.exec(src);
	if (!decl) throw new Error("could not find the ApplyOutcome declaration — this guard has stopped measuring");
	return [...decl[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** Every member of `TaskStatus`, from the union as written — the statuses a card can carry. */
function declaredTaskStatuses(): string[] {
	const src = readFileSync(join(DIR, "types.ts"), "utf8");
	const decl = /export type TaskStatus =([^;]*);/.exec(src);
	if (!decl) throw new Error("could not find the TaskStatus declaration — this guard has stopped measuring");
	return [...decl[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function taskAt(status: TaskStatus): RunnerTask {
	return {
		id: "task_1",
		type: "job.apply_agent",
		status,
		input: {},
		requiresApproval: false,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	};
}

describe("the runner's apply-outcome disposition", () => {
	const outcomes = declaredOutcomes();

	it("reads a plausible ApplyOutcome union — otherwise every assertion below is vacuous", () => {
		expect(outcomes.length, `ApplyOutcome declares ${outcomes.length} outcomes`).toBeGreaterThanOrEqual(10);
		expect(outcomes).toContain("cancelled");
		expect(outcomes).toContain("submitted");
	});

	it("covers every outcome the cloud can send — no more, no fewer", () => {
		// The assertion that reddens when the two packages drift. The runner re-declares
		// `ApplyOutcome` because it cannot import across the package boundary (see the module
		// header); this is the measurement that makes the copy safe rather than hopeful.
		expect(Object.keys(APPLY_OUTCOME_DISPOSITION).sort()).toEqual([...outcomes].sort());
	});

	it("only ever writes a status the board can render", () => {
		const statuses = declaredTaskStatuses();
		for (const outcome of outcomes) {
			expect(statuses, `${outcome} → unrenderable status`).toContain(dispositionForOutcome(outcome).status);
		}
	});

	it("files a run the owner stopped as cancelled, with no error and no task.failed", () => {
		// THE regression. Neuter the fix — delete the `cancelled` row from the table, or restore
		// the `outcome === "blocked" ? … : success ? … : "failed"` chain — and all three of these
		// go red: status becomes "failed", error becomes "stopped by the user", event becomes
		// "task.failed". The board then shows the card under Failed with a Retry button, which is
		// the user-visible harm #636 is about.
		const task = taskAt("running");
		const disposition = settleTaskOutcome(task, "cancelled", "stopped by the user");
		expect(task.status).toBe("cancelled");
		expect(task.error).toBeUndefined();
		expect(disposition.event).toBe("task.cancelled");
		expect(task.output).toEqual({ outcome: "cancelled", detail: "stopped by the user" });
		expect(task.completedAt).toBe(task.updatedAt);
	});

	it("leaves every other outcome exactly where it was before #636", () => {
		// The other half of the guarantee: this commit changed ONE row. A future edit that
		// "tidies" the table by, say, moving `blocked` under `failed` has to argue with this.
		const before: Record<string, { status: TaskStatus; error: boolean }> = {
			submitted: { status: "completed", error: false },
			ready: { status: "completed", error: false },
			expired: { status: "completed", error: false },
			blocked: { status: "blocked", error: true },
			captcha: { status: "failed", error: true },
			stuck: { status: "failed", error: true },
			needs_input: { status: "failed", error: true },
			failed: { status: "failed", error: true },
			max_steps: { status: "failed", error: true },
		};
		for (const [outcome, expected] of Object.entries(before)) {
			const disposition = dispositionForOutcome(outcome);
			expect({ status: disposition.status, error: disposition.error }, outcome).toEqual(expected);
		}
	});

	it("falls back to failed for an outcome this bundled runner has never heard of", () => {
		// The runner ships inside a CLI the user upgrades on their own schedule, so a newer cloud
		// can send a word this build does not know. `failed` is the honest reading, and it matches
		// the cloud's own `browserRunStopReason` fallback.
		expect(dispositionForOutcome("teleported")).toEqual(APPLY_OUTCOME_DISPOSITION.failed);
	});

	it("carries the outcome word as the error when no detail was sent", () => {
		const task = taskAt("running");
		settleTaskOutcome(task, "max_steps");
		expect(task.error).toBe("max_steps");
	});
});

describe("which statuses a Stop must not overwrite", () => {
	it("treats cancelled as terminal, alongside completed and failed", () => {
		// The member the old `task.status === "completed" || task.status === "failed"` pair missed.
		expect([...TERMINAL_TASK_STATUSES].sort()).toEqual(["cancelled", "completed", "failed"]);
		expect(isTerminalTaskStatus("cancelled")).toBe(true);
	});

	it("leaves a blocked or waiting task cancellable — Stop is the owner answering", () => {
		for (const status of ["queued", "running", "needs_approval", "needs_human", "blocked"] as const) {
			expect(isTerminalTaskStatus(status), status).toBe(false);
		}
	});
});
