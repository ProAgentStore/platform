import { describe, expect, it } from "vitest";
import { attribute, parsePs, readSessionResources } from "./session-resources.js";

const PS = `
    1     0   1000  0.0
  100     1  50000 12.5
  101   100  20000 80.0
  102   101   1000  5.0
  200     1  30000  1.0
  300     1   4000  0.5
garbage line
`;

describe("per-session resource attribution (#924)", () => {
	it("sums an engine and every descendant, and nothing else", () => {
		const out = attribute(parsePs(PS), [
			{ sessionId: "s-a", engineLabel: "claude:a", pid: 100 },
			{ sessionId: "s-b", engineLabel: "codex:b", pid: 200 },
		]);
		expect(out).toEqual([
			{ sessionId: "s-a", engineLabel: "claude:a", pid: 100, processes: 3, rssBytes: 71000 * 1024, cpuPct: 97.5 },
			{ sessionId: "s-b", engineLabel: "codex:b", pid: 200, processes: 1, rssBytes: 30000 * 1024, cpuPct: 1 },
		]);
	});

	it("omits a session whose engine is no longer in the table", () => {
		expect(attribute(parsePs(PS), [{ sessionId: "gone", engineLabel: "x", pid: 999 }])).toEqual([]);
	});

	it("reads the real process table for this test process", () => {
		if (process.platform === "win32") return;
		const out = readSessionResources([{ sessionId: "me", engineLabel: "node", pid: process.pid }]);
		expect(out?.[0]?.sessionId).toBe("me");
		expect(out?.[0]?.rssBytes).toBeGreaterThan(0);
	});
});
