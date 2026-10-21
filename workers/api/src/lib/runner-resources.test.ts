/**
 * The machine resource sample (#924): what is accepted from a runner, and what the platform says
 * about it.
 */
import { describe, expect, it } from "vitest";
import { CPU_HIGH_WATER, MEMORY_HIGH_WATER_PCT, memoryPressurePct, parseResourceSample, resourcesView } from "./runner-resources.js";

const GiB = 1024 ** 3;
const sample = (over: Record<string, unknown> = {}) => ({ loadAvg: [1, 0.8, 0.5], cpus: 8, memTotalBytes: 16 * GiB, memFreeBytes: 8 * GiB, platform: "linux", sampledAt: Date.UTC(2026, 9, 5, 6, 0), ...over });

describe("parseResourceSample — the runner is a system boundary", () => {
	it("accepts a well-formed sample, as an object or as its stored JSON", () => {
		expect(parseResourceSample(sample())).toMatchObject({ cpus: 8, platform: "linux" });
		expect(parseResourceSample(JSON.stringify(sample()))).toMatchObject({ cpus: 8 });
	});

	it.each([
		["nothing (a CLI before 0.4.71)", undefined],
		["unparseable JSON", "{oops"],
		["two load averages", sample({ loadAvg: [1, 2] })],
		["a negative load", sample({ loadAvg: [-1, 0, 0] })],
		["NaN", sample({ cpus: Number.NaN })],
		["zero cores", sample({ cpus: 0 })],
		["more free memory than there is", sample({ memFreeBytes: 32 * GiB })],
		["no timestamp", sample({ sampledAt: undefined })],
		["a string where a number goes", sample({ memTotalBytes: "16G" })],
	])("rejects %s", (_why, raw) => {
		expect(parseResourceSample(raw)).toBeNull();
	});

	it("keeps how the runner was launched — including `pags up --background` (#499) — and drops a kind it does not know", () => {
		const runner = (launch: string) => ({ startedAt: 1, uptimeSec: 1, starts24h: 1, relayReconnects: 0, launch });
		expect(parseResourceSample(sample({ runner: runner("background") }))?.runner?.launch).toBe("background");
		expect(parseResourceSample(sample({ runner: runner("tty") }))?.runner?.launch).toBe("tty");
		expect(parseResourceSample(sample({ runner: runner("daemon") }))?.runner?.launch).toBeUndefined();
	});

	it("#1154: keeps what restarts the runner if it dies — service, launcher or none — into the view; drops anything else", () => {
		const runner = (supervisor: unknown) => ({ startedAt: 1, uptimeSec: 1, starts24h: 1, relayReconnects: 0, supervisor });
		for (const s of ["service", "launcher", "none"]) {
			const parsed = parseResourceSample(sample({ runner: runner(s) }));
			expect(parsed?.runner?.supervisor).toBe(s);
			expect(resourcesView(parsed, 0)?.runner?.supervisor).toBe(s);
		}
		expect(parseResourceSample(sample({ runner: runner("systemd") }))?.runner?.supervisor).toBeUndefined();
		expect(parseResourceSample(sample({ runner: runner(undefined) }))?.runner?.supervisor).toBeUndefined(); // an older CLI: unknown
	});

	it("#1157: carries when the runner's sign-in expires, and warns once it is close enough that a refresh must have failed", () => {
		const at = Date.UTC(2026, 9, 5, 6, 0);
		const runner = (sessionExpiresAt?: number) => ({ startedAt: 1, uptimeSec: 1, starts24h: 1, relayReconnects: 0, sessionExpiresAt });
		const view = (expires?: number) => resourcesView(sample({ runner: runner(expires) }), 0);
		expect(view(at + 20 * 86_400_000)?.runner?.sessionExpiresAt).toBe(new Date(at + 20 * 86_400_000).toISOString());
		expect(view(at + 20 * 86_400_000)?.warnings.join(" ")).not.toMatch(/sign-in/);
		expect(view(at + 30 * 3_600_000)?.warnings.join(" ")).toMatch(/sign-in expires in 30 hours and has not refreshed itself.*pags login --device/);
		expect(view(at - 1)?.warnings.join(" ")).toMatch(/sign-in has expired: it is signed out/);
		expect(view(undefined)?.runner?.sessionExpiresAt).toBeUndefined(); // an older CLI says nothing — and is not warned about
	});
});

describe("resourcesView — what list_runner_nodes and coding_diagnostics report", () => {
	it("reports a quiet machine with no warnings, and the sessions it was given", () => {
		const v = resourcesView(sample(), 2);
		expect(v).toMatchObject({ load1: 1, cpus: 8, loadPerCpu: 0.13, memUsedPct: 50, activeSessions: 2, warnings: [], sampledAt: "2026-10-05T06:00:00.000Z" });
	});

	it("is null — not a zero reading — when the runner reported nothing", () => {
		expect(resourcesView(null, 3)).toBeNull();
	});

	it("warns when the 1-minute load per core reaches the high-water mark, on every platform", () => {
		for (const platform of ["linux", "darwin"]) {
			const v = resourcesView(sample({ loadAvg: [8 * CPU_HIGH_WATER, 6, 4], platform }), null);
			expect(v?.warnings).toHaveLength(1);
			expect(v?.warnings[0]).toMatch(/^CPU saturated/);
		}
		expect(resourcesView(sample({ loadAvg: [8 * CPU_HIGH_WATER - 0.5, 6, 4] }), null)?.warnings).toEqual([]);
	});

	it("warns about memory on Linux, where free memory means available", () => {
		const nearlyFull = sample({ memFreeBytes: 16 * GiB * ((100 - MEMORY_HIGH_WATER_PCT - 1) / 100) });
		expect(resourcesView(nearlyFull, null)?.warnings[0]).toMatch(/^Memory nearly exhausted/);
	});

	it("reports but never alarms on macOS memory from raw free pages, where cached pages read as used (a runner that reports no available figure)", () => {
		const mac = resourcesView(sample({ platform: "darwin", memFreeBytes: 0.2 * GiB }), null);
		expect(mac?.memUsedPct).toBeGreaterThan(95);
		expect(mac?.warnings).toEqual([]);
	});
});

describe("a Windows runner's sample (#1275)", () => {
	it("is accepted: real disk bytes with zero inode counts keep the disk, and the gate judges it", () => {
		const raw = { loadAvg: [1, 1, 1], cpus: 4, memTotalBytes: 8 * 1024 ** 3, memFreeBytes: 3 * 1024 ** 3, platform: "win32", sampledAt: 1_760_000_000_000, disk: { path: "C:\repos", totalBytes: 254_000_000_000, freeBytes: 12_000_000_000, inodesTotal: 0, inodesFree: 0 } };
		const s = parseResourceSample(raw);
		expect(s?.disk).toMatchObject({ totalBytes: 254_000_000_000, freeBytes: 12_000_000_000, inodesTotal: 0 });
		const v = resourcesView(raw, 0);
		expect(v?.disk).toMatchObject({ usedPct: 95.3, inodesUsedPct: 0 });
		expect(v?.warnings.join(" ")).toMatch(/Disk nearly full/);
	});
});

describe("memory pressure per OS (#1176)", () => {
	const mac = (memAvailableBytes: number | undefined, over: Record<string, unknown> = {}) => sample({ platform: "darwin", memTotalBytes: 8 * GiB, memFreeBytes: 0.2 * GiB, ...(memAvailableBytes === undefined ? {} : { memAvailableBytes }), ...over });

	it("macOS: a Mac that is genuinely starved (available memory nearly gone) now warns, even though raw free reads the same as a healthy one", () => {
		const starved = resourcesView(mac(0.4 * GiB), null);
		expect(starved?.warnings[0]).toMatch(/^Memory nearly exhausted: 95% in use/);
		// the same raw free pages, but 3 GiB reclaimable: healthy, silent
		expect(resourcesView(mac(3 * GiB), null)?.warnings).toEqual([]);
	});

	it("macOS without an available-memory figure (an older runner) is still not judged, never alarmed from the free-page reading", () => {
		expect(memoryPressurePct({ platform: "darwin", memTotalBytes: 8 * GiB, memFreeBytes: 0.1 * GiB })).toBeNull();
		expect(resourcesView(mac(undefined), null)?.warnings).toEqual([]);
	});

	it("Windows: the free figure is available memory, so a high reading is real starvation and warns", () => {
		const starved = resourcesView(sample({ platform: "win32", memTotalBytes: 8 * GiB, memFreeBytes: 0.5 * GiB }), null);
		expect(starved?.warnings[0]).toMatch(/^Memory nearly exhausted: 93\.8% in use/);
		expect(resourcesView(sample({ platform: "win32", memTotalBytes: 8 * GiB, memFreeBytes: 4 * GiB }), null)?.warnings).toEqual([]);
	});

	it("an unknown platform is not judged", () => {
		expect(memoryPressurePct({ platform: "freebsd", memTotalBytes: 8 * GiB, memFreeBytes: 0 })).toBeNull();
	});

	it("names the heaviest session by resident memory, from what is already collected", () => {
		const sessions = [
			{ sessionId: "s-small", engineLabel: "Claude Code", pid: 11, processes: 3, rssBytes: 0.4 * GiB, cpuPct: 5 },
			{ sessionId: "s-big", engineLabel: "Codex", pid: 22, processes: 1, rssBytes: 2.5 * GiB, cpuPct: 90 },
		];
		const v = resourcesView(mac(0.3 * GiB, { sessions }), null);
		expect(v?.warnings[0]).toMatch(/Heaviest session: Codex at 2\.5 GiB across 1 process\./);
	});

	it("the heaviest session is only named when memory is actually high", () => {
		const sessions = [{ sessionId: "s-big", engineLabel: "Codex", pid: 22, processes: 1, rssBytes: 2.5 * GiB, cpuPct: 90 }];
		expect(resourcesView(mac(5 * GiB, { sessions }), null)?.warnings).toEqual([]);
	});

	it("Linux is unchanged", () => {
		expect(memoryPressurePct({ platform: "linux", memTotalBytes: 16 * GiB, memFreeBytes: 8 * GiB })).toBe(50);
	});
});
