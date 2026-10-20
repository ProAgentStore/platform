/**
 * #1250 through the routes: a machine is shown by its owner-set name (hostnames as aliases), a pin
 * names the machine, a duplicate name is refused at the policy route, and the hostname pins the
 * migration could not resolve are listed.
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

const LAPTOP = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
const MINI = "mini-0000-machine-id";
let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1250-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
		('i-a', 'ag', 'u1', 'active', '{"runnerMachineId":"${LAPTOP}"}'),
		('i-b', 'ag', 'u1', 'active', '{"runnerNode":"Mac"}'),
		('i-c', 'ag', 'u1', 'active', '{"runnerNode":"dell-laptop"}')`);
	const row = (inst: string, node: string, seen: string, machine: string | null) =>
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at, updated_at)
		         VALUES ('${inst}', 'u1', '${node}', 'relay://', '0.4.140', ${machine ? `'${machine}'` : "NULL"}, 'online', '${seen}', '${seen}')`);
	row("i-a", "RLs-MacBook-Air.local", "2026-10-19 10:00:00", LAPTOP);
	row("i-a", "Mac.modem", "2026-10-20 00:40:00", LAPTOP);
	row("i-b", "Mac", "2026-10-18 00:00:00", LAPTOP);
	row("i-c", "Mac", "2026-10-18 00:00:00", "second-machine-mac");
	row("i-c", "Macmini", "2026-10-20 00:30:00", MINI);
	row("i-c", "dell-laptop", "2026-10-20 00:10:00", null);
	d1.exec(`INSERT INTO machine_policies (user_id, machine_id, display_name) VALUES ('u1', '${LAPTOP}', 'rl-laptop')`);
});
afterEach(() => d1.close());

const relay = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ connected: false })) }) };
async function call(path: string, init: RequestInit = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/terminals", terminalRoutes);
	const res = await app.request(path, init, { DB: d1.DB, RELAY: relay } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: the test reads loose response JSON
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("machines by name (#1250)", () => {
	it("list_runner_nodes shows the display name first, hostnames as aliases, and pins by machine", async () => {
		const { body } = await call("/v1/terminals/nodes");
		const laptop = body.nodes.find((n: { machineId: string }) => n.machineId === LAPTOP);
		expect(laptop).toMatchObject({ displayName: "rl-laptop", node: "Mac.modem" });
		expect(laptop.aka).toEqual(expect.arrayContaining(["RLs-MacBook-Air.local"]));
		expect(laptop.instances.find((i: { instanceId: string }) => i.instanceId === "i-a")).toMatchObject({ bound: true, pinnedMachineId: LAPTOP });
		expect(body.nodes.find((n: { machineId: string }) => n.machineId === MINI).displayName).toBeNull();
	});

	it("lists the hostname pins the migration could not resolve, with why", async () => {
		const { body } = await call("/v1/terminals/nodes");
		expect(body.unresolvedPins).toEqual([
			{ instanceId: "i-b", name: "Coder", pinnedHostname: "Mac", machineId: null, reason: expect.stringMatching(/two machines used it/) },
			{ instanceId: "i-c", name: "Coder", pinnedHostname: "dell-laptop", machineId: null, reason: expect.stringMatching(/older than 0\.4\.40/) },
		]);
	});

	it("set_machine_policy names a machine, refuses a duplicate (409) with no partial effect, and a blank clears", async () => {
		const put = (id: string, body: unknown) => call(`/v1/terminals/machines/${id}/policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		expect((await put(MINI, { display_name: "mac-mini" })).body.machine).toMatchObject({ displayName: "mac-mini", machineId: MINI });
		const dup = await put(MINI, { display_name: "RL-LAPTOP", auto_update: true });
		expect(dup.status).toBe(409);
		expect((await call(`/v1/terminals/machines/${MINI}`)).body.machine).toMatchObject({ displayName: "mac-mini", auto_update_policy: false });
		expect((await put(MINI, { display_name: "" })).body.machine.displayName).toBeNull();
		expect((await put(MINI, {})).status).toBe(400);
	});
});
