/**
 * The resource sample the runner heartbeat carries (#924) — in-process `os` reads, shaped the way the
 * platform validates them (`workers/api/src/lib/runner-resources.ts`).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRunnerStart, sampleDisk, sampleResources } from "./resources.js";

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

describe("the rest of the machine (#924 follow-up)", () => {
	it("carries disk, runner process, relay round trip and sessions when given, and drops undefined", () => {
		const s = sampleResources(fakeOs(), 1, { disk: { path: "/r", totalBytes: 100, freeBytes: 10, inodesTotal: 50, inodesFree: 5 }, relayRttMs: 42, runner: undefined });
		expect(s.disk?.freeBytes).toBe(10);
		expect(s.relayRttMs).toBe(42);
		expect("runner" in s).toBe(false);
	});

	it("reads disk and inodes from statfs, falling back to the home volume when the checkout root is missing", () => {
		const calls: string[] = [];
		const statfs = ((p: string) => {
			calls.push(p);
			if (calls.length === 1) throw new Error("ENOENT");
			return { bsize: 4096, blocks: 1000, bavail: 250, files: 500, ffree: 100 };
		}) as unknown as Parameters<typeof sampleDisk>[1];
		const d = sampleDisk("/no/such/dir", statfs);
		expect(calls).toHaveLength(2);
		expect(d).toMatchObject({ totalBytes: 4096 * 1000, freeBytes: 4096 * 250, inodesTotal: 500, inodesFree: 100 });
	});

	it("counts starts in the last 24h across restarts — a crash loop shows, an old start does not", () => {
		const file = join(mkdtempSync(join(tmpdir(), "pags-starts-")), "starts.json");
		const day = 24 * 60 * 60 * 1000;
		expect(recordRunnerStart(1_000, file)).toBe(1);
		expect(recordRunnerStart(2_000, file)).toBe(2);
		expect(recordRunnerStart(3_000, file)).toBe(3);
		expect(recordRunnerStart(2_000 + day + 1, file)).toBe(2);
	});
});
