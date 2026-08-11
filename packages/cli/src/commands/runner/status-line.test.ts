import { describe, expect, it } from "vitest";
import { formatStatusLine, parseStatusLine, STATUS_PREFIX } from "./status-line.js";

describe("the runner→TUI status line (#497)", () => {
	it("round-trips every field, reason last and with its spaces intact", () => {
		const line = formatStatusLine({ registration: "fail", agents: "0/3", reason: "fetch failed" });
		expect(parseStatusLine(line)).toEqual({ registration: "fail", agents: "0/3", reason: "fetch failed" });
	});

	it("distinguishes a partial registration from a total one — 6 of 19 is not 'registered'", () => {
		expect(parseStatusLine(formatStatusLine({ registration: "partial", agents: "6/19" })))
			.toEqual({ registration: "partial", agents: "6/19" });
	});

	it("carries the heartbeat as its OWN fact, not through registration", () => {
		expect(parseStatusLine(formatStatusLine({ heartbeat: "fail", reason: "fetch failed" })))
			.toEqual({ heartbeat: "fail", reason: "fetch failed" });
		expect(parseStatusLine(formatStatusLine({ heartbeat: "ok" }))).toEqual({ heartbeat: "ok" });
	});

	it("ignores ordinary prose — most of stdout is not a status line", () => {
		for (const line of [
			"Relay connected: 1a2b3c4d…",
			"  ✅ CONNECTED — WebSocket relay · RLs-MacBook-Air.local",
			"Runtime registered with PAGS ✓ (3/3 agents)",
			"",
			"PAGS-STATUSregistration=ok",
		]) {
			expect(parseStatusLine(line)).toBeNull();
		}
	});

	it("drops values it does not recognise rather than inventing a state", () => {
		expect(parseStatusLine(`${STATUS_PREFIX} registration=maybe heartbeat=meh agents=`)).toEqual({});
	});

	it("survives a multi-line reason — a thrown message can contain anything", () => {
		const line = formatStatusLine({ heartbeat: "fail", reason: "connect ECONNREFUSED\n  at Object.fetch" });
		expect(line.split("\n")).toHaveLength(1);
		expect(parseStatusLine(line)?.reason).toBe("connect ECONNREFUSED at Object.fetch");
	});
});
