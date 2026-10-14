/**
 * The owner's browser-screenshot switch reaches both browser workflow drivers (#1064).
 *
 * `JobApplyWorkflow` and `BrowserTaskWorkflow` extend `WorkflowEntrypoint` from `cloudflare:workers`,
 * which does not resolve in Node, so — like `pipeline-cancel.test.ts` and `driver-failure.test.ts` —
 * this reads the FILES. What it pins, per driver: the flag is read from the run's own params (fixed at
 * start), the runner is told not to take a frame on every `/browser/act`, a frame that arrives anyway is
 * never handed to the store, and the task's trace says screenshots were off and why. The runner half
 * (`browserAct` takes no shot) is tested in the runner; the storage half in `browser-artifacts.test.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = dirname(fileURLToPath(import.meta.url));
const DRIVERS = ["browser-task.ts", "job-apply.ts"] as const;

describe.each(DRIVERS)("%s honours screenshots OFF", (file) => {
	const src = readFileSync(join(DIR, file), "utf8");

	it("reads the switch from the run's own params — the value fixed when the task started", () => {
		expect(src).toContain("const shotsOff = event.payload.screenshots === false;");
	});

	it("tells the runner to take no frame on EVERY browser action", () => {
		const acts = src.match(/callRunner<[^>]*>\(conn, "\/browser\/act", \{[^\n]*\}\)/g) ?? [];
		expect(acts.length).toBeGreaterThan(0);
		for (const act of acts) expect(act).toContain("...(shotsOff ? { screenshot: false } : {})");
	});

	it("never hands a frame to the store when off, whatever the runner returned", () => {
		const stores = src.split("storeWorkflowShot(").length - 1;
		expect(stores).toBeGreaterThan(0);
		expect(src.split("if (r.screenshot && !shotsOff)").length - 1).toBe(stores);
	});

	it("records in the task's trace that screenshots were off, and why — nothing else", () => {
		expect(src).toContain('step.do("screenshots-off-notice"');
		expect(src).toMatch(/type: "screenshots\.off"[^\n]*\n?[^\n]*data: \{ reason: SCREENSHOTS_OFF_REASON \}/);
	});
});
