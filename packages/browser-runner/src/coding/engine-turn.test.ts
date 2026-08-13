import { describe, expect, it } from "vitest";
import { MAX_TURN_DETAIL, turnReportFromExit, turnReportFromResult } from "./engine-turn.js";

/**
 * The rule that turns a process exit into a verdict (#545), tested without spawning anything.
 *
 * `headless.test.ts` proves the wiring against real child processes; this proves the judgement,
 * which is the part that will be edited later by someone who does not want to wait 18 seconds to
 * find out they got the kill case backwards.
 */
describe("turnReportFromExit — the exit code becomes a verdict", () => {
	it("exit 0 is ok; a non-zero exit is the ENGINE's own failure", () => {
		expect(turnReportFromExit(0, null, "done: hi", 1000)).toEqual({ verdict: "ok", exitCode: 0, signal: null, at: 1000, detail: "done: hi" });
		expect(turnReportFromExit(1, null, "Not inside a trusted directory", 1000)).toMatchObject({ verdict: "failed", exitCode: 1 });
	});

	it("a SIGNAL outranks the code — a turn we killed says nothing about the engine", () => {
		// The wedge ceiling (#391) SIGTERMs a process that never exits, and `interrupt()` SIGINTs one
		// a human aborted. Both arrive here with a null code. Reading either as an engine failure
		// would let three slow builds, or three Stop presses, read as a broken CLI.
		expect(turnReportFromExit(null, "SIGTERM", "wedged: hang", 5)).toMatchObject({ verdict: "killed", exitCode: null, signal: "SIGTERM" });
		expect(turnReportFromExit(137, "SIGKILL", "", 5)).toMatchObject({ verdict: "killed" });
	});

	it("carries the engine's own last line, capped, and omits the field when there is none", () => {
		const long = turnReportFromExit(1, null, "x".repeat(MAX_TURN_DETAIL + 50));
		expect(long.detail).toHaveLength(MAX_TURN_DETAIL);
		// Absent, not "" — an empty string in a report reads as "the engine said nothing", which is
		// a claim; the missing key is the honest shape for "nothing was captured".
		expect(turnReportFromExit(1, null, "   ")).not.toHaveProperty("detail");
	});
});

describe("turnReportFromResult — the structured path's analogue", () => {
	it("takes the verdict from is_error, with no exit code to take it from", () => {
		expect(turnReportFromResult(true, "error_during_execution", 7)).toEqual({
			verdict: "failed",
			exitCode: null,
			signal: null,
			at: 7,
			detail: "error_during_execution",
		});
		expect(turnReportFromResult(false, "", 7)).toEqual({ verdict: "ok", exitCode: null, signal: null, at: 7 });
	});
});
