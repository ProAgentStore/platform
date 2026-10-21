/**
 * The resource sample the runner heartbeat carries (#924) — in-process `os` reads, shaped the way the
 * platform validates them (`workers/api/src/lib/runner-resources.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVmStat, probeRuntimeHealth, RUNTIME_HEALTH_TIMEOUT_MS, recordRunnerStart, sampleDisk, sampleMemAvailable, sampleResources } from "./resources.js";

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

const VM_STAT = [
	"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
	"Pages free:                               11022.",
	"Pages active:                            220000.",
	"Pages inactive:                          150000.",
	"Pages speculative:                         4000.",
	"Pages purgeable:                          30000.",
].join("\n");

describe("available memory on macOS (#1275)", () => {
	it("is free + inactive + purgeable + speculative pages, times the page size the header states", () => {
		expect(parseVmStat(VM_STAT)).toBe((11022 + 150000 + 30000 + 4000) * 16384);
	});

	it("reads as not measured, never as zero, when the output is not vm_stat's", () => {
		expect(parseVmStat("")).toBeNull();
		expect(parseVmStat("Pages free: 5.")).toBeNull(); // no page size
		expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 5.")).toBeNull(); // no inactive line
	});

	it("is measured only on darwin, and a failing vm_stat is simply absent", () => {
		const ran: string[] = [];
		expect(sampleMemAvailable("linux", () => { ran.push("x"); return VM_STAT; })).toBeNull();
		expect(sampleMemAvailable("win32", () => { ran.push("x"); return VM_STAT; })).toBeNull();
		expect(ran).toEqual([]);
		expect(sampleMemAvailable("darwin", () => VM_STAT)).toBe(195022 * 16384);
		expect(sampleMemAvailable("darwin", () => { throw new Error("vm_stat: not found"); })).toBeNull();
	});

	it("rides the sample when given, and is left out when not", () => {
		expect(sampleResources(fakeOs(), 1, { memAvailableBytes: 9e9 }).memAvailableBytes).toBe(9e9);
		expect("memAvailableBytes" in sampleResources(fakeOs(), 1)).toBe(false);
	});
});

describe("disk on a platform that reports no inodes (Windows) (#1275)", () => {
	it("is still a sample: bytes are real, inode counts are zero", () => {
		const windows = (() => ({ blocks: 61_941_075, bsize: 4096, bavail: 43_981_076, files: 0, ffree: 0 })) as unknown as Parameters<typeof sampleDisk>[1];
		expect(sampleDisk("C:/Users/admin/repos", windows)).toEqual({ path: "C:/Users/admin/repos", totalBytes: 61_941_075 * 4096, freeBytes: 43_981_076 * 4096, inodesTotal: 0, inodesFree: 0 });
	});
});

describe("the runtime's own health (#1167)", () => {
	const clock = (...ticks: number[]) => {
		let i = 0;
		return () => ticks[Math.min(i++, ticks.length - 1)];
	};

	it("reads a runtime that answers /health as ok, with the round trip", async () => {
		const seen: Array<{ url: string; auth: string | null }> = [];
		const doFetch = (async (url: string, init?: RequestInit) => {
			seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		expect(await probeRuntimeHealth("http://127.0.0.1:49171/", "tok", doFetch, clock(1000, 1012))).toEqual({ ok: true, latencyMs: 12, checkedAt: 1000 });
		expect(seen).toEqual([{ url: "http://127.0.0.1:49171/health", auth: "Bearer tok" }]);
	});

	it("reads a bad status as not ok, naming it", async () => {
		const doFetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
		expect(await probeRuntimeHealth("http://x", "t", doFetch, clock(5, 9))).toEqual({ ok: false, latencyMs: 4, error: "HTTP 503", checkedAt: 5 });
	});

	it("reads a refused connection as not ok, with the reason's first line", async () => {
		const doFetch = (async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:49171\n    at stack");
		}) as unknown as typeof fetch;
		expect(await probeRuntimeHealth("http://x", "t", doFetch, clock(1))).toEqual({ ok: false, latencyMs: null, error: "connect ECONNREFUSED 127.0.0.1:49171", checkedAt: 1 });
	});

	it("reads no answer in time as not ok — the wedged case — and never throws", async () => {
		const doFetch = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as unknown as typeof fetch;
		const started = Date.now();
		// Real timer, shortened: the probe's own bound is RUNTIME_HEALTH_TIMEOUT_MS, so assert on it and on the shape of the answer.
		expect(RUNTIME_HEALTH_TIMEOUT_MS).toBeLessThanOrEqual(5000);
		const result = await probeRuntimeHealth("http://x", "t", doFetch);
		expect(result).toMatchObject({ ok: false, latencyMs: null, error: `no answer in ${RUNTIME_HEALTH_TIMEOUT_MS / 1000}s` });
		expect(Date.now() - started).toBeLessThan(RUNTIME_HEALTH_TIMEOUT_MS + 2000);
	}, RUNTIME_HEALTH_TIMEOUT_MS + 4000);

	it("rides the heartbeat sample when given, and is left out when not", () => {
		const runtime = { ok: false, latencyMs: null, error: "no answer in 4s", checkedAt: 1 };
		expect(sampleResources(fakeOs(), 1, { runtime }).runtime).toEqual(runtime);
		expect("runtime" in sampleResources(fakeOs(), 1)).toBe(false);
	});
});

describe("sampleResources on Windows (#1258)", () => {
	it("reports load as null — Node's [0,0,0] there is 'no load average', not an idle machine", () => {
		const s = sampleResources(fakeOs({ platform: () => "win32", loadavg: () => [0, 0, 0] }), 1_700_000_000_000);
		expect(s.loadAvg).toBeNull();
		expect(s.platform).toBe("win32");
		expect(s.cpus).toBe(10);
		expect(JSON.parse(JSON.stringify(s)).loadAvg).toBeNull(); // null survives the heartbeat's JSON
	});

	it("does not even read the load average there", () => {
		const loadavg = vi.fn(() => [0, 0, 0]);
		sampleResources(fakeOs({ platform: () => "win32", loadavg }));
		expect(loadavg).not.toHaveBeenCalled();
	});

	it("macOS and Linux keep their real readings — including a genuine 0", () => {
		expect(sampleResources(fakeOs({ platform: () => "darwin" })).loadAvg).toEqual([2.5, 1.5, 0.5]);
		expect(sampleResources(fakeOs({ platform: () => "linux", loadavg: () => [0, 0, 0] })).loadAvg).toEqual([0, 0, 0]);
	});
});
