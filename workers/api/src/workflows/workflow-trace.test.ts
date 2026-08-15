/**
 * Every durable driver writes to the unified trace — stated over the WHOLE set (#580 AC4).
 *
 * The defect was not that one file was missing a log line. It was that the question "which drivers
 * record what they did?" had never been asked as a set, so the flagship agent's driver could sit at
 * zero while its four peers averaged five, and nothing said so. `grep -c` found it by hand once;
 * this is what asks every time.
 *
 * Per ADR 0002 the denominator is an assertion, not a by-product: the guard fails if it finds fewer
 * workflow files than it knows exist, so a rename or a moved directory reports that the guard has
 * stopped measuring rather than that the tree is clean.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Files in `workflows/` that are NOT durable drivers, each with the reason it is exempt.
 *
 * A named list rather than a pattern: adding a driver must not be able to silently exempt it, and a
 * file that stops matching a pattern is exactly how a denominator shrinks without anybody noticing.
 */
const NOT_A_DRIVER: Record<string, string> = {
	"coding-session-params.ts": "a params type — no run() and no I/O",
	"coding-watch.ts": "a mode of CodingSessionWorkflow, dispatched from its run(); traced by its host",
};

/**
 * Anything that puts a durable row where `agent_trace` / `list_errors` can read it.
 *
 * `recordCodingFailure(` is deliberately NOT on this list. It IS a trace writer, and accepting it
 * would have made this guard pass on the tree that produced #580: `coding-session.ts` called it and
 * nothing else, so a run that CRASHED was recorded and a run that merely stopped was not. A guard
 * satisfied by the crash path alone certifies exactly the ground the incident walked.
 */
const TRACE_WRITERS = ["logEvent(", "logError(", "traceCodingRun("];

const files = readdirSync(DIR)
	.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
	.sort();

describe("the durable drivers all record what they did", () => {
	it("measures the whole workflows/ directory, and says how much", () => {
		// G1/G2. The number is the evidence: seven files today, five of them drivers. A future split
		// that halves this list fails here instead of quietly halving the guard.
		expect(files.length, `workflows/ holds ${files.length} source files`).toBeGreaterThanOrEqual(7);
		const drivers = files.filter((f) => !NOT_A_DRIVER[f]);
		expect(drivers.length, `of which ${drivers.length} are durable drivers`).toBeGreaterThanOrEqual(5);
		// Every exemption names a file that exists. An exemption for a deleted file is a hole.
		for (const f of Object.keys(NOT_A_DRIVER)) expect(files, `exemption for a missing file: ${f}`).toContain(f);
	});

	it.each(files.filter((f) => !NOT_A_DRIVER[f]))("%s writes to the trace", (file) => {
		// `coding-session.ts` is the case this was written for: it held ZERO trace writes while
		// browser-task held 6, job-apply 6, pipeline-run 7 and agent-loop 3, so a coding run that
		// merely stopped left no durable record at all and the pane was the only account of it.
		const src = readFileSync(join(DIR, file), "utf8");
		const found = TRACE_WRITERS.filter((w) => src.includes(w));
		expect(found.length, `${file} calls none of ${TRACE_WRITERS.join(", ")}`).toBeGreaterThan(0);
	});

	it("the coding driver records a run's LIFECYCLE, not only its crashes", () => {
		// The distinction #580 measured. `recordCodingFailure` alone is not enough: it fires on a
		// classified crash, and run 70ea298e neither crashed nor recorded anything for 4.35 hours.
		// A start and an end are what make "what happened to this run" answerable without the pane.
		const src = readFileSync(join(DIR, "coding-session.ts"), "utf8");
		expect(src).toContain("coding.run.start");
		expect(src).toContain("coding.run.end");
	});
});
