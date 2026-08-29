/**
 * EVERY durable driver can be asked to stop, and the ask reaches it (#560 AC3).
 *
 * ── Why this guard exists rather than a third careful fix
 *
 * This is the THIRD time a remedy has been applied to a list of known sites and missed one:
 * #356 → #554 (the same defect twice), and now #540 → #560. `stop_work` shipped, was verified live,
 * and reached exactly one of the three autonomous workflows — because the thing it resolves through
 * (`agent_loop_runs`, via `lib/work-stop.ts` → `requestCancel`) is written by the CALLER that starts
 * the workflow, and only one caller wrote it. Nothing failed. Nothing warned. The tool simply
 * silently covered a third of what its description promises.
 *
 * The predicate, not the list, is what found it: `cc17c1d`'s budget guard asked the RECEIVING side's
 * question over every workflow class instead of over the two it knew about, and `BROWSER_TASK` fell
 * out the moment it was written. This guard asks the same shape of question about cancellation.
 *
 * ── The property
 *
 * A driver is stoppable when BOTH halves are present, and the halves fail differently:
 *
 *   1. its start path mints an `agent_loop_runs` row (`createLoopRun`) — without it `stop_work`
 *      resolves nothing and the run is unreachable, which is #560 exactly;
 *   2. its own source READS the cancellation — without it the flag is set on a row nobody consults
 *      and the tool reports "asked to stop" about a run that will never notice. That is the
 *      `retryable`-with-no-consumer shape #583 spent a commit removing, pointed the other way.
 *
 * ── ADR 0002
 *
 * The driver set is read from `workflows/` on disk and never hand-listed, and a file that is not a
 * driver has to be NAMED with its reason — the same two exemptions, verbatim, as
 * `driver-failure.test.ts` and `workflow-trace.test.ts`, because three guards over one set must not
 * be able to disagree about what the set IS. A rename therefore fails as "this guard has stopped
 * measuring" rather than passing as a clean tree.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripCommentsAndLiterals } from "../lib/source-guard.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(DIR, "..");

/**
 * A driver's source with its IMPORTS, comments and string literals removed.
 *
 * Written after watching this guard fail to fail. The first version asked whether the file
 * `includes` the symbol, and replacing the live call with `const stopped = false;` left the import
 * line behind — so the guard stayed green over a driver that had stopped reading its cancel
 * entirely. That is the ADR 0002 class the guard exists to prevent, reproduced inside the guard
 * itself, and it is why G4 is a rule: it passed on the day it was written, over a defect it was
 * written to catch.
 *
 * A mention is not a consumer. What counts is a CALL, in code.
 */
function callableSource(file: string): string {
	const raw = readFileSync(join(DIR, file), "utf8");
	return stripCommentsAndLiterals(raw)
		.split("\n")
		.filter((line) => !/^\s*import\b/.test(line))
		.join("\n");
}

/** Files in `workflows/` that are NOT durable drivers, each with the reason it is exempt. */
const NOT_A_DRIVER: Record<string, string> = {
	"coding-session-params.ts": "a params type — no run() and no I/O",
	"coding-watch.ts": "a mode of CodingSessionWorkflow, dispatched from its run(); its host owns the catch",
};

interface CancelPath {
	/** The symbol in the driver's own source that READS the owner's request to stop. */
	reads: string;
	/** Where the run row it resolves through is minted. */
	mintedBy: string;
	/** Worst-case latency between the ask and the driver noticing, and what bounds it. */
	latency: string;
}

/**
 * How each driver is stopped — and every `reads` value is checked against that file below, so an
 * entry cannot credit a driver with a consumer it does not reach.
 */
const CANCEL_PATHS: Record<string, CancelPath> = {
	"coding-session.ts": {
		reads: "isCancelRequested",
		mintedBy: "lib/loop-drivers.ts codingDriver",
		latency: "one Pilot round, or one 5-minute tick while parked (#541)",
	},
	"agent-loop.ts": {
		reads: "isCancelRequested",
		mintedBy: "lib/loop-drivers.ts chatDriver",
		latency: "one iteration — the flag is read at the top of each",
	},
	"job-apply.ts": {
		reads: "browserRunTick",
		mintedBy: "routes/instances-apply.ts startJobApply (#560)",
		latency: "one browser step, or one 5s handoff poll while waiting on a human (#560)",
	},
	"browser-task.ts": {
		reads: "browserRunTick",
		mintedBy: "routes/instances-browse.ts startBrowserTask (#560)",
		latency: "one browser step, or one 5s handoff poll while waiting on a human (#560)",
	},
	"pipeline-run.ts": {
		reads: "isCancelRequested",
		mintedBy: "lib/pipeline-run-start.ts startPipelineRun (#619)",
		latency: "one pipeline step — the flag is read at each step boundary before the next step starts",
	},
};

/**
 * Drivers that CANNOT be stopped, each with the reason and the ticket — the honest denominator.
 *
 * Empty: all five drivers are now stoppable (#619 fixed the last one).
 */
const NO_CANCEL_PATH: Record<string, string> = {};

const files = readdirSync(DIR)
	.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
	.sort();
const drivers = files.filter((f) => !NOT_A_DRIVER[f]);

describe("every durable driver can be stopped", () => {
	it("measures the whole workflows/ directory, and says how much", () => {
		// The denominator. Seven files today, five of them drivers, all five stoppable (#619) — and
		// the guard fails if it finds fewer, so a split that halves the set reports itself instead
		// of halving the measurement.
		expect(files.length, `workflows/ holds ${files.length} source files`).toBeGreaterThanOrEqual(7);
		expect(drivers.length, `of which ${drivers.length} are durable drivers`).toBeGreaterThanOrEqual(5);
		for (const f of Object.keys(NOT_A_DRIVER)) expect(files, `exemption for a missing file: ${f}`).toContain(f);
	});

	it("classifies exactly the drivers on disk — every one either stoppable or a named gap", () => {
		// Both directions, over the UNION. A driver in neither table is #560 returning on a sixth
		// workflow; an entry with no file credits a cancel path to code that is gone. Naming a gap
		// is allowed; leaving one unclassified is not.
		expect([...Object.keys(CANCEL_PATHS), ...Object.keys(NO_CANCEL_PATH)].sort(), "classified vs workflows/ on disk").toEqual([...drivers].sort());
	});

	it("says how many drivers can actually be stopped", () => {
		// G2: the number in the passing output. Five of five today (#619) — and if that ratio silently
		// became four of six, this line is where it would be visible.
		const stoppable = Object.keys(CANCEL_PATHS).length;
		expect(`${stoppable} of ${drivers.length} drivers are stoppable`).toBe(`5 of 5 drivers are stoppable`);
	});

	it.each(Object.keys(CANCEL_PATHS))("%s CALLS the cancellation the registry credits it with", (file) => {
		const { reads } = CANCEL_PATHS[file];
		// A call, not a mention — an import or a comment naming the symbol proves nothing.
		expect(callableSource(file).includes(`${reads}(`), `${file} never calls ${reads}() — ${CANCEL_PATHS[file].latency}`).toBe(true);
	});

	it.each(Object.keys(NO_CANCEL_PATH))("%s is a RECORDED gap, and still genuinely has no cancel path", (file) => {
		// The other direction: when somebody makes it stoppable, this fails and the entry has to
		// move — so the recorded gap cannot outlive the gap itself.
		expect(NO_CANCEL_PATH[file].length, `${file} has no stated reason`).toBeGreaterThan(20);
		expect(/isCancelRequested\(|browserRunTick\(/.test(callableSource(file)), `${file} now reads a cancel — move it to CANCEL_PATHS`).toBe(false);
	});

	it.each(Object.keys(CANCEL_PATHS))("%s states a bounded latency between the ask and the stop", (file) => {
		// A cancel path with no stated bound is how the handoff blind spot survived: apply DID
		// observe the runner's cancel flag, but only while snapshotting, so a stop arriving during a
		// 15-minute handoff wait was invisible for the whole wait and nobody had written that down.
		expect(CANCEL_PATHS[file].latency.length, `${file} has no stated latency`).toBeGreaterThan(20);
	});
});

describe("the two browser drivers are reachable at all", () => {
	// The half a source grep over `workflows/` cannot see: the run row is minted by the ROUTE, and
	// its absence is what made `stop_work` a no-op for these two while every workflow-side check
	// still passed.
	it.each([
		["routes/instances-apply.ts", "JOB_APPLY.create"],
		["routes/instances-browse.ts", "BROWSER_TASK.create"],
	])("%s mints a run row and hands its id to the workflow", (rel, create) => {
		const src = readFileSync(join(SRC, rel), "utf8");
		expect(src, `${rel} no longer mints an agent_loop_runs row`).toMatch(/createLoopRun\(/);
		const call = src.slice(src.indexOf(create));
		expect(call.slice(0, 400), `${rel} does not pass loopRunId to ${create}`).toMatch(/loopRunId/);
	});
});

describe("the pipeline driver is reachable at all (#619)", () => {
	// The same half `driver-cancel`'s source grep cannot see: `pipeline-run.ts` reads the flag,
	// but the flag only exists when the KICK path minted the row and passed `loopRunId` in.
	it("lib/pipeline-run-start.ts mints an agent_loop_runs row", () => {
		const src = readFileSync(join(SRC, "lib/pipeline-run-start.ts"), "utf8");
		expect(src, "pipeline-run-start.ts no longer calls createLoopRun").toMatch(/createLoopRun\(/);
	});

	it("lib/pipeline-run-start.ts passes loopRunId to PIPELINE_RUN.create", () => {
		const src = readFileSync(join(SRC, "lib/pipeline-run-start.ts"), "utf8");
		const call = src.slice(src.indexOf("PIPELINE_RUN.create"));
		expect(call.slice(0, 400), "pipeline-run-start.ts does not pass loopRunId to PIPELINE_RUN.create").toMatch(/loopRunId/);
	});
});

describe("the handoff wait is not a blind spot", () => {
	// The specific 15-minute window `cc17c1d` recorded and left open. Both drivers poll
	// `/browser/handoff-status` in a loop; the loop must be able to exit on a cancel, not only on a
	// solve or the poll cap.
	it.each(["job-apply.ts", "browser-task.ts"])("%s can leave its handoff poll on a cancel", (file) => {
		const src = readFileSync(join(DIR, file), "utf8");
		expect(src, `${file}'s handoff poll ignores cancellation`).toMatch(/browserRunPark/);
		expect(src, `${file}'s handoff poll cannot exit early`).toMatch(/&&\s*!stopped/);
	});
});
