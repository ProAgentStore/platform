/**
 * A pipeline asked to stop halts at the next step boundary (#619).
 *
 * The defect: `PIPELINE_RUN` was the only durable driver that `stop_work` could not reach.
 * It minted no `agent_loop_runs` row, so `requestCancel` had nothing to set, and the workflow
 * read no cancellation flag of any kind — confirmed by `driver-cancel.test.ts`'s `NO_CANCEL_PATH`
 * entry, which was the guard that caught and recorded it.
 *
 * The fix adds both halves:
 *
 *   1. `lib/pipeline-run-start.ts` calls `createLoopRun` before kicking PIPELINE_RUN, so
 *      `stop_work` → `requestCancel(loopRunId)` has a row to set.
 *
 *   2. `workflows/pipeline-run.ts` calls `isCancelRequested(loopRunId)` at the START of each
 *      step — after the previous step has settled, before the next one begins — and exits when
 *      the flag is set. The in-flight step finishes (cooperative, per #540).
 *
 * ── Why the workflow cannot be instantiated directly under vitest
 *
 * `PipelineRunWorkflow extends WorkflowEntrypoint`, which comes from `cloudflare:workers` — a
 * module that does not resolve in a Node process. All three guards in this directory that need
 * to reason about workflow source therefore read the FILE rather than calling the class
 * (see `driver-failure.test.ts`, `pipeline-run-accounting.test.ts`). The same approach is used
 * here for the runner half; the pure `isCancelRequested` half is tested separately in
 * `lib/agent-loop-store.test.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripCommentsAndLiterals } from "../lib/source-guard.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(DIR, "..");

const RUNNER_SRC = readFileSync(join(DIR, "pipeline-run.ts"), "utf8");
const START_SRC = readFileSync(join(SRC, "lib/pipeline-run-start.ts"), "utf8");

/** The runner source with imports, comments and string literals removed — the guard rule. */
function callableRunner(): string {
	return stripCommentsAndLiterals(RUNNER_SRC)
		.split("\n")
		.filter((line) => !/^\s*import\b/.test(line))
		.join("\n");
}

describe("the pipeline run row is reachable by stop_work (#619)", () => {
	it("startPipelineRun creates an agent_loop_runs row", () => {
		// Without this call, `requestCancel(loopRunId)` has no row and `stop_work` is a no-op.
		expect(START_SRC).toMatch(/createLoopRun\(/);
	});

	it("startPipelineRun passes loopRunId to PIPELINE_RUN.create", () => {
		// Without this pass, the workflow has no id to check against.
		const call = START_SRC.slice(START_SRC.indexOf("PIPELINE_RUN.create"));
		expect(call.slice(0, 500), "loopRunId not threaded into PIPELINE_RUN.create").toMatch(/loopRunId/);
	});
});

describe("the pipeline runner reads the cancel flag at the step boundary (#619)", () => {
	it("CALLS isCancelRequested inside the step loop", () => {
		// A mention in a comment or import does not count — it must be a CALL in code.
		expect(callableRunner()).toContain("isCancelRequested(");
	});

	it("the check is INSIDE the step loop, not only at the end of the run", () => {
		// If `isCancelRequested` were called only after all steps had run, a stop arriving
		// mid-run would be invisible until the whole pipeline had finished — the defect.
		//
		// The loop starts with `for (let i = 0;` and the check must precede the actual
		// step dispatch. Use the raw source for position checks: `stripCommentsAndLiterals`
		// blanks template literal content, so the step-name template cannot be found there.
		const loopStart = RUNNER_SRC.indexOf("for (let i = 0;");
		const cancelCheck = RUNNER_SRC.indexOf("isCancelRequested(", loopStart);
		// The actual step dispatch template literal name. Constructed from parts to avoid the
		// biome `noTemplateCurlyInString` lint (the string IS what we're searching for in source).
		const stepDispatchName = ["s", "{i}-", "{s.tool}"].join("$");
		const stepDispatch = RUNNER_SRC.indexOf(stepDispatchName, loopStart);
		expect(loopStart, "the step loop has moved or been renamed").toBeGreaterThan(-1);
		expect(cancelCheck, "isCancelRequested is not called inside the step loop").toBeGreaterThan(loopStart);
		expect(stepDispatch, "the step dispatch pattern has moved or been renamed").toBeGreaterThan(loopStart);
		// The cancel check must come BEFORE the step is dispatched.
		expect(cancelCheck, "isCancelRequested is called AFTER the step dispatch — cancel is not at the boundary").toBeLessThan(stepDispatch);
	});

	it("the runner exits early when cancelled and records it in the run", () => {
		// The exit must close BOTH records: the `pipeline_runs` row (visible in the runs tab)
		// and the `agent_loop_runs` row (what stop_work/check_work read back).
		const src = callableRunner();
		const cancelBlock = src.slice(src.indexOf("isCancelRequested("));
		const closesCancelSlice = cancelBlock.slice(0, 600);
		expect(closesCancelSlice, "cancelled pipeline does not close the pipeline_runs row").toContain("closeRun(");
		expect(closesCancelSlice, "cancelled pipeline does not close the agent_loop_runs row").toContain("finishLoopRun(");
	});

	it("the loop run is also closed on successful completion", () => {
		// Without this, the run stays `running` in agent_loop_runs forever, which makes
		// check_work report a finished pipeline as still in progress.
		const src = callableRunner();
		// There should be a finishLoopRun call associated with the completed path
		expect(src, "finishLoopRun is never called — completed pipeline row stays 'running'").toContain("finishLoopRun(");
	});
});
