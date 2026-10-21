/**
 * #1275 — a machine's admission thresholds: the override precedence, the session-limit override, the shared-machine case
 * and the recovery band, on the real schema. The gate's pure decision is in runner-admission-gate.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import {
	applyThresholdPatch,
	effectiveThresholds,
	instanceGateView,
	parseThresholdPatch,
	readMachineThresholds,
	resetMachineThresholds,
	setMachineThresholds,
	storedOverrides,
	THRESHOLD_KEYS,
	thresholdsView,
} from "./machine-thresholds.js";
import { currentGateState, DEFAULT_GATE_THRESHOLDS, GATE_SAMPLE_SPACING_MS, type GateState, gateDefaults, nextGateState, parseGateThresholds, updateGateState, worstBreach } from "./runner-admission-gate.js";
import { activeWorkOn, type RunnerResourceSample } from "./runner-resources.js";
import type { Env } from "../types.js";

const GIB = 1024 ** 3;
const T0 = Date.parse("2026-10-21T10:00:00Z");

/** A 4-core, 8 GiB laptop: the formula gives it min(2, 2) = 2 sessions... */
const sample = (over: Partial<RunnerResourceSample> = {}): RunnerResourceSample => ({
	loadAvg: [0.5, 0.5, 0.5],
	cpus: 2,
	memTotalBytes: 8 * GIB,
	memFreeBytes: 4 * GIB,
	platform: "linux",
	sampledAt: T0,
	disk: { path: "/", totalBytes: 500 * GIB, freeBytes: 300 * GIB, inodesTotal: 1_000_000, inodesFree: 900_000 },
	...over,
});

describe("the patch: validated at the boundary, partial, null clears", () => {
	it("accepts numbers in range and null, and nothing else", () => {
		expect(parseThresholdPatch({ maxSessions: 2, cpuLoad1PerCpu: 2.5, diskFreeMinBytes: 0, recoveryStreak: null })).toEqual({ patch: { maxSessions: 2, cpuLoad1PerCpu: 2.5, diskFreeMinBytes: 0, recoveryStreak: null } });
		for (const bad of [{ maxSessions: 0 }, { maxSessions: 65 }, { maxSessions: 1.5 }, { maxSessions: "2" }, { memUsedPctMax: 101 }, { recoveryBand: 1 }, { recoveryBand: 0.4 }, { recoveryStreak: 0 }, { cpuLoad1PerCpu: Number.NaN }, { diskFreeMinBytes: -1 }]) {
			expect(parseThresholdPatch(bad), JSON.stringify(bad)).toMatchObject({ error: expect.any(String) });
		}
		expect(parseThresholdPatch({ surprise: 1 })).toMatchObject({ error: expect.stringMatching(/Unknown threshold/) });
		expect(parseThresholdPatch({})).toMatchObject({ error: expect.stringMatching(/at least one/) });
		expect(parseThresholdPatch(null)).toMatchObject({ error: expect.any(String) });
		expect(parseThresholdPatch([])).toMatchObject({ error: expect.any(String) });
	});

	it("applies as a partial update: a number sets, null removes, absent stays", () => {
		const a = applyThresholdPatch({ maxSessions: 2, cpuLoad1PerCpu: 2 }, { maxSessions: null, memUsedPctMax: 80 });
		expect(a).toEqual({ cpuLoad1PerCpu: 2, memUsedPctMax: 80 });
	});

	it("a stored override keeps each valid field and drops a corrupt one on its own", () => {
		expect(storedOverrides('{"maxSessions":2,"cpuLoad1PerCpu":-4,"junk":1}')).toEqual({ maxSessions: 2 });
		expect(storedOverrides("not json")).toEqual({});
		expect(storedOverrides(null)).toEqual({});
	});
});

describe("precedence: defaults table -> deploy defaults -> the machine's override", () => {
	it("a machine with no override gets the defaults and the formula; each override says it came from the machine", () => {
		const none = effectiveThresholds({}, null, { cpus: 4, memTotalBytes: 16 * GIB });
		expect(none.effective.cpuLoad1PerCpu).toBe(1.5);
		expect(none.maxSessions).toEqual({ value: 2, source: "formula", formula: 2 });
		expect(Object.values(none.source).every((s) => s === "default")).toBe(true);

		const mine = effectiveThresholds({}, { maxSessions: 6, cpuLoad1PerCpu: 3 }, { cpus: 4, memTotalBytes: 16 * GIB });
		expect(mine.maxSessions).toEqual({ value: 6, source: "machine", formula: 2 });
		expect(mine.effective).toMatchObject({ maxSessions: 6, cpuLoad1PerCpu: 3, cpuLoad5PerCpu: 1.2 });
		expect(mine.source).toMatchObject({ maxSessions: "machine", cpuLoad1PerCpu: "machine", cpuLoad5PerCpu: "default" });
	});

	it("the deploy's RUNNER_GATE_DEFAULTS replaces a default, and a machine override still wins over it", () => {
		const env = { RUNNER_GATE_DEFAULTS: JSON.stringify({ cpuLoad1PerCpu: 2, diskUsedPctMax: 80, maxSessions: 3, recoveryStreak: 4 }) };
		expect(gateDefaults(env)).toMatchObject({ cpuLoad1PerCpu: 2, diskUsedPctMax: 80, maxSessions: 3, recoveryStreak: 4, cpuLoad5PerCpu: 1.2 });
		const t = effectiveThresholds(env, { cpuLoad1PerCpu: 1 }, { cpus: 16, memTotalBytes: 64 * GIB });
		expect(t.effective).toMatchObject({ cpuLoad1PerCpu: 1, diskUsedPctMax: 80, maxSessions: 3, recoveryStreak: 4 });
		expect(t.source).toMatchObject({ cpuLoad1PerCpu: "machine", diskUsedPctMax: "default", maxSessions: "default" });
		expect(t.maxSessions).toMatchObject({ value: 3, source: "default" });
		// A malformed deploy value is ignored rather than trusted.
		expect(gateDefaults({ RUNNER_GATE_DEFAULTS: "{bad" })).toEqual(DEFAULT_GATE_THRESHOLDS);
		expect(gateDefaults({ RUNNER_GATE_DEFAULTS: JSON.stringify({ cpuLoad1PerCpu: -1, recoveryBand: 5 }) })).toEqual(DEFAULT_GATE_THRESHOLDS);
	});

	it("the view carries the verdict and what each field means", () => {
		const v = thresholdsView({}, { maxSessions: 2 }, { state: "rejecting", metric: "sessions", value: 2, threshold: 2, streak: 1, since: T0 }, { cpus: 2, memTotalBytes: 8 * GIB });
		expect(v.verdict).toMatchObject({ gate: "rejecting:sessions", metric: "sessions", value: 2, threshold: 2, recoveryStreak: 1 });
		expect(Object.keys(v.fields).sort()).toEqual([...THRESHOLD_KEYS].sort());
	});
});

describe("the sessions override changes what the gate rejects", () => {
	it("the formula caps a 2-core laptop at 1; maxSessions: 2 lets a second session in and rejects the third", () => {
		const s = sample({ cpus: 2, memTotalBytes: 8 * GIB }); // formula = max(1, min(1, 2)) = 1
		const formula = parseGateThresholds(null);
		expect(worstBreach(s, 1, formula)).toEqual({ metric: "sessions", value: 1, threshold: 1 });
		const two = parseGateThresholds({ maxSessions: 2 });
		expect(worstBreach(s, 1, two)).toBeNull();
		expect(worstBreach(s, 2, two)).toEqual({ metric: "sessions", value: 2, threshold: 2 });
	});

	it("a lower limit than the formula is honoured too", () => {
		const big = sample({ cpus: 16, memTotalBytes: 64 * GIB, memFreeBytes: 40 * GIB }); // formula = 8
		expect(worstBreach(big, 3, parseGateThresholds({ maxSessions: 3 }))).toEqual({ metric: "sessions", value: 3, threshold: 3 });
		expect(worstBreach(big, 3, parseGateThresholds(null))).toBeNull();
	});
});

describe("the recovery band and streak are the machine's too", () => {
	const rejecting = { state: "rejecting" as const, metric: "cpu" as const, value: 2, threshold: 1.5, streak: 0, since: T0 };
	const calm = sample({ loadAvg: [1, 1, 1], cpus: 2, memFreeBytes: 7.5 * GIB }); // 0.5 per core, well under 1.5, memory nearly all free

	it("default band 0.9 and streak 2: two clear samples reopen it", () => {
		const t = parseGateThresholds(null);
		const one = nextGateState(rejecting, calm, 0, t, T0 + 30_000);
		expect(one).toMatchObject({ state: "rejecting", streak: 1 });
		expect(nextGateState(one, calm, 0, t, T0 + 60_000)).toEqual({ state: "accepting", streak: 0 });
	});

	it("recoveryStreak: 4 needs four clear samples; a breach in between resets it", () => {
		const t = parseGateThresholds({ recoveryStreak: 4 });
		let s: GateState = rejecting;
		for (let i = 1; i <= 3; i++) s = nextGateState(s, calm, 0, t, T0 + i * 30_000);
		expect(s).toMatchObject({ state: "rejecting", streak: 3 });
		const hot = sample({ loadAvg: [9, 9, 9], cpus: 2 });
		expect(nextGateState(s, hot, 0, t, T0 + 150_000)).toMatchObject({ state: "rejecting", streak: 0 });
		for (let i = 1; i <= 4; i++) s = nextGateState(s, calm, 0, t, T0 + 200_000 + i * 30_000);
		expect(s.state).toBe("accepting");
	});

	it("a wider band holds the gate shut until the reading is further under the line", () => {
		const nearLine = sample({ loadAvg: [2.7, 1, 1], cpus: 2, memFreeBytes: 7.5 * GIB }); // 1.35 per core: under 1.5 but not under 90% of it (1.35)
		const defaults = parseGateThresholds(null); // band .9 -> needs < 1.35: 1.35 is not
		expect(nextGateState(rejecting, nearLine, 0, defaults, T0)).toMatchObject({ state: "rejecting", streak: 0 });
		const loose = parseGateThresholds({ recoveryBand: 0.99 }); // needs < 1.485: 1.35 is
		expect(nextGateState(rejecting, nearLine, 0, loose, T0)).toMatchObject({ state: "rejecting", streak: 1 });
		const strict = parseGateThresholds({ recoveryBand: 0.5 }); // needs < 0.75
		expect(nextGateState(rejecting, calm, 0, strict, T0)).toMatchObject({ streak: 1 }); // 0.5 per core is under 0.75
		expect(nextGateState(rejecting, sample({ loadAvg: [1.8, 1, 1], cpus: 2, memFreeBytes: 7.5 * GIB }), 0, strict, T0)).toMatchObject({ streak: 0 }); // 0.9 is not
	});

	it("a session limit recovers on the band too: at max 2 with band .9, 1 active is clear and 2 is not", () => {
		const t = parseGateThresholds({ maxSessions: 2 });
		const full = { state: "rejecting" as const, metric: "sessions" as const, value: 2, threshold: 2, streak: 0, since: T0 };
		expect(nextGateState(full, calm, 2, t, T0)).toMatchObject({ streak: 0 });
		expect(nextGateState(full, calm, 1, t, T0)).toMatchObject({ streak: 1 });
	});
});

describe("on the real schema: one policy and one gate state per machine, shared by its instances", () => {
	let d1: RealSchemaD1;
	let env: Env;
	const MACHINE = "mach-tiny";

	const node = (instanceId: string, name: string, machineId: string | null, s: RunnerResourceSample) =>
		d1.sqlite
			.prepare("INSERT OR REPLACE INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id, resources, status, updated_at) VALUES (?, 'u1', ?, '', ?, ?, 'online', ?)")
			.run(instanceId, name, machineId, JSON.stringify(s), s.sampledAt);
	const session = (id: string, instanceId: string, runnerNode: string, repoId = "r1") =>
		d1.sqlite.prepare("INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, runner_node, status) VALUES (?, ?, 'u1', ?, ?, 'active')").run(id, instanceId, repoId, runnerNode);

	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["coder-a", "coder-b", "legacy"] });
		d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder-a', 'u1', 'app', 'acme/app'), ('r2', 'coder-b', 'u1', 'web', 'acme/web')");
		env = { DB: d1.DB } as unknown as Env;
	});
	afterEach(() => d1.close());

	it("set, read back, partial update, reset", async () => {
		expect(await readMachineThresholds(env, "u1", MACHINE)).toMatchObject({ overrides: {}, state: { state: "accepting" } });
		await setMachineThresholds(env, "u1", MACHINE, { maxSessions: 2, cpuLoad1PerCpu: 3 });
		await setMachineThresholds(env, "u1", MACHINE, { cpuLoad1PerCpu: null, memUsedPctMax: 85 });
		expect((await readMachineThresholds(env, "u1", MACHINE)).overrides).toEqual({ maxSessions: 2, memUsedPctMax: 85 });
		await resetMachineThresholds(env, "u1", MACHINE);
		expect((await readMachineThresholds(env, "u1", MACHINE)).overrides).toEqual({});
		// Another owner's machine of the same id is a different row.
		d1.exec("INSERT INTO users (id, github_login) VALUES ('u2', 'u2')");
		await setMachineThresholds(env, "u2", MACHINE, { maxSessions: 9 });
		expect((await readMachineThresholds(env, "u1", MACHINE)).overrides).toEqual({});
	});

	it("maxSessions: 2 on the tiny laptop admits a second session that the formula refused, for EVERY instance there", async () => {
		const s = sample({ cpus: 2, memTotalBytes: 8 * GIB, sampledAt: T0 }); // formula limit 1
		node("coder-a", "tiny-laptop", MACHINE, s);
		node("coder-b", "tiny-laptop", MACHINE, s);
		session("s1", "coder-a", "tiny-laptop");
		// One session running, formula limit 1: the machine is full for BOTH agents.
		expect((await updateGateState(env, "coder-a", "u1", "tiny-laptop", T0)).state).toMatchObject({ state: "rejecting", metric: "sessions", threshold: 1 });
		expect(await currentGateState(env, "coder-b", "u1", "tiny-laptop")).toMatchObject({ state: "rejecting", metric: "sessions" });

		await setMachineThresholds(env, "u1", MACHINE, { maxSessions: 2 });
		const later = sample({ cpus: 2, memTotalBytes: 8 * GIB, sampledAt: T0 + 60_000 });
		node("coder-a", "tiny-laptop", MACHINE, later);
		node("coder-b", "tiny-laptop", MACHINE, later);
		// 1 of 2 running: under the new limit, but the gate is still rejecting until it has cleared its streak (2 samples).
		await updateGateState(env, "coder-a", "u1", "tiny-laptop", T0 + 60_000);
		expect((await currentGateState(env, "coder-b", "u1", "tiny-laptop")).state).toBe("rejecting");
		const much = sample({ cpus: 2, memTotalBytes: 8 * GIB, sampledAt: T0 + 120_000 });
		node("coder-b", "tiny-laptop", MACHINE, much);
		const third = await updateGateState(env, "coder-b", "u1", "tiny-laptop", T0 + 120_000);
		// 1 active against a limit of 2 is 50%, inside the recovery band, for two samples: open.
		expect(third.state.state).toBe("accepting");
		session("s2", "coder-b", "tiny-laptop", "r2");
		const next = sample({ cpus: 2, memTotalBytes: 8 * GIB, sampledAt: T0 + 180_000 });
		node("coder-a", "tiny-laptop", MACHINE, next);
		expect((await updateGateState(env, "coder-a", "u1", "tiny-laptop", T0 + 180_000)).state).toMatchObject({ state: "rejecting", metric: "sessions", threshold: 2 });
	});

	it("two instances on one machine are ONE gate: one verdict, one episode, and a sample counted once", async () => {
		const hot = sample({ loadAvg: [9, 9, 9], sampledAt: T0 });
		node("coder-a", "tiny-laptop", MACHINE, hot);
		node("coder-b", "tiny-laptop", MACHINE, hot);
		const a = await updateGateState(env, "coder-a", "u1", "tiny-laptop", T0);
		expect(a).toMatchObject({ enteredOverload: true, state: { state: "rejecting", metric: "cpu" } });
		// The second instance's heartbeat seconds later neither re-enters the episode nor sees a different state.
		node("coder-b", "tiny-laptop", MACHINE, sample({ loadAvg: [9, 9, 9], sampledAt: T0 + 5_000 }));
		const b = await updateGateState(env, "coder-b", "u1", "tiny-laptop", T0 + 5_000);
		expect(b.enteredOverload).toBe(false);
		expect(b.state).toMatchObject({ state: "rejecting", metric: "cpu" });
		// Calm returns; four instances' heartbeats inside one spacing window are a single clear sample, not four.
		const calm = (t: number) => sample({ loadAvg: [0.2, 0.2, 0.2], sampledAt: t });
		for (const [i, inst] of ["coder-a", "coder-b"].entries()) node(inst, "tiny-laptop", MACHINE, calm(T0 + 30_000 + i * 2_000));
		await updateGateState(env, "coder-a", "u1", "tiny-laptop", T0 + 30_000);
		await updateGateState(env, "coder-b", "u1", "tiny-laptop", T0 + 32_000);
		expect(await currentGateState(env, "coder-a", "u1", "tiny-laptop")).toMatchObject({ state: "rejecting", streak: 1 });
		// One spacing later it counts again and reopens.
		node("coder-a", "tiny-laptop", MACHINE, calm(T0 + 30_000 + GATE_SAMPLE_SPACING_MS + 11_000));
		await updateGateState(env, "coder-a", "u1", "tiny-laptop", T0 + 61_000);
		expect((await currentGateState(env, "coder-b", "u1", "tiny-laptop")).state).toBe("accepting");
	});

	it("a machine's own thresholds apply to every instance: a stricter CPU line rejects a load the default admits", async () => {
		await setMachineThresholds(env, "u1", MACHINE, { cpuLoad1PerCpu: 0.4 });
		const warm = sample({ loadAvg: [1, 1, 1], cpus: 2, sampledAt: T0 }); // 0.5 per core
		node("coder-a", "tiny-laptop", MACHINE, warm);
		expect((await updateGateState(env, "coder-a", "u1", "tiny-laptop", T0)).state).toMatchObject({ state: "rejecting", metric: "cpu", threshold: 0.4 });
		node("coder-b", "other-name", "mach-other", warm);
		expect((await updateGateState(env, "coder-b", "u1", "other-name", T0)).state.state).toBe("accepting"); // another machine keeps the defaults
	});

	it("counts every runtime kind: coding, browser, tailor and apply runs, on every hostname the machine has used", async () => {
		const s = sample({ cpus: 16, memTotalBytes: 64 * GIB, memFreeBytes: 40 * GIB, sampledAt: T0 });
		node("coder-a", "tiny-laptop", MACHINE, s);
		node("coder-b", "tiny-laptop.local", MACHINE, s); // the same machine under a second hostname
		session("c1", "coder-a", "tiny-laptop");
		d1.sqlite.prepare("INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, runner_node, created_at, updated_at) VALUES ('b1', 'coder-a', 'u1', 'r1', 'x', 'running', '{}', 'tiny-laptop.local', 1, 1)").run();
		d1.sqlite.prepare("INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, runner_node, created_at, updated_at) VALUES ('b2', 'coder-a', 'u1', 'r2', 'x', 'completed', '{}', 'tiny-laptop', 1, 1)").run();
		expect(await activeWorkOn(env, "u1", ["tiny-laptop", "tiny-laptop.local"])).toBe(2); // coding + the one running browser run
		await setMachineThresholds(env, "u1", MACHINE, { maxSessions: 2 });
		expect((await updateGateState(env, "coder-a", "u1", "tiny-laptop", T0)).state).toMatchObject({ state: "rejecting", metric: "sessions", value: 2, threshold: 2 });
	});

	it("a runner too old to send a machine id keeps the per-instance gate of #1264", async () => {
		node("legacy", "old-laptop", null, sample({ loadAvg: [9, 9, 9], sampledAt: T0 }));
		expect((await updateGateState(env, "legacy", "u1", "old-laptop", T0)).state).toMatchObject({ state: "rejecting", metric: "cpu" });
		expect(await currentGateState(env, "legacy", "u1", "old-laptop")).toMatchObject({ state: "rejecting" });
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM machine_policies").get()).toEqual({ n: 0 });
	});

	it("coding_loop_status's view: the machine this instance ran on, its limits and its verdict", async () => {
		await setMachineThresholds(env, "u1", MACHINE, { maxSessions: 2 });
		node("coder-a", "tiny-laptop", MACHINE, sample({ cpus: 2, memTotalBytes: 8 * GIB, sampledAt: T0 }));
		await updateGateState(env, "coder-a", "u1", "tiny-laptop", T0);
		expect(await instanceGateView(env, "coder-a", "u1")).toMatchObject({ node: "tiny-laptop", machineId: MACHINE, maxSessions: { value: 2, source: "machine", formula: 1 }, verdict: { gate: "accepting" } });
		expect(await instanceGateView(env, "legacy", "u1")).toBeNull();
	});

	it("the migration carries a per-node override up to its machine", () => {
		// 0274's backfill, run against rows shaped like 0268's: two instances on one machine, one with an override.
		d1.exec("DELETE FROM machine_policies");
		d1.sqlite.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id, gate_thresholds, status, updated_at) VALUES ('coder-a', 'u1', 'tiny-laptop', '', ?, ?, 'online', 1)").run(MACHINE, JSON.stringify({ cpuLoad1PerCpu: 3 }));
		d1.sqlite.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id, status, updated_at) VALUES ('coder-b', 'u1', 'tiny-laptop', '', ?, 'online', 1)").run(MACHINE);
		d1.exec(`INSERT INTO machine_policies (user_id, machine_id, auto_update, status, updated_at, gate_thresholds)
		  SELECT user_id, machine_id, 0, 'disabled', unixepoch() * 1000, MAX(gate_thresholds) FROM instance_runtime_nodes
		   WHERE machine_id IS NOT NULL AND gate_thresholds IS NOT NULL GROUP BY user_id, machine_id
		  ON CONFLICT(user_id, machine_id) DO UPDATE SET gate_thresholds = COALESCE(machine_policies.gate_thresholds, excluded.gate_thresholds)`);
		const row = d1.sqlite.prepare("SELECT gate_thresholds FROM machine_policies WHERE machine_id = ?").get(MACHINE) as { gate_thresholds: string };
		expect(JSON.parse(row.gate_thresholds)).toEqual({ cpuLoad1PerCpu: 3 });
	});
});
