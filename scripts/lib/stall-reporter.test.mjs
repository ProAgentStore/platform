import { describe, expect, it } from "vitest";
import { join } from "node:path";
import StallReporter, { DEFAULT_STALL_MS, findStalled, stallMessage } from "./stall-reporter.mjs";

describe("stall reporter (#1665)", () => {
	const running = new Map([
		["a.test.ts", { lastEventAt: 1_000, lastTest: "suite > hangs" }],
		["b.test.ts", { lastEventAt: 9_000, lastTest: undefined }],
	]);

	it("reports only the files silent for the whole limit", () => {
		expect(findStalled(running, 10_000, 5_000)).toEqual([{ file: "a.test.ts", lastTest: "suite > hangs", silentMs: 9_000 }]);
		expect(findStalled(running, 10_000, 60_000)).toEqual([]);
	});

	it("the limit is above the longest test budget in the repo (125s)", () => {
		expect(DEFAULT_STALL_MS).toBeGreaterThan(2 * 125_000);
	});

	it("names the file and the last test started", () => {
		expect(stallMessage({ file: "a.test.ts", lastTest: "suite > hangs", silentMs: 300_000 })).toContain('STALLED  a.test.ts has reported nothing for 300s.\n  Last test it reported starting: "suite > hangs"');
	});

	it("says where to look when no test had started", () => {
		expect(stallMessage({ file: "b.test.ts", lastTest: undefined, silentMs: 300_000 })).toContain("first tests or a beforeAll");
	});

	it("an event delivered after its module ended does not put the finished file back (#1690)", () => {
		const reporter = new StallReporter();
		const module = { moduleId: join(process.cwd(), "a.test.ts") };
		reporter.onTestModuleStart(module);
		reporter.onTestCaseReady({ module, fullName: "suite > first" });
		expect([...reporter.running.keys()]).toEqual(["a.test.ts"]);
		reporter.onTestModuleEnd(module);
		reporter.onTestCaseReady({ module, fullName: "suite > late" });
		reporter.onTestCaseResult({ module });
		reporter.onTestSuiteResult({ module });
		expect(reporter.running.size).toBe(0);
		// The same file run again (watch mode) is a new module object, and is watched.
		reporter.onTestModuleStart({ moduleId: module.moduleId });
		expect([...reporter.running.keys()]).toEqual(["a.test.ts"]);
	});
});
