/**
 * #1679 — D1 rows written per heartbeat cycle. A runner posts one heartbeat per attached agent each 30s cycle, all
 * carrying the same machine-wide report. The machine-wide writes (receipt, update-policy receipt) must happen once per
 * machine per cycle, not once per agent, and an agent's own runtime rows must not be rewritten on a beat that changes
 * nothing. Counted with SQLite's own `total_changes()`, the same quantity D1 bills as `rows_written`.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => ({ ...await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js"), requireUser: async () => ({ uid: "owner", roles: [] }) }));
const { instanceRoutes } = await import("./instances.js");
const { updateRuntimeStatus } = await import("./instances-runtime.js");

const T0 = Date.parse("2026-11-06T08:00:00Z");
const CYCLE_MS = 30_000;
let db: RealSchemaD1 | null = null;
afterEach(() => {
	vi.useRealTimers();
	db?.close();
	db = null;
});

/** Steady-state rows written per cycle (cycles 3..8) for `agents` agents attached to one machine. */
async function rowsPerCycle(agents: number): Promise<number> {
	const d = realSchemaD1();
	db = d;
	const env = { DB: d.DB } as unknown as Env;
	const ids = Array.from({ length: agents }, (_, i) => `i${i}`);
	d.exec(`INSERT INTO users (id, github_login) VALUES ('owner','owner'); INSERT INTO agents (id,owner_id,slug,name) VALUES ('a','owner','hb-writes','HB');
		INSERT INTO machine_policies (user_id, machine_id, auto_update, status, updated_at) VALUES ('owner','m1',1,'waiting_for_idle',0);`);
	for (const id of ids) {
		d.exec(`INSERT INTO agent_instances (id,agent_id,user_id,status,config) VALUES ('${id}','a','owner','active','{}');
			INSERT INTO instance_runtimes (instance_id,user_id,endpoint_url,runner_node,status) VALUES ('${id}','owner','relay://','pink','online');
			INSERT INTO instance_runtime_nodes (instance_id,user_id,runner_node,endpoint_url,machine_id,status) VALUES ('${id}','owner','pink','relay://','m1','online');`);
	}
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	const changes = () => Number((d.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
	vi.useFakeTimers({ toFake: ["Date"] });
	let steady = 0;
	for (let cycle = 0; cycle < 8; cycle++) {
		vi.setSystemTime(T0 + cycle * CYCLE_MS);
		const before = changes();
		for (const id of ids) {
			const res = await app.request(`/v1/instances/${id}/runtime/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runnerNode: "pink", machineId: "m1", autoUpdateStatus: { status: "waiting_for_idle" } }) }, env);
			expect(res.status).toBe(200);
		}
		if (cycle >= 2) steady += changes() - before;
	}
	return steady / 6;
}

describe("heartbeat write volume (#1679)", () => {
	it("machine-wide writes happen once per machine per cycle: each extra agent adds at most its own runtime rows", async () => {
		const one = await rowsPerCycle(1);
		const six = await rowsPerCycle(6);
		// Before: ~4 rows per agent per cycle (receipt, two status rows, policy receipt). After: the throttled per-agent runtime rows only.
		expect(six - one).toBeLessThanOrEqual(5 * 1);
		expect(six).toBeLessThan(one * 6);
	});

	it("an unchanged online beat inside the throttle leaves the runtime rows untouched, a later one refreshes them", async () => {
		const d = realSchemaD1();
		db = d;
		const env = { DB: d.DB } as unknown as Env;
		d.exec(`INSERT INTO users (id, github_login) VALUES ('owner','owner'); INSERT INTO agents (id,owner_id,slug,name) VALUES ('a','owner','hb-writes','HB');
			INSERT INTO agent_instances (id,agent_id,user_id,status,config) VALUES ('i0','a','owner','active','{}');
			INSERT INTO instance_runtimes (instance_id,user_id,endpoint_url,runner_node,status,last_seen_at) VALUES ('i0','owner','relay://','pink','online',datetime('now'));
			INSERT INTO instance_runtime_nodes (instance_id,user_id,runner_node,endpoint_url,machine_id,status,last_seen_at,updated_at) VALUES ('i0','owner','pink','relay://','m1','online',datetime('now'),'2000-01-01 00:00:00');`);
		const updated = () => (d.sqlite.prepare("SELECT updated_at AS u FROM instance_runtime_nodes").get() as { u: string }).u;
		await updateRuntimeStatus(env, "i0", "owner", "online", "pink"); // just seen: inside the throttle
		expect(updated()).toBe("2000-01-01 00:00:00");
		d.exec("UPDATE instance_runtime_nodes SET last_seen_at = datetime('now', '-60 seconds')");
		await updateRuntimeStatus(env, "i0", "owner", "online", "pink");
		expect(updated()).not.toBe("2000-01-01 00:00:00");
		d.exec("UPDATE instance_runtime_nodes SET updated_at = '2000-01-01 00:00:00'");
		await updateRuntimeStatus(env, "i0", "owner", "offline", "pink"); // a change is never throttled
		expect(updated()).not.toBe("2000-01-01 00:00:00");
	});
});
