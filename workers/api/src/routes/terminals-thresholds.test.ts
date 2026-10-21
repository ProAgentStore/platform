/**
 * #1275 through the routes: a machine's admission thresholds are read, partially changed and reset by machine id, are shared by
 * every instance on it, show up in the fleet view (`list_runner_nodes`), and refuse bad input.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { terminalRoutes } = await import("./terminals.js");

const TINY = "ba609935-d5c3-4d4f-b0a2-2bd70020f4f7";
const OTHER = "065eca55-6dea-45de-9043-2d1edb480b2f";
const GIB = 1024 ** 3;
let d1: RealSchemaD1;

const resources = (cpus: number, mem: number) =>
	JSON.stringify({
		loadAvg: [0.4, 0.4, 0.4],
		cpus,
		memTotalBytes: mem * GIB,
		memFreeBytes: (mem - 1) * GIB,
		platform: "linux",
		sampledAt: Date.now(),
		disk: { path: "/", totalBytes: 500 * GIB, freeBytes: 300 * GIB, inodesTotal: 1_000_000, inodesFree: 900_000 },
	});

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')");
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1275', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i-a', 'ag', 'u1', 'active', '{}'), ('i-b', 'ag', 'u1', 'active', '{}'), ('i-c', 'ag', 'u1', 'active', '{}')`);
	const row = (inst: string, node: string, machine: string, res: string) =>
		d1.sqlite
			.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, resources, status, last_seen_at, updated_at) VALUES (?, 'u1', ?, 'relay://', '0.4.166', ?, ?, 'online', '2026-10-21 10:00:00', '2026-10-21 10:00:00')")
			.run(inst, node, machine, res);
	row("i-a", "tiny-laptop", TINY, resources(2, 8)); // the formula caps it at 1
	row("i-b", "tiny-laptop", TINY, resources(2, 8));
	row("i-c", "dell-laptop", OTHER, resources(8, 32));
});
afterEach(() => d1.close());

const relay = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ connected: false })) }) };
async function call(path: string, init: RequestInit = {}, env: Partial<Env> = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/terminals", terminalRoutes);
	const res = await app.request(path, init, { DB: d1.DB, RELAY: relay, ...env } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: the test reads loose response JSON
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const put = (id: string, body: unknown) => call(`/v1/terminals/machines/${id}/thresholds`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (id: string) => call(`/v1/terminals/machines/${id}/thresholds`);

describe("a machine's thresholds (#1275)", () => {
	it("a fresh machine reads the defaults and the cores/memory formula, none of it overridden", async () => {
		const { status, body } = await get(TINY);
		expect(status).toBe(200);
		expect(body).toMatchObject({ machineId: TINY, maxSessions: { value: 1, source: "formula", formula: 1 }, overrides: {}, verdict: { gate: "accepting" } });
		expect(body.thresholds).toMatchObject({ cpuLoad1PerCpu: 1.5, memUsedPctMax: 92, diskUsedPctMax: 95 });
		expect(Object.keys(body.fields)).toContain("recoveryStreak");
	});

	it("set maxSessions: 2 on the tiny laptop — the answer, the fleet view and the machine's other agents all say 2", async () => {
		const set = await put(TINY, { maxSessions: 2 });
		expect(set.status).toBe(200);
		expect(set.body).toMatchObject({ maxSessions: { value: 2, source: "machine", formula: 1 }, overrides: { maxSessions: 2 }, changed: { maxSessions: 2 }, before: {} });
		const nodes = await call("/v1/terminals/nodes");
		const tiny = nodes.body.nodes.find((n: { machineId: string }) => n.machineId === TINY);
		expect(tiny.thresholds).toMatchObject({ maxSessions: { value: 2, source: "machine" }, overrides: { maxSessions: 2 } });
		expect(tiny.resources.recommendedMaxSessions).toBe(2); // the capacity the warnings and the gate use
		// Both instances on the machine are one machine entry, so the one policy covers both.
		expect(tiny.instances.map((i: { instanceId: string }) => i.instanceId).sort()).toEqual(["i-a", "i-b"]);
		// The other machine is untouched.
		const dell = nodes.body.nodes.find((n: { machineId: string }) => n.machineId === OTHER);
		expect(dell.thresholds).toMatchObject({ maxSessions: { value: 4, source: "formula" }, overrides: {} });
	});

	it("is a partial update: a number sets, null clears, absent stays", async () => {
		await put(TINY, { maxSessions: 2, cpuLoad1PerCpu: 2.5 });
		const next = await put(TINY, { cpuLoad1PerCpu: null, diskUsedPctMax: 80, recoveryStreak: 3 });
		expect(next.body.overrides).toEqual({ maxSessions: 2, diskUsedPctMax: 80, recoveryStreak: 3 });
		expect(next.body.before).toEqual({ maxSessions: 2, cpuLoad1PerCpu: 2.5 });
		expect(next.body.source).toMatchObject({ maxSessions: "machine", cpuLoad1PerCpu: "default", diskUsedPctMax: "machine" });
	});

	it("reset removes every override and says what it removed", async () => {
		await put(TINY, { maxSessions: 2, memUsedPctMax: 85 });
		const reset = await call(`/v1/terminals/machines/${TINY}/thresholds`, { method: "DELETE" });
		expect(reset.body).toMatchObject({ reset: true, before: { maxSessions: 2, memUsedPctMax: 85 }, overrides: {}, maxSessions: { value: 1, source: "formula" } });
		expect((await get(TINY)).body.overrides).toEqual({});
	});

	it("refuses bad input with a 400 that names the field, and changes nothing", async () => {
		for (const bad of [{ maxSessions: 0 }, { maxSessions: 2.5 }, { recoveryBand: 1.2 }, { memUsedPctMax: "high" }, { nope: 1 }, {}]) {
			const r = await put(TINY, bad);
			expect(r.status, JSON.stringify(bad)).toBe(400);
			expect(r.body.error).toEqual(expect.any(String));
		}
		expect((await get(TINY)).body.overrides).toEqual({});
	});

	it("a machine that is not this account's (or does not exist) is a 404 on every verb", async () => {
		d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i-x', 'ag', 'u2', 'active', '{}')");
		d1.sqlite
			.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id, status, updated_at) VALUES ('i-x', 'u2', 'theirs', '', '11111111-2222-3333-4444-555555555555', 'online', '2026-10-21 10:00:00')")
			.run();
		for (const id of ["11111111-2222-3333-4444-555555555555", "99999999-0000-0000-0000-000000000000"]) {
			expect((await get(id)).status).toBe(404);
			expect((await put(id, { maxSessions: 2 })).status).toBe(404);
			expect((await call(`/v1/terminals/machines/${id}/thresholds`, { method: "DELETE" })).status).toBe(404);
		}
	});

	it("the deploy's defaults show through, and a machine override still wins", async () => {
		const env = { RUNNER_GATE_DEFAULTS: JSON.stringify({ diskUsedPctMax: 80, cpuLoad1PerCpu: 2 }) };
		expect((await call(`/v1/terminals/machines/${TINY}/thresholds`, {}, env)).body).toMatchObject({ thresholds: { diskUsedPctMax: 80, cpuLoad1PerCpu: 2 }, source: { diskUsedPctMax: "default" } });
		await put(TINY, { diskUsedPctMax: 70 });
		expect((await call(`/v1/terminals/machines/${TINY}/thresholds`, {}, env)).body).toMatchObject({ thresholds: { diskUsedPctMax: 70 }, source: { diskUsedPctMax: "machine" } });
	});
});
