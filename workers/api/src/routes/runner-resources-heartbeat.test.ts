/**
 * A runner's heartbeat carries its machine's resources, and list_runner_nodes reports them (#924).
 *
 * End to end over the real schema: the heartbeat route stores the sample, `/v1/terminals/nodes`
 * reads it back per MACHINE (freshest across its names and agents) with the machine's active coding
 * sessions — and a heartbeat from a CLI that predates the sample changes nothing and reads as null.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { instanceRoutes } = await import("./instances.js");
const { terminalRoutes } = await import("./terminals.js");

const GiB = 1024 ** 3;
const MINI = "mini-0000-machine-id";
let d1: RealSchemaD1;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't924-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i-a', 'ag', 'u1', 'active', '{}'), ('i-b', 'ag', 'u1', 'active', '{}')`);
	for (const [inst, node] of [["i-a", "Macmini"], ["i-b", "Sergeys-Mac-mini.local"]] as const) {
		d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, runner_node, status) VALUES ('${inst}', 'u1', 'relay://', '${node}', 'online')`);
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at)
		         VALUES ('${inst}', 'u1', '${node}', 'relay://', '0.4.71', '${MINI}', 'online', '2026-10-05 06:00:00')`);
	}
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i-a', 'u1', 'platform')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, runner_node, client_type, status) VALUES
	  ('s1', 'i-a', 'u1', 'r1', 'Macmini', 'claude', 'active'),
	  ('s2', 'i-a', 'u1', 'r1', 'Macmini', 'claude', 'ended')`);
});
afterEach(() => d1.close());

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", instanceRoutes);
	a.route("/v1/terminals", terminalRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
}
const relay = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ connected: false })) }) };
const env = () => ({ DB: d1.DB, RELAY: relay }) as unknown as Env;

async function heartbeat(instanceId: string, body: Record<string, unknown>) {
	const res = await app().request(`/v1/instances/${instanceId}/runtime/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env());
	expect(res.status).toBe(200);
}
async function machine() {
	const res = await app().request("/v1/terminals/nodes", {}, env());
	expect(res.status).toBe(200);
	const { nodes } = (await res.json()) as { nodes: Array<{ node: string; aka: string[]; resources: Record<string, unknown> | null }> };
	expect(nodes).toHaveLength(1); // one machine under two names
	return nodes[0];
}
const sample = (load1: number, at: number) => ({ loadAvg: [load1, 2, 1], cpus: 8, memTotalBytes: 16 * GiB, memFreeBytes: 4 * GiB, platform: "darwin", sampledAt: at });

describe("machine resources on the heartbeat (#924)", () => {
	it("a CLI that sends no sample (before 0.4.71) still heartbeats, and reads as resources: null", async () => {
		await heartbeat("i-a", { runnerNode: "Macmini" });
		expect((await machine()).resources).toBeNull();
	});

	it("stores the sample and reports it per machine, with its active coding sessions", async () => {
		await heartbeat("i-a", { runnerNode: "Macmini", resources: sample(3, Date.UTC(2026, 9, 5, 6, 0)) });
		expect((await machine()).resources).toMatchObject({ load1: 3, cpus: 8, memUsedPct: 75, activeSessions: 1, warnings: [], platform: "darwin" });
	});

	it("reads the FRESHEST sample across the machine's names and agents", async () => {
		await heartbeat("i-a", { runnerNode: "Macmini", resources: sample(1, Date.UTC(2026, 9, 5, 6, 0)) });
		await heartbeat("i-b", { runnerNode: "Sergeys-Mac-mini.local", resources: sample(14, Date.UTC(2026, 9, 5, 6, 1)) });
		const m = await machine();
		expect(m.resources).toMatchObject({ load1: 14, sampledAt: "2026-10-05T06:01:00.000Z" });
		expect((m.resources?.warnings as string[])[0]).toMatch(/^CPU saturated/);
	});

	it("ignores a malformed sample instead of failing the heartbeat or storing it", async () => {
		await heartbeat("i-a", { runnerNode: "Macmini", resources: { loadAvg: "high", cpus: -1 } });
		expect((await machine()).resources).toBeNull();
		const row = await d1.DB.prepare("SELECT status FROM instance_runtime_nodes WHERE instance_id = 'i-a'").first<{ status: string }>();
		expect(row?.status).toBe("online");
	});
});
