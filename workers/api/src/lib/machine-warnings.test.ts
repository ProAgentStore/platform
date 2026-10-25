/**
 * #1191 — crash-loop, rollback, sign-in-expiry and resource warnings are pushed to the owner once per episode, and a silent
 * machine that reports again is told "back online" once. Real schema; only `notifyUser` (the push/bell funnel) is faked, so
 * what is asserted is what the owner would receive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyUser } = vi.hoisted(() => ({ notifyUser: vi.fn() }));
vi.mock("../routes/push.js", () => ({ notifyUser }));

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { notifySilentMachines } from "./machine-silence.js";
import { machineSignals, notifyMachineWarnings, notifyRecoveredMachines, WARNING_REPEAT_MS } from "./machine-warnings.js";
import { parseResourceSample, type RunnerResourceSample } from "./runner-resources.js";
import type { Env } from "../types.js";

const NOW = Date.UTC(2026, 9, 26, 9, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const GIB = 1024 ** 3;
let d1: RealSchemaD1;
let env: Env;

const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

/** A healthy sample unless `over` says otherwise. */
function sample(over: Record<string, unknown> = {}, at = NOW) {
	return {
		loadAvg: [0.5, 0.5, 0.5],
		cpus: 8,
		memTotalBytes: 16 * GIB,
		memFreeBytes: 10 * GIB,
		platform: "linux",
		sampledAt: at,
		disk: { path: "/", totalBytes: 500 * GIB, freeBytes: 300 * GIB, inodesTotal: 1000, inodesFree: 900 },
		runner: { startedAt: at - HOUR, uptimeSec: 3600, starts24h: 1, relayReconnects: 0 },
		...over,
	};
}

function node(name: string, resources: Record<string, unknown> | null, opts: { seenAgo?: number; machineId?: string | null; user?: string; instance?: string } = {}) {
	d1.sqlite
		.prepare(
			`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at, resources)
			 VALUES (?, ?, ?, 'relay://', '0.4.180', ?, 'registered', ?, ?)
			 ON CONFLICT(instance_id, runner_node) DO UPDATE SET last_seen_at = excluded.last_seen_at, resources = excluded.resources`,
		)
		.run(opts.instance ?? "i1", opts.user ?? "u1", name, opts.machineId === undefined ? `machine-${name}` : opts.machineId, sqlTime(NOW - (opts.seenAgo ?? 0)), resources ? JSON.stringify(resources) : null);
}

/** Every machine reports at `at`: a sweep run later than NOW must still see a machine that is alive. */
const alive = (at: number) => d1.sqlite.prepare("UPDATE instance_runtime_nodes SET last_seen_at = ?").run(sqlTime(at));

const received = () => notifyUser.mock.calls.map((c) => ({ user: c[1], type: c[2], title: c[3] as string, body: c[4] as string, url: c[5] as string, key: (c[6] as { key?: string })?.key }));

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i3"] });
	env = { DB: d1.DB } as unknown as Env;
	notifyUser.mockReset().mockResolvedValue("delivered");
});
afterEach(() => d1.close());

const sig = (s: Record<string, unknown>, rollbacks: Parameters<typeof machineSignals>[2] = [], now = NOW) => machineSignals("dell-laptop", parseResourceSample(s) as RunnerResourceSample, rollbacks, now);

describe("the signals a machine's own report carries", () => {
	it("a healthy machine carries none", () => {
		expect(sig(sample())).toEqual([]);
	});
	it("a crash-looping runner: starts in 24h at the page's own threshold", () => {
		expect(sig(sample({ runner: { startedAt: NOW - 1, uptimeSec: 1, starts24h: 2, relayReconnects: 0 } }))).toEqual([]);
		const [s] = sig(sample({ runner: { startedAt: NOW - 1, uptimeSec: 1, starts24h: 4, relayReconnects: 0 } }));
		expect(s).toMatchObject({ kind: "crash_loop" });
		expect(s.title).toContain("dell-laptop's runner keeps restarting");
		expect(s.body).toContain("4 times in 24 hours");
		expect(s.body).toContain("pags up --install-service");
	});
	it("a rolled-back release: names it, where it went back to and why — only the newest recent one", () => {
		const recent = { from: "0.4.150", to: "0.4.148", reason: "it did not register", at: new Date(NOW - HOUR).toISOString() };
		const older = { from: "0.4.149", to: "0.4.148", reason: "crash on start", at: new Date(NOW - 5 * HOUR).toISOString() };
		const stale = { from: "0.4.140", to: "0.4.139", reason: "x", at: new Date(NOW - 5 * 24 * HOUR).toISOString() };
		const found = sig(sample(), [older, recent, stale]);
		expect(found.map((s) => s.kind)).toEqual(["rollback"]);
		expect(found[0].title).toContain("rolled back 0.4.150");
		expect(found[0].body).toContain("back to 0.4.148: it did not register");
		expect(found[0].body).toContain("retry_rolled_back");
		expect(sig(sample(), [stale])).toEqual([]);
		expect(sig(sample(), [{ ...recent, at: null }])).toEqual([]);
	});
	it("a sign-in near expiry, or past it — within the 3 days the page warns at", () => {
		const runner = (expiresIn: number) => sample({ runner: { startedAt: NOW - 1, uptimeSec: 1, starts24h: 1, relayReconnects: 0, sessionExpiresAt: NOW + expiresIn } });
		expect(sig(runner(5 * 24 * HOUR))).toEqual([]);
		const near = sig(runner(2 * 24 * HOUR))[0];
		expect(near).toMatchObject({ kind: "sign_in", episode: String(NOW + 2 * 24 * HOUR) });
		expect(near.title).toContain("sign-in expires in 2 days");
		expect(near.body).toContain("pags login --device");
		expect(sig(runner(5 * HOUR))[0].title).toContain("5 hours");
		const gone = sig(runner(-HOUR))[0];
		expect(gone.title).toContain("is signed out");
	});
	it("CPU, memory and disk pressure at the page's thresholds, each its own signal", () => {
		const all = sig(sample({ loadAvg: [14, 10, 8], memFreeBytes: 1 * GIB, disk: { path: "/", totalBytes: 500 * GIB, freeBytes: 20 * GIB, inodesTotal: 1000, inodesFree: 900 } }));
		expect(all.map((s) => s.kind)).toEqual(["cpu", "memory", "disk"]);
		expect(all[0].body).toContain("1-minute load 14.0 on 8 cores");
		expect(all[1].body).toContain("93.8% in use");
		expect(all[2].body).toContain("96.0%");
		expect(sig(sample({ loadAvg: [11, 5, 5] }))).toEqual([]); // 1.4 per core: under
	});
	it("macOS memory is not judged without the available-memory figure (free pages alone cry wolf)", () => {
		expect(sig(sample({ platform: "darwin", memFreeBytes: 100 * 1024 ** 2 }))).toEqual([]);
		expect(sig(sample({ platform: "darwin", memFreeBytes: 100 * 1024 ** 2, memAvailableBytes: 1 * GIB })).map((s) => s.kind)).toEqual(["memory"]);
	});
});

describe("the sweep: once per episode, through the machine type", () => {
	const loaded = () => sample({ runner: { startedAt: NOW - 1, uptimeSec: 1, starts24h: 5, relayReconnects: 0 } });

	it("a crash-looping machine: one push, mutable `machine` type, linked to the machine's page", async () => {
		node("dell-laptop", loaded());
		expect(await notifyMachineWarnings(env, NOW)).toBe(1);
		expect(received()).toEqual([expect.objectContaining({ user: "u1", type: "machine", url: "/console/terminals/machines/machine-dell-laptop" })]);
		expect(received()[0].title).toContain("keeps restarting");
	});
	it("ONCE per episode: later ticks of the same condition send nothing", async () => {
		node("dell-laptop", loaded());
		for (const t of [0, 1, 30, 120, 600]) {
			alive(NOW + t * MIN);
			await notifyMachineWarnings(env, NOW + t * MIN);
		}
		expect(notifyUser).toHaveBeenCalledTimes(1);
	});
	it("a signal that clears and returns inside the repeat window is not a stream; after it, the new episode is told", async () => {
		node("dell-laptop", loaded());
		await notifyMachineWarnings(env, NOW);
		node("dell-laptop", sample({}, NOW + 10 * MIN)); // recovered
		alive(NOW + 10 * MIN);
		await notifyMachineWarnings(env, NOW + 10 * MIN);
		node("dell-laptop", loaded()); // and again, 20 minutes after the first push
		alive(NOW + 20 * MIN);
		expect(await notifyMachineWarnings(env, NOW + 20 * MIN)).toBe(0);
		alive(NOW + 2 * HOUR);
		expect(await notifyMachineWarnings(env, NOW + 2 * HOUR)).toBe(0);
		alive(NOW + WARNING_REPEAT_MS + MIN);
		expect(await notifyMachineWarnings(env, NOW + WARNING_REPEAT_MS + MIN)).toBe(1);
		expect(notifyUser).toHaveBeenCalledTimes(2);
	});
	it("a sign-in is one episode per expiry date: a renewed sign-in that nears its end later is a new one", async () => {
		const expiring = (at: number, exp: number) => sample({ runner: { startedAt: at - 1, uptimeSec: 1, starts24h: 1, relayReconnects: 0, sessionExpiresAt: exp } }, at);
		node("dell-laptop", expiring(NOW, NOW + 2 * 24 * HOUR));
		expect(await notifyMachineWarnings(env, NOW)).toBe(1);
		alive(NOW + HOUR);
		expect(await notifyMachineWarnings(env, NOW + HOUR)).toBe(0);
		// renewed for 30 days: the episode ends; 27 days on it is near expiry again — a new date, a new push
		const later = NOW + 27.5 * 24 * HOUR;
		node("dell-laptop", expiring(NOW + 10 * MIN, NOW + 30 * 24 * HOUR));
		alive(NOW + 10 * MIN);
		await notifyMachineWarnings(env, NOW + 10 * MIN);
		node("dell-laptop", expiring(later, NOW + 30 * 24 * HOUR));
		alive(later);
		expect(await notifyMachineWarnings(env, later)).toBe(1);
		expect(received().map((r) => r.key)).toEqual([`machine-warning:machine-dell-laptop:sign_in:${NOW + 2 * 24 * HOUR}`, `machine-warning:machine-dell-laptop:sign_in:${NOW + 30 * 24 * HOUR}`]);
	});
	it("a rolled-back release is told once, from the machine's stored record, and a second rollback is a new episode", async () => {
		node("dell-laptop", sample());
		const store = (rollbacks: unknown[]) => d1.sqlite.prepare("INSERT INTO machine_policies (user_id, machine_id, rollbacks) VALUES ('u1', 'machine-dell-laptop', ?) ON CONFLICT(user_id, machine_id) DO UPDATE SET rollbacks = excluded.rollbacks").run(JSON.stringify(rollbacks));
		store([{ from: "0.4.150", to: "0.4.148", reason: "it did not register", at: NOW - HOUR }]);
		expect(await notifyMachineWarnings(env, NOW)).toBe(1);
		alive(NOW + MIN);
		expect(await notifyMachineWarnings(env, NOW + MIN)).toBe(0);
		store([{ from: "0.4.151", to: "0.4.148", reason: "crash on start", at: NOW + 7 * HOUR }]);
		node("dell-laptop", sample({}, NOW + 7 * HOUR));
		alive(NOW + 7 * HOUR + MIN);
		expect(await notifyMachineWarnings(env, NOW + 7 * HOUR + MIN)).toBe(1);
		expect(received().map((r) => r.title)).toEqual([expect.stringContaining("rolled back 0.4.150"), expect.stringContaining("rolled back 0.4.151")]);
	});
	it("an unreadable rollback record does not hide the machine's other signals", async () => {
		node("dell-laptop", loaded());
		d1.sqlite.prepare("INSERT INTO machine_policies (user_id, machine_id, rollbacks) VALUES ('u1', 'machine-dell-laptop', '{not json')").run();
		expect(await notifyMachineWarnings(env, NOW)).toBe(1);
	});
	it("several signals at once are separate pushes, and several machines and owners are separate", async () => {
		node("dell-laptop", sample({ loadAvg: [14, 10, 8], memFreeBytes: 1 * GIB }));
		node("mac-mini", loaded(), { instance: "i2" });
		node("other-owner", loaded(), { user: "u2", instance: "i3" });
		expect(await notifyMachineWarnings(env, NOW)).toBe(4);
		expect(received().filter((r) => r.user === "u2")).toHaveLength(1);
	});
	it("judges a machine once however many agents it serves, by its freshest report", async () => {
		node("dell-laptop", sample({}, NOW - 5 * MIN), { instance: "i1" }); // an agent whose last sample was healthy
		node("dell-laptop", loaded(), { instance: "i2" });
		expect(await notifyMachineWarnings(env, NOW)).toBe(1);
	});
	it("leaves a silent machine to the silence alert: its numbers are old news", async () => {
		node("dell-laptop", loaded(), { seenAgo: 40 * MIN });
		expect(await notifyMachineWarnings(env, NOW)).toBe(0);
	});
	it("a machine that sends no sample, or an unreadable one, has no signals", async () => {
		node("a", null);
		node("b", { nonsense: true }, { instance: "i2" });
		expect(await notifyMachineWarnings(env, NOW)).toBe(0);
	});
	it("an unreadable table is not an error", async () => {
		d1.exec("DROP TABLE machine_warning_alerts");
		node("dell-laptop", loaded());
		await expect(notifyMachineWarnings(env, NOW)).resolves.toBe(0);
	});
});

describe("a silent machine that reports again is told 'back online', once (#1191)", () => {
	it("after the silence the owner was told about: one all-clear naming how long it was away", async () => {
		node("dell-laptop", sample({}, NOW - 60 * MIN), { seenAgo: 60 * MIN });
		await notifySilentMachines(env, NOW);
		expect(received()).toHaveLength(1);
		notifyUser.mockClear();
		node("dell-laptop", sample(), { seenAgo: 0 });
		expect(await notifyRecoveredMachines(env, NOW + MIN)).toBe(1);
		const [n] = received();
		expect(n).toMatchObject({ user: "u1", type: "machine", url: "/console/terminals/machines/machine-dell-laptop" });
		expect(n.title).toContain("dell-laptop is back online");
		expect(n.body).toContain("about 60 minutes");
		expect(await notifyRecoveredMachines(env, NOW + 2 * MIN)).toBe(0);
		expect(notifyUser).toHaveBeenCalledTimes(1);
	});
	it("not while it is still quiet, and not for a machine nobody was told was silent", async () => {
		node("dell-laptop", sample(), { seenAgo: 60 * MIN });
		await notifySilentMachines(env, NOW);
		notifyUser.mockClear();
		expect(await notifyRecoveredMachines(env, NOW)).toBe(0); // still the same last report
		node("mac-mini", sample(), { instance: "i2" });
		expect(await notifyRecoveredMachines(env, NOW)).toBe(0); // never silent
		expect(notifyUser).not.toHaveBeenCalled();
	});
	it("a second silence is a new one: it is told, and its return is told again", async () => {
		node("dell-laptop", sample(), { seenAgo: 60 * MIN });
		await notifySilentMachines(env, NOW);
		node("dell-laptop", sample(), { seenAgo: 0 });
		await notifyRecoveredMachines(env, NOW);
		const later = NOW + 5 * HOUR;
		await notifySilentMachines(env, later); // quiet again since NOW
		expect(received().filter((r) => r.title.includes("stopped reporting"))).toHaveLength(2);
		alive(later + MIN); // it reports again
		expect(await notifyRecoveredMachines(env, later + 2 * MIN)).toBe(1);
		expect(received().filter((r) => r.title.includes("back online"))).toHaveLength(2);
	});
	it("an old silence alert (before this shipped, or a day gone) is not announced as news", async () => {
		d1.sqlite.prepare("INSERT INTO machine_silence_alerts (user_id, machine_key, last_seen_at, notified_at) VALUES ('u1', 'machine-dell-laptop', ?, ?)").run(sqlTime(NOW - 3 * 24 * HOUR), NOW - 3 * 24 * HOUR);
		node("dell-laptop", sample());
		expect(await notifyRecoveredMachines(env, NOW)).toBe(0);
	});
});
