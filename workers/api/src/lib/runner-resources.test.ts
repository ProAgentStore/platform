/**
 * The machine resource sample (#924): what is accepted from a runner, and what the platform says
 * about it.
 */
import { describe, expect, it } from "vitest";
import { CPU_HIGH_WATER, MEMORY_HIGH_WATER_PCT, parseResourceSample, resourcesView } from "./runner-resources.js";

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

	it("reports but never alarms on macOS memory, where cached pages read as used", () => {
		const mac = resourcesView(sample({ platform: "darwin", memFreeBytes: 0.2 * GiB }), null);
		expect(mac?.memUsedPct).toBeGreaterThan(95);
		expect(mac?.warnings).toEqual([]);
	});
});
