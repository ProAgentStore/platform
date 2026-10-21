import { describe, expect, it, vi } from "vitest";
import { createCleanupSync } from "./cleanup-sync.js";
import type { ResourceSample } from "./resources.js";

const sample = (over: Partial<ResourceSample> = {}): ResourceSample => ({
	loadAvg: [80, 60, 40],
	cpus: 4,
	memTotalBytes: 1,
	memFreeBytes: 1,
	platform: "linux",
	sampledAt: 1,
	disk: { path: "/home/x/.config/proagentstore/repos", totalBytes: 1, freeBytes: 1, inodesTotal: 1, inodesFree: 1 },
	sessions: [{ sessionId: "a", engineLabel: "claude", pid: 1, processes: 1, rssBytes: 1, cpuPct: 30 }, { sessionId: "b", engineLabel: "codex", pid: 2, processes: 1, rssBytes: 1, cpuPct: 20 }],
	...over,
});

const STATUS = { mode: "harsh", behaviours: {}, orphanedProcesses: 2, orphans: [], loadMismatch: true, unexplainedLoad: 79, diskUsedPct: 95, warnings: [], lastPass: null };

function fakeFetch(handlers: Record<string, (body: unknown) => unknown | Promise<unknown>>) {
	const calls: Array<{ path: string; body: unknown; auth: string | null }> = [];
	const impl = (async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname;
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ path, body, auth: new Headers(init?.headers).get("authorization") });
		const h = handlers[path];
		if (!h) return new Response("nope", { status: 404 });
		return new Response(JSON.stringify(await h(body)), { status: 200 });
	}) as typeof fetch;
	return { impl, calls };
}

describe("collect — the machine reading goes down, the runner's status comes up", () => {
	it("feeds load, summed session CPU and the disk path, and returns the runner's status", async () => {
		const f = fakeFetch({ "/coding/cleanup/observe": () => STATUS });
		const beat = await createCleanupSync("http://127.0.0.1:1", "tok", f.impl).collect(sample());
		expect(f.calls[0]).toMatchObject({ path: "/coding/cleanup/observe", auth: "Bearer tok", body: { load1: 80, cpus: 4, sessionsCpuPct: 50, diskPath: "/home/x/.config/proagentstore/repos" } });
		expect(beat.status).toMatchObject({ mode: "harsh", orphanedProcesses: 2 });
	});

	it("an unreadable session split is reported as unknown, never as zero", async () => {
		const f = fakeFetch({ "/coding/cleanup/observe": () => STATUS });
		await createCleanupSync("http://x", "t", f.impl).collect(sample({ sessions: undefined }));
		expect((f.calls[0].body as { sessionsCpuPct: unknown }).sessionsCpuPct).toBeNull();
	});

	it("an older runner (404) or a refused connection costs this beat its cleanup numbers, nothing else", async () => {
		expect((await createCleanupSync("http://x", "t", fakeFetch({}).impl).collect(sample())).status).toBeNull();
		const refused = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect((await createCleanupSync("http://x", "t", refused).collect(sample())).status).toBeNull();
	});
});

describe("accept — the platform's answer is applied once, and 'clean now' runs in the background", () => {
	const policy = { mode: "harsh", behaviours: { cachePruning: true } };

	it("applies a policy once, and again when it changes", async () => {
		const f = fakeFetch({ "/coding/cleanup/policy": () => ({ ok: true }) });
		const sync = createCleanupSync("http://x", "t", f.impl);
		await sync.accept({ cleanupPolicy: policy });
		await sync.accept({ cleanupPolicy: policy });
		expect(f.calls.map((c) => c.path)).toEqual(["/coding/cleanup/policy"]);
		await sync.accept({ cleanupPolicy: { mode: "gentle", behaviours: {} } });
		expect(f.calls).toHaveLength(2);
		expect(f.calls[0].body).toEqual({ policy });
	});

	it("a policy the runner did not accept is tried again on the next beat", async () => {
		let ok = false;
		const f = fakeFetch({ "/coding/cleanup/policy": () => (ok ? { ok: true } : Promise.reject(new Error("x"))) });
		const sync = createCleanupSync("http://x", "t", f.impl);
		await sync.accept({ cleanupPolicy: policy });
		ok = true;
		await sync.accept({ cleanupPolicy: policy });
		expect(f.calls.filter((c) => c.path === "/coding/cleanup/policy").length).toBeGreaterThanOrEqual(2);
	});

	it("ignores an answer with no policy (an older platform) and junk", async () => {
		const f = fakeFetch({});
		const sync = createCleanupSync("http://x", "t", f.impl);
		for (const r of [undefined, null, "x", 3, {}, { cleanupPolicy: null }]) await sync.accept(r);
		expect(f.calls).toEqual([]);
	});

	it("runs a requested pass WITHOUT blocking the heartbeat, once per request, and reports it done only when it finished", async () => {
		let release: (v: unknown) => void = () => undefined;
		const slow = new Promise((r) => {
			release = r;
		});
		const f = fakeFetch({ "/coding/cleanup/run": () => slow, "/coding/cleanup/observe": () => STATUS });
		const sync = createCleanupSync("http://x", "t", f.impl, () => undefined);
		const started = Date.now();
		await sync.accept({ cleanupNow: { requestedAt: 1000 } }); // returns while the pass is still running
		expect(Date.now() - started).toBeLessThan(500);
		expect((await sync.collect(sample())).doneAt).toBeUndefined(); // not finished: not reported
		await sync.accept({ cleanupNow: { requestedAt: 1000 } }); // the same request is not run twice
		expect(f.calls.filter((c) => c.path === "/coding/cleanup/run")).toHaveLength(1);
		release({ freedBytes: 5 });
		await vi.waitFor(async () => expect((await sync.collect(sample())).doneAt).toBe(1000));
	});

	it("a pass that could not run is requested again on the next beat", async () => {
		const f = fakeFetch({});
		const sync = createCleanupSync("http://x", "t", f.impl, () => undefined);
		await sync.accept({ cleanupNow: { requestedAt: 5 } });
		await vi.waitFor(() => expect(f.calls.length).toBeGreaterThanOrEqual(1));
		await new Promise((r) => setTimeout(r, 20));
		await sync.accept({ cleanupNow: { requestedAt: 5 } });
		expect(f.calls.filter((c) => c.path === "/coding/cleanup/run").length).toBe(2);
	});

	it("a newer request runs after an older one", async () => {
		const f = fakeFetch({ "/coding/cleanup/run": () => ({ ok: true }) });
		const sync = createCleanupSync("http://x", "t", f.impl, () => undefined);
		await sync.accept({ cleanupNow: { requestedAt: 1 } });
		await sync.accept({ cleanupNow: { requestedAt: 2 } });
		await vi.waitFor(() => expect(f.calls.filter((c) => c.path === "/coding/cleanup/run")).toHaveLength(2));
	});
});
