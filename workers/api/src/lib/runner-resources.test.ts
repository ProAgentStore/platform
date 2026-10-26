/**
 * The machine resource sample (#924): what is accepted from a runner, and what the platform says
 * about it.
 */
import { describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { heartbeatContext } from "./runner-attach-report.js";
import { CPU_HIGH_WATER, environmentOf, environmentsForNodes, MEMORY_HIGH_WATER_PCT, memoryPressurePct, mergeCoarse, parseResourceSample, resourcePoint, resourcesView, saveResourceSample } from "./runner-resources.js";

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

describe("a Windows sample reports no load, not zero (#1258)", () => {
	const win = (over: Record<string, unknown> = {}) => sample({ platform: "win32", cpus: 8, ...over });

	it("current CLI: loadAvg null is accepted for win32 and stays null", () => {
		expect(parseResourceSample(win({ loadAvg: null }))?.loadAvg).toBeNull();
	});

	it("an OLDER CLI's [0,0,0] (and any other numbers) is dropped at the boundary: the stored sample has null load", () => {
		for (const loadAvg of [[0, 0, 0], [3, 2, 1], undefined, "n/a"]) expect(parseResourceSample(win({ loadAvg }))?.loadAvg, JSON.stringify(loadAvg)).toBeNull();
		expect(JSON.parse(JSON.stringify(parseResourceSample(win({ loadAvg: [0, 0, 0] })))).loadAvg).toBeNull(); // what is stored
	});

	it("only Windows may omit load: every other platform still needs three real numbers", () => {
		for (const platform of ["linux", "darwin", "unknown"]) {
			expect(parseResourceSample(sample({ platform, loadAvg: null })), platform).toBeNull();
			expect(parseResourceSample(sample({ platform, loadAvg: [0, 0, 0] }))?.loadAvg, `${platform} genuine 0`).toEqual([0, 0, 0]);
		}
	});

	it("the view: load1/5/15 and loadPerCpu are null, never 0, and the saturated warning cannot fire on a made-up number", () => {
		const v = resourcesView(win({ loadAvg: [0, 0, 0] }), null);
		expect(v).toMatchObject({ load1: null, load5: null, load15: null, loadPerCpu: null, platform: "win32", cpus: 8 });
		expect(v?.warnings).toEqual([]);
		expect(JSON.parse(JSON.stringify(v))).toMatchObject({ load1: null, loadPerCpu: null }); // the API and MCP serialise exactly this
	});

	it("a genuine 0 on a real platform is still 0 (a quiet Linux box is not 'not reported')", () => {
		expect(resourcesView(sample({ loadAvg: [0, 0, 0] }), null)).toMatchObject({ load1: 0, loadPerCpu: 0 });
	});

	it("a history point carries null load for a Windows machine", () => {
		expect(resourcePoint(win({ loadAvg: [0, 0, 0] }))).toMatchObject({ load1: null, loadPerCpu: null });
		expect(resourcePoint(sample())).toMatchObject({ load1: 1 });
	});

	it("a coarse bucket keeps a real reading when one side has none, and stays null when neither has one", () => {
		const w = parseResourceSample(win({ loadAvg: null }));
		const l = parseResourceSample(sample({ loadAvg: [4, 3, 2] }));
		if (!w || !l) throw new Error("fixtures must parse");
		expect(mergeCoarse(w, w).loadAvg).toBeNull();
		expect(mergeCoarse(l, w).loadAvg).toEqual([4, 3, 2]);
		expect(mergeCoarse(w, l).loadAvg).toEqual([4, 3, 2]);
		expect(mergeCoarse(l, parseResourceSample(sample({ loadAvg: [6, 1, 1] })) as NonNullable<ReturnType<typeof parseResourceSample>>).loadAvg).toEqual([6, 3, 2]);
	});
});

describe("a Windows machine through the store (#1258)", () => {
	it("saveResourceSample stores null load, and the next read is null in the view, the heartbeat context and the history point", async () => {
		const d1 = realSchemaD1();
		try {
			seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
			d1.sqlite.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, status) VALUES ('inst-1', 'u1', 'dell-laptop', 'relay://', 'registered')").run();
			const env = { DB: d1.DB } as unknown as Parameters<typeof saveResourceSample>[0];
			await saveResourceSample(env, "inst-1", "u1", "dell-laptop", { loadAvg: [0, 0, 0], cpus: 8, memTotalBytes: 16 * GiB, memFreeBytes: 8 * GiB, platform: "win32", sampledAt: Date.now() });
			const stored = d1.sqlite.prepare("SELECT resources FROM instance_runtime_nodes WHERE runner_node = 'dell-laptop'").get() as { resources: string };
			expect(JSON.parse(stored.resources).loadAvg).toBeNull();
			const hist = d1.sqlite.prepare("SELECT sample FROM runner_resource_samples").all() as Array<{ sample: string }>;
			expect(hist.length).toBeGreaterThan(0);
			for (const h of hist) expect(JSON.parse(h.sample).loadAvg).toBeNull();
			expect(resourcesView(stored.resources, 0)).toMatchObject({ load1: null, loadPerCpu: null });
			const ctx = await heartbeatContext(env, "u1", ["dell-laptop"]);
			expect(ctx).toMatchObject({ load1: null, load5: null, load15: null });
		} finally {
			d1.close();
		}
	});
});

describe("the machine's environment (#405)", () => {
	const host = { arch: "x64", shell: "msys-bash", home: "C:\\Users\\admin", node: "v22.4.0" };

	it("parseResourceSample keeps a valid host block and drops a malformed one without losing the sample", () => {
		expect(parseResourceSample(sample({ host }))?.host).toEqual(host);
		expect(parseResourceSample(sample({ host: { arch: "x64" } }))?.host).toEqual({ arch: "x64", shell: null, home: null, node: "" });
		for (const bad of [{ arch: 5 }, { arch: "x64; rm -rf /" }, { arch: "a".repeat(40) }, "x64", null]) {
			const parsed = parseResourceSample(sample({ host: bad }));
			expect(parsed).not.toBeNull();
			expect(parsed?.host).toBeUndefined();
		}
		expect(parseResourceSample(sample({ host: { ...host, shell: "s".repeat(65), home: "h".repeat(301) } }))?.host).toMatchObject({ shell: null, home: null });
		expect(parseResourceSample(sample())?.host).toBeUndefined(); // a CLI before the host block
	});

	it("resourcesView exposes host, and null when the runner did not report it", () => {
		expect(resourcesView(sample({ host }), 0)?.host).toEqual(host);
		expect(resourcesView(sample(), 0)?.host).toBeNull();
	});

	it("environmentOf says what was reported and 'null' for what was not — never a guess", () => {
		expect(environmentOf("dell-laptop", null)).toBeNull();
		expect(environmentOf("dell-laptop", parseResourceSample(sample({ platform: "win32", host })))).toEqual({ node: "dell-laptop", os: "win32", arch: "x64", shell: "msys-bash", home: host.home, nodeVersion: "v22.4.0", sampledAt: "2026-10-05T06:00:00.000Z" });
		expect(environmentOf("old", parseResourceSample(sample()))).toMatchObject({ os: "linux", arch: null, shell: null, home: null, nodeVersion: null });
	});

	it("environmentsForNodes reads one query, owner-scoped, newest sample per machine, absent when none reported", async () => {
		const d1 = realSchemaD1();
		try {
			seedTenant(d1, { userId: "u1", instanceIds: ["inst-1", "inst-2"] });
			seedTenant(d1, { userId: "u2", instanceIds: ["inst-3"] });
			const ins = d1.sqlite.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, status, resources) VALUES (?, ?, ?, 'relay://', 'registered', ?)");
			ins.run("inst-1", "u1", "dell-laptop", JSON.stringify(sample({ platform: "win32", host })));
			ins.run("inst-2", "u1", "silent", null);
			ins.run("inst-3", "u2", "dell-laptop", JSON.stringify(sample({ platform: "linux", host: { ...host, arch: "arm64", shell: "zsh" } })));
			const env = { DB: d1.DB } as unknown as Parameters<typeof environmentsForNodes>[0];
			const got = await environmentsForNodes(env, "u1", ["dell-laptop", "silent", "missing", ""]);
			expect([...got.keys()]).toEqual(["dell-laptop"]);
			expect(got.get("dell-laptop")).toMatchObject({ os: "win32", arch: "x64", shell: "msys-bash" }); // not u2's arm64 linux machine of the same name
			expect((await environmentsForNodes(env, "u1", [])).size).toBe(0);
		} finally {
			d1.close();
		}
	});
});
