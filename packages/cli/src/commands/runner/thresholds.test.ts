import { describe, expect, it } from "vitest";
import { formatThresholds, parseAssignments } from "./thresholds.js";

const GIB = 1024 ** 3;

describe("pags runner thresholds — key=value words into the partial body", () => {
	it("numbers set, null clears, and the GiB spellings become bytes", () => {
		expect(parseAssignments(["maxSessions=2", "cpuLoad1PerCpu=2.5", "memUsedPctMax=null", "diskFreeMinGiB=20", "memAvailableMinGiB=0.5"])).toEqual({
			body: { maxSessions: 2, cpuLoad1PerCpu: 2.5, memUsedPctMax: null, diskFreeMinBytes: 20 * GIB, memAvailableMinBytes: 0.5 * GIB },
		});
		expect(parseAssignments(["recoveryStreak="])).toEqual({ body: { recoveryStreak: null } });
	});

	it("names what is wrong: not key=value, an unknown key, a non-number — and nothing at all", () => {
		expect(parseAssignments(["2"])).toMatchObject({ error: expect.stringMatching(/not key=value/) });
		expect(parseAssignments(["=2"])).toMatchObject({ error: expect.stringMatching(/not key=value/) });
		expect(parseAssignments(["maxSession=2"])).toMatchObject({ error: expect.stringMatching(/Unknown threshold "maxSession"/) });
		expect(parseAssignments(["maxSessions=two"])).toMatchObject({ error: expect.stringMatching(/must be a number/) });
		expect(parseAssignments([])).toMatchObject({ error: expect.stringMatching(/at least one/) });
	});
});

describe("the answer as lines", () => {
	const answer = {
		maxSessions: { value: 2, source: "machine", formula: 1 },
		thresholds: { maxSessions: 2, cpuLoad1PerCpu: 1.5, cpuLoad5PerCpu: 1.2, memUsedPctMax: 92, memAvailableMinBytes: GIB, diskUsedPctMax: 95, diskFreeMinBytes: 10 * GIB, recoveryBand: 0.9, recoveryStreak: 2 },
		source: { cpuLoad1PerCpu: "default", memAvailableMinBytes: "default", diskFreeMinBytes: "machine" },
		overrides: { maxSessions: 2, diskFreeMinBytes: 10 * GIB },
		verdict: { gate: "rejecting:sessions", metric: "sessions" },
	};
	it("says the verdict, the session limit and the formula it replaced, and which values this machine sets", () => {
		const text = formatThresholds(answer).join("\n");
		expect(text).toContain("refusing new sessions (sessions)");
		expect(text).toMatch(/maxSessions\s+2\s+set for this machine \(formula: 1\)/);
		expect(text).toMatch(/diskFreeMinBytes\s+10 GiB\s+set for this machine/);
		expect(text).toMatch(/cpuLoad1PerCpu\s+1.5\s+default/);
	});
});
