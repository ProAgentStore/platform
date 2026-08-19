import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FINISHED_RUN_STATUSES, isRunFinished } from "./runStatus";

/** Strip comments before matching — see store/console/src/lib/surfaces.test.ts. */
function codeOf(relPath: string): string {
	return readFileSync(join(__dirname, relPath), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");
}

describe("what the console calls a finished run (#625, refs #611)", () => {
	it("names the three terminal statuses and nothing else", () => {
		expect([...FINISHED_RUN_STATUSES].sort()).toEqual(["cancelled", "completed", "failed"]);
	});

	it("does not name `expired`, which no row has ever carried", () => {
		// #611's production census of instance_runtime_tasks (404 rows) returned exactly these
		// seven statuses. `expired` is not a runner TaskStatus and both functions NAMED for expiry
		// write `failed`. Kept as the record of the measurement.
		const observedInProduction = ["completed", "failed", "cancelled", "running", "needs_human", "blocked", "queued"];
		for (const s of FINISHED_RUN_STATUSES) {
			expect(observedInProduction, `\`${s}\` is treated as finished but no row has ever carried it`).toContain(s);
		}
		expect([...FINISHED_RUN_STATUSES]).not.toContain("expired");
		expect(isRunFinished("expired")).toBe(false);
	});

	it("treats `blocked` as STILL RUNNING — it is waiting on the user", () => {
		// AC2. `isFinished` gates the "it will be stopped first" confirmation before a delete.
		// A blocked run is the one that is most emphatically still there to stop.
		expect(isRunFinished("blocked")).toBe(false);
		expect(isRunFinished("needs_human")).toBe(false);
		expect(isRunFinished("running")).toBe(false);
		expect(isRunFinished("queued")).toBe(false);
	});

	it("answers for the three that are over, and for no status at all", () => {
		expect(isRunFinished("completed")).toBe(true);
		expect(isRunFinished("cancelled")).toBe(true);
		expect(isRunFinished("failed")).toBe(true);
		// No task loaded yet: not finished, so the confirmation still fires.
		expect(isRunFinished(undefined)).toBe(false);
		expect(isRunFinished("")).toBe(false);
	});
});

describe("the console list and the api-side sweep are the same set", () => {
	it("equals CLEARED_RUNTIME_TASK_STATUSES, parsed from the Worker source", () => {
		// A mirror, not an import — the console bundle must not pull Worker source in. Same
		// arrangement as workers/mcp/src/state-vocabulary.test.ts across the same seam.
		const src = codeOf("../../../../workers/api/src/routes/instances-runtime.ts");
		const m = /export const CLEARED_RUNTIME_TASK_STATUSES = \[([^\]]+)\]/.exec(src);
		expect(m, "parsed no CLEARED_RUNTIME_TASK_STATUSES — the guard has stopped measuring").toBeTruthy();
		const apiSide = (m?.[1] ?? "").split(",").map((v) => v.trim().replace(/^"|"$/g, "")).filter(Boolean);
		expect(apiSide.length).toBeGreaterThan(0);
		// Deliberately IDENTICAL today. If a difference is ever wanted, the doc comment in
		// runStatus.ts is where it gets written down, and this assertion is where it gets relaxed
		// — one edit, with a reason attached, instead of two literals silently drifting.
		expect([...FINISHED_RUN_STATUSES].sort()).toEqual([...apiSide].sort());
	});
});

describe("RunDetail derives the answer instead of writing a fifth literal", () => {
	it("imports isRunFinished and holds no inline status list", () => {
		const page = codeOf("../pages/RunDetail.tsx");
		expect(page).toContain("isRunFinished");
		// The exact shape that was there: a bracketed literal list handed to `.includes`.
		expect(page).not.toMatch(/\["completed"[^\]]*\]\.includes/);
		expect(page).not.toContain('"expired"');
	});
});
