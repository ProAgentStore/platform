/**
 * A step that counted failures must reach the RUN, not stop at its own JSON body (#642, #630).
 *
 * Two properties, and neither can be checked by calling anything: `PipelineRunWorkflow` cannot be
 * constructed under vitest (`cloudflare:workers` does not resolve), which is why `driver-failure` and
 * `coding-failure` read their catch regions off disk too. So the runner half is asserted over the
 * source, and the pure half (`partialFailure`) is asserted by calling it in `lib/pipeline.test.ts`.
 *
 * The property that matters is a NEGATIVE one, and the reason it needs a guard rather than a
 * comment: `enrich` already counted its per-item failures and already wrote them into its output —
 * the defect was entirely in where they went. A future step that reports a `failed` count the same
 * way will be just as silent unless something makes the connection, so the second arm below derives
 * the set of such steps from `steps.ts` and requires each to be wired, with the denominator stated
 * per ADR 0002.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER = readFileSync(join(DIR, "pipeline-run.ts"), "utf8");
const STEPS = readFileSync(join(DIR, "../lib/steps.ts"), "utf8");
const PIPELINE = readFileSync(join(DIR, "../lib/pipeline.ts"), "utf8");

describe("the runner folds a step's partial failures into the run (#642)", () => {
	it("adds them to `errors`, so a run cannot report 0 while a step counted failures", () => {
		expect(RUNNER).toContain("errors += partial.failed");
	});

	it("asks BEFORE it closes the run — an accounting that lands after the close is not accounting", () => {
		const asked = RUNNER.indexOf("partialFailure(");
		const closed = RUNNER.indexOf('closeRun(env, runId, "completed"');
		expect(asked, "the runner never calls partialFailure").toBeGreaterThan(-1);
		expect(closed, "the completed close moved or was renamed — this guard has stopped measuring").toBeGreaterThan(-1);
		expect(asked).toBeLessThan(closed);
	});

	it("carries the note into the run's detail line, where the console reads it", () => {
		// The same call #394 made for a cap: a warn event alone is only found by someone who
		// already suspects something, and `errors: 40` with no cause is not debuggable.
		const close = RUNNER.slice(RUNNER.indexOf('closeRun(env, runId, "completed"'));
		const detail = close.slice(0, close.indexOf("\n"));
		expect(detail, "the completed run's detail line no longer carries the partial-failure note").toContain("partialNote");
		// The cap note beside it, so a rewrite of this line cannot quietly drop #394's while adding this one.
		expect(detail).toContain("capNote");
	});

	it("puts the numbers in the trace event's `context`, which is not truncated", () => {
		// `message` is cut at 160 characters upstream — putting the count back into a message would
		// reproduce the bug one layer out.
		const event = RUNNER.slice(RUNNER.indexOf('event: "pipeline.partial"'));
		const line = event.slice(0, event.indexOf("\n"));
		expect(line).toContain("failed: partial.failed");
		expect(line).toContain("firstError: partial.firstError");
	});
});

describe("every step that reports a `failed` count is wired to the run", () => {
	/** Each `TOOL_CATALOG` entry in steps.ts, as `name → its source segment`. */
	function catalogSegments(): Map<string, string> {
		const out = new Map<string, string>();
		const marks = [...STEPS.matchAll(/^\t\tname: "([a-z_]+)",$/gm)];
		for (const [i, m] of marks.entries()) {
			const start = m.index ?? 0;
			out.set(m[1], STEPS.slice(start, marks[i + 1]?.index ?? STEPS.length));
		}
		return out;
	}

	const segments = catalogSegments();

	it("measures the whole catalog — a parse that finds nothing would pass every arm below", () => {
		expect(segments.size, "step tools parsed out of steps.ts").toBe(12);
		expect([...segments.keys()]).toContain("enrich");
	});

	/**
	 * Every object literal a segment hands to `JSON.stringify` — brace-matched rather than
	 * line-matched, because a handler is free to wrap its return across lines (`dedupe_upsert` now
	 * does) and a regex that assumes one line would silently stop seeing it, which is this guard
	 * failing open on exactly the step it was written for.
	 */
	function serialisedObjects(src: string): string[] {
		const out: string[] = [];
		for (const m of src.matchAll(/JSON\.stringify\(\s*/g)) {
			let i = (m.index ?? 0) + m[0].length;
			if (src[i] !== "{") continue;
			let depth = 0;
			const start = i;
			for (; i < src.length; i++) {
				if (src[i] === "{") depth++;
				else if (src[i] === "}" && --depth === 0) break;
			}
			out.push(src.slice(start, i + 1));
		}
		return out;
	}

	it("PARTIAL_FAILURE_TOOLS lists exactly the steps whose output carries `failed`", () => {
		const reporting = [...segments]
			.filter(([, src]) => serialisedObjects(src).some((obj) => /[\s,{]failed\s*[,:}]/.test(obj)))
			.map(([name]) => name)
			.sort();
		const declared = (PIPELINE.match(/const PARTIAL_FAILURE_TOOLS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "")
			.split(",")
			.map((s) => s.trim().replace(/"/g, ""))
			.filter(Boolean)
			.sort();
		// Not "is enrich in the set" — the failure mode is a NEW step reporting `failed` into a body
		// nobody reads, which is exactly how this one lived in production for months.
		expect(declared).toEqual(reporting);
	});
});
