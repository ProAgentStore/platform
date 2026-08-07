import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loopStopControl, STOPPING_HINT } from "./loopStopState.js";

describe("loopStopControl", () => {
	it("THE BUG: a running run with a cancel pending is NOT just 'running'", () => {
		// The whole of #376: this row said "· running" and offered a live Stop button, for minutes,
		// after the server had already accepted the cancel.
		const ctl = loopStopControl({ status: "running", cancelRequested: true });
		expect(ctl.phase).toBe("stopping");
		expect(ctl.statusLabel).toBe("Stopping…");
		expect(ctl.canStop).toBe(false);
		expect(ctl.hint).toBe(STOPPING_HINT);
	});

	it("a live run stops and says so", () => {
		const ctl = loopStopControl({ status: "running" });
		expect(ctl.phase).toBe("running");
		expect(ctl.statusLabel).toBe("running");
		expect(ctl.actionLabel).toBe("Stop");
		expect(ctl.canStop).toBe(true);
		expect(ctl.hint).toBeNull();
	});

	it("an older server that omits the field reads as no cancel pending", () => {
		// Silently treating `undefined` as pending would freeze the Stop button on every run.
		expect(loopStopControl({ status: "running", cancelRequested: undefined }).canStop).toBe(true);
		expect(loopStopControl({ status: "running", cancelRequested: null }).canStop).toBe(true);
	});

	it("an ended run yields no status word — the caller knows the stop reason and we do not", () => {
		for (const status of ["completed", "failed", "needs_human", "cancelled"]) {
			const ctl = loopStopControl({ status });
			expect(ctl.phase).toBe("ended");
			expect(ctl.statusLabel).toBeNull();
			expect(ctl.canStop).toBe(false);
			expect(ctl.hint).toBeNull();
		}
	});

	it("a cancel flag on an ENDED run changes nothing — the wait is over", () => {
		// `cancel_requested` is never cleared, so every cancelled run carries it forever. Reading
		// the flag without the status would have left "Stopping…" on the row for good.
		expect(loopStopControl({ status: "cancelled", cancelRequested: true }).phase).toBe("ended");
	});

	it("no run at all is not a run that can be stopped", () => {
		expect(loopStopControl(null).phase).toBe("ended");
		expect(loopStopControl(undefined).canStop).toBe(false);
	});
});

/**
 * The regression guard for the actual defect.
 *
 * #376 was not a wrong resolver — it was that NO component asked one. `git grep cancelRequested`
 * across the console returned nothing while the field sat on the wire in every response. A unit
 * test of a pure function cannot catch that class on its own: the function can be perfect and
 * still be called by nobody.
 *
 * Source-scanning rather than a rendered assertion, for the reason `control-labels.test.ts` gives
 * — neither console has component-testing infrastructure and #282 decided deliberately against
 * adding one. "This surface routes its Stop control through the resolver" is a property of the
 * source, so it can be checked without rendering anything.
 */
describe("the surfaces that render a live run actually read the flag", () => {
	const CONSOLE_SRC = resolve(__dirname, "..");
	// The two places a running loop offers a Stop: the Settings-tab run list, and the chat header.
	const SURFACES = ["tabs/LoopRunsSection.tsx", "pages/InstanceDetail.tsx"];

	for (const rel of SURFACES) {
		it(`${rel} decides via loopStopControl, not on status alone`, () => {
			const src = readFileSync(resolve(CONSOLE_SRC, rel), "utf8");
			expect(src).toContain("loopStopControl");
			expect(src).toContain("loopStopState");
		});
	}
});
