/**
 * The resource sample the runner heartbeat carries (#924) — in-process `os` reads, shaped the way the
 * platform validates them (`workers/api/src/lib/runner-resources.ts`).
 */
import { describe, expect, it } from "vitest";
import { sampleResources } from "./resources.js";

const fakeOs = (over: Partial<Record<"loadavg" | "cpus" | "totalmem" | "freemem" | "platform", () => unknown>> = {}) =>
	({
		loadavg: () => [2.5, 1.5, 0.5],
		cpus: () => Array.from({ length: 10 }, () => ({})),
		totalmem: () => 32e9,
		freemem: () => 4e9,
		platform: () => "darwin",
		...over,
	}) as unknown as Parameters<typeof sampleResources>[0];

describe("sampleResources (#924)", () => {
	it("reads load, cores, memory and platform once, stamped with the time", () => {
		expect(sampleResources(fakeOs(), 1_700_000_000_000)).toEqual({
			loadAvg: [2.5, 1.5, 0.5],
			cpus: 10,
			memTotalBytes: 32e9,
			memFreeBytes: 4e9,
			platform: "darwin",
			sampledAt: 1_700_000_000_000,
		});
	});

	it("never reports zero cores — a container that hides them still divides by one", () => {
		expect(sampleResources(fakeOs({ cpus: () => [] })).cpus).toBe(1);
	});

	it("fills a short load-average answer (Windows returns zeros, never too few — but be safe)", () => {
		expect(sampleResources(fakeOs({ loadavg: () => [] })).loadAvg).toEqual([0, 0, 0]);
	});

	it("reads the real machine without throwing", () => {
		const s = sampleResources();
		expect(s.cpus).toBeGreaterThan(0);
		expect(s.memTotalBytes).toBeGreaterThan(s.memFreeBytes);
	});
});
