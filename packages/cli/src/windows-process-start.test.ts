import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHolder, isTakeable, type HolderFacts } from "./runner-lock.js";
import { windowsProcessStartedAt } from "./windows-process-start.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const run = vi.mocked(execFileSync);
const started = "20261113101355.455690+660";
const facts = (actual: string): HolderFacts => ({
	lock: { v: 1, pid: 123, pidStartedAt: started, rsid: "holder" } as HolderFacts["lock"],
	pidAlive: true,
	pidStartedAt: actual,
	healthRsid: null,
});

beforeEach(() => vi.resetAllMocks());

describe("Windows CIM process identity (#1650)", () => {
	it("reads the requested PID without WMIC and keeps the legacy DMTF identity format", () => {
		run.mockReturnValue(`${started}\r\n`);
		expect(windowsProcessStartedAt(123)).toBe(started);
		expect(run).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining([
			"-NoProfile", "-NonInteractive", expect.stringContaining("-Filter 'ProcessId=123'"),
		]), expect.objectContaining({ timeout: 4000, windowsHide: true }));
		expect(classifyHolder(facts(windowsProcessStartedAt(123)))).toBe("unresponsive");
	});

	it("only a different OS creation time proves PID reuse", () => {
		run.mockReturnValue("20261113111355.455690+660");
		expect(classifyHolder(facts(windowsProcessStartedAt(123)))).toBe("dead");
	});

	it.each(["", "CreationDate=unknown", `${started}\n${started}`, "Access denied"])("unknown evidence %j leaves a live holder untakeable", (output) => {
		run.mockReturnValue(output);
		expect(windowsProcessStartedAt(123)).toBe("");
		expect(isTakeable(classifyHolder(facts(windowsProcessStartedAt(123))))).toBe(false);
	});

	it("unavailable PowerShell, timeout or CIM failure leaves ownership unknown", () => {
		run.mockImplementation(() => { throw new Error("CIM unavailable"); });
		expect(windowsProcessStartedAt(123)).toBe("");
		expect(isTakeable(classifyHolder(facts(windowsProcessStartedAt(123))))).toBe(false);
	});

	it.each([0, -1, NaN, 1.5, Infinity])("rejects invalid PID %s without running a command", (pid) => {
		expect(windowsProcessStartedAt(pid)).toBe("");
		expect(run).not.toHaveBeenCalled();
	});
});
