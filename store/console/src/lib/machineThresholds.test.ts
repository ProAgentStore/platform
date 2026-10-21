import { describe, expect, it } from "vitest";
import { fieldProblem, type MachineThresholds, THRESHOLD_ROWS, thresholdFields, thresholdsBody, verdictLine } from "./machineThresholds";

const GIB = 1024 ** 3;
const base = (over: Partial<MachineThresholds> = {}): MachineThresholds => ({
	machineId: "m1",
	maxSessions: { value: 1, source: "formula", formula: 1 },
	thresholds: { maxSessions: 1, cpuLoad1PerCpu: 1.5, cpuLoad5PerCpu: 1.2, memUsedPctMax: 92, memAvailableMinBytes: GIB, diskUsedPctMax: 95, diskFreeMinBytes: 10 * GIB, recoveryBand: 0.9, recoveryStreak: 2 },
	source: { maxSessions: "default", cpuLoad1PerCpu: "default", cpuLoad5PerCpu: "default", memUsedPctMax: "default", memAvailableMinBytes: "default", diskUsedPctMax: "default", diskFreeMinBytes: "default", recoveryBand: "default", recoveryStreak: "default" },
	overrides: {},
	verdict: { gate: "accepting" },
	...over,
});

describe("the fields", () => {
	it("are the nine the API takes, each with a hint", () => {
		expect(THRESHOLD_ROWS.map((r) => r.key)).toEqual(["maxSessions", "cpuLoad1PerCpu", "cpuLoad5PerCpu", "memUsedPctMax", "memAvailableMinBytes", "diskUsedPctMax", "diskFreeMinBytes", "recoveryBand", "recoveryStreak"]);
		for (const r of THRESHOLD_ROWS) expect(r.hint.length).toBeGreaterThan(10);
	});

	it("show the value in force (bytes as GiB), and mark what this machine sets", () => {
		const f = thresholdFields(base({ maxSessions: { value: 2, source: "machine", formula: 1 }, overrides: { maxSessions: 2 } }));
		expect(f.find((x) => x.row.key === "maxSessions")).toMatchObject({ value: "2", overridden: true, note: "the formula would give 1" });
		expect(f.find((x) => x.row.key === "diskFreeMinBytes")).toMatchObject({ value: "10", overridden: false });
		expect(f.find((x) => x.row.key === "memAvailableMinBytes")?.value).toBe("1");
	});

	it("with no override the session limit says it is the formula's", () => {
		expect(thresholdFields(base()).find((x) => x.row.key === "maxSessions")?.note).toBe("the cores/memory formula gives 1");
	});
});

describe("validation and the partial body", () => {
	const row = (k: string) => THRESHOLD_ROWS.find((r) => r.key === k)!;
	it("refuses non-numbers, fractions for whole numbers, and out-of-range values", () => {
		expect(fieldProblem(row("maxSessions"), "two")).toMatch(/must be a number/);
		expect(fieldProblem(row("maxSessions"), "2.5")).toMatch(/whole number/);
		expect(fieldProblem(row("maxSessions"), "0")).toMatch(/from 1 to 64/);
		expect(fieldProblem(row("recoveryBand"), "1")).toMatch(/from 0.5 to 0.99/);
		expect(fieldProblem(row("maxSessions"), "2")).toBeNull();
		expect(fieldProblem(row("maxSessions"), "")).toBeNull();
	});

	it("sends only what changed, in the API's units", () => {
		expect(thresholdsBody(base(), { maxSessions: "2", cpuLoad1PerCpu: "1.5", diskFreeMinBytes: "20" })).toEqual({ maxSessions: 2, diskFreeMinBytes: 20 * GIB });
	});

	it("an emptied field that this machine overrides goes back to the default; an emptied one it does not is left alone", () => {
		const t = base({ maxSessions: { value: 2, source: "machine", formula: 1 }, thresholds: { ...base().thresholds, maxSessions: 2 }, overrides: { maxSessions: 2 } });
		expect(thresholdsBody(t, { maxSessions: "", memUsedPctMax: "" })).toEqual({ maxSessions: null });
	});

	it("never sends a field that is invalid", () => {
		expect(thresholdsBody(base(), { maxSessions: "0", recoveryStreak: "3" })).toEqual({ recoveryStreak: 3 });
	});
});

describe("the verdict line", () => {
	it("says accepting, or what is refusing and how far it is from reopening", () => {
		expect(verdictLine(base())).toBe("Accepting new sessions");
		expect(verdictLine(base({ verdict: { gate: "rejecting:cpu", metric: "cpu", recoveryStreak: 1 } }))).toBe("Refusing new sessions — cpu over its line, 1 clear sample so far");
		expect(verdictLine(null)).toBe("");
	});
});
