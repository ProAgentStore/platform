import { describe, expect, it } from "vitest";
import { checkboxes, CLEANUP_ROWS, cleanNowState, formatBytes, type MachineCleanup, modeBody, modeDefaults, overrideBody, reportLines, runnerSupportsCleanup } from "./machineCleanup";

const cleanup = (over: Partial<MachineCleanup> = {}): MachineCleanup => ({
	mode: "gentle",
	behaviours: modeDefaults("gentle"),
	overrides: {},
	report: null,
	report_at: null,
	now_requested_at: null,
	now_done_at: null,
	...over,
});

describe("the six checkboxes", () => {
	it("are the six behaviours the issue names, in order, with a hint each", () => {
		expect(CLEANUP_ROWS.map((r) => r.key)).toEqual(["processGroupKill", "leftoverSweep", "browserCleanup", "tempCleanup", "loadWarning", "cachePruning"]);
		for (const r of CLEANUP_ROWS) expect(r.hint.length).toBeGreaterThan(10);
	});

	it("gentle: five on, cache pruning off — nothing overridden", () => {
		const boxes = checkboxes(cleanup());
		expect(boxes.map((b) => [b.key, b.checked, b.overridden])).toEqual([
			["processGroupKill", true, false],
			["leftoverSweep", true, false],
			["browserCleanup", true, false],
			["tempCleanup", true, false],
			["loadWarning", true, false],
			["cachePruning", false, false],
		]);
	});

	it("harsh: all six on", () => {
		expect(checkboxes(cleanup({ mode: "harsh", behaviours: modeDefaults("harsh") })).every((b) => b.checked && !b.overridden)).toBe(true);
	});

	it("marks a box that differs from the mode's default as overridden", () => {
		const boxes = checkboxes(cleanup({ mode: "harsh", behaviours: { ...modeDefaults("harsh"), cachePruning: false } }));
		expect(boxes.find((b) => b.key === "cachePruning")).toMatchObject({ checked: false, overridden: true });
		expect(boxes.filter((b) => b.overridden)).toHaveLength(1);
		const gentleExtra = checkboxes(cleanup({ behaviours: { ...modeDefaults("gentle"), cachePruning: true } }));
		expect(gentleExtra.find((b) => b.key === "cachePruning")).toMatchObject({ checked: true, overridden: true });
	});

	it("shows gentle defaults when an older API sends no cleanup block", () => {
		expect(checkboxes(undefined).map((b) => b.checked)).toEqual([true, true, true, true, true, false]);
		expect(checkboxes(null).every((b) => !b.overridden)).toBe(true);
	});
});

describe("what a click sends", () => {
	it("changing a box to something other than the mode's default is an override", () => {
		expect(overrideBody("harsh", "cachePruning", false)).toEqual({ cleanup_overrides: { cachePruning: false } });
		expect(overrideBody("gentle", "cachePruning", true)).toEqual({ cleanup_overrides: { cachePruning: true } });
		expect(overrideBody("gentle", "tempCleanup", false)).toEqual({ cleanup_overrides: { tempCleanup: false } });
	});
	it("putting a box back to the mode's default clears the override (null) rather than pinning it", () => {
		expect(overrideBody("harsh", "cachePruning", true)).toEqual({ cleanup_overrides: { cachePruning: null } });
		expect(overrideBody("gentle", "cachePruning", false)).toEqual({ cleanup_overrides: { cachePruning: null } });
	});
	it("the master toggle sends only the mode (the server resets the boxes)", () => {
		expect(modeBody("harsh")).toEqual({ cleanup_mode: "harsh" });
		expect(modeBody("gentle")).toEqual({ cleanup_mode: "gentle" });
	});
});

describe("clean now", () => {
	it("says nothing until asked, waits while asked, and reports when done", () => {
		expect(cleanNowState(cleanup())).toEqual({ pending: false, text: null });
		const asked = cleanNowState(cleanup({ now_requested_at: "2026-10-21T05:00:00.000Z" }));
		expect(asked.pending).toBe(true);
		expect(asked.text).toMatch(/next heartbeat/);
		const done = cleanNowState(cleanup({ now_requested_at: "2026-10-21T05:00:00.000Z", now_done_at: "2026-10-21T05:00:20.000Z" }));
		expect(done.pending).toBe(false);
		expect(done.text).toMatch(/finished/);
	});
	it("a new request after a finished one is pending again", () => {
		expect(cleanNowState(cleanup({ now_requested_at: "2026-10-21T06:00:00.000Z", now_done_at: "2026-10-21T05:00:20.000Z" })).pending).toBe(true);
	});
});

describe("the runner's report", () => {
	it("is empty without one", () => {
		expect(reportLines(null)).toEqual([]);
		expect(reportLines(undefined)).toEqual([]);
	});
	it("says what it found, what it left alone, and what its last pass did, including the bytes freed", () => {
		const lines = reportLines({
			mode: "harsh",
			orphanedProcesses: 3,
			orphans: [],
			loadMismatch: true,
			unexplainedLoad: 79.5,
			diskUsedPct: 95.4,
			warnings: [],
			lastPass: { at: null, reason: "requested from the console", killedProcesses: 2, orphansFound: 3, browsersReaped: 1, tempFoldersRemoved: 4, worktreesRemoved: 0, cachesPruned: 2, buildOutputsRemoved: 7, freedBytes: 3_500_000_000 },
		});
		expect(lines).toEqual([
			"3 leftover processes found and not touched",
			"disk 95.4% full",
			"load is 79.5 above what sessions account for",
			"last pass (requested from the console): ended 2 processes, reaped 1 browser, removed 4 temp folders, pruned 2 caches, removed 7 build outputs, freed 3.3 GB",
		]);
	});
	it("a pass that found nothing says so", () => {
		const lines = reportLines({ mode: "gentle", orphanedProcesses: 0, orphans: [], loadMismatch: false, unexplainedLoad: 0, diskUsedPct: null, warnings: [], lastPass: { at: null, reason: "session ended: s1", killedProcesses: 0, orphansFound: 0, browsersReaped: 0, tempFoldersRemoved: 0, worktreesRemoved: 0, cachesPruned: 0, buildOutputsRemoved: 0, freedBytes: null } });
		expect(lines).toEqual(["last pass (session ended: s1): nothing to clean"]);
	});
	it("formats sizes", () => {
		expect(formatBytes(null)).toBe("unknown");
		expect(formatBytes(512 * 1024)).toBe("512 KB");
		expect(formatBytes(5 * 1024 ** 2)).toBe("5 MB");
		expect(formatBytes(6.2 * 1024 ** 3)).toBe("6.2 GB");
	});
});

describe("runners that predate cleanup", () => {
	it("are told so; the first release that carries it and newer are not", () => {
		expect(runnerSupportsCleanup("0.4.166")).toBe(false);
		expect(runnerSupportsCleanup("0.4.99")).toBe(false);
		expect(runnerSupportsCleanup("0.3.200")).toBe(false);
		expect(runnerSupportsCleanup("0.4.167")).toBe(true);
		expect(runnerSupportsCleanup("0.4.200")).toBe(true);
		expect(runnerSupportsCleanup("0.5.0")).toBe(true);
		expect(runnerSupportsCleanup("1.0.0")).toBe(true);
	});
	it("an unknown or unparseable version is not accused", () => {
		for (const v of [undefined, null, "", "unknown", "0.4"]) expect(runnerSupportsCleanup(v)).toBe(true);
	});
});
