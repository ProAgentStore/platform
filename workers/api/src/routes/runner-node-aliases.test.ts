/**
 * `instance_runner_node` reads a machine under EVERY name it is provably known by (#949).
 *
 * The live state on 2026-10-07, reproduced over the real schema: the FreeGameStore coder had
 * registered on the Mac mini only under its OLD hostname `Sergeys-Mac-mini.local`, while the Mac
 * mini's runner held its sockets under its current name `Macmini.modem`. `list_runner_nodes` (which
 * folds every name, #922) showed the machine connected; this route probed the one old name and
 * reported `nodeOnline: false` with the old row's version — the symptom of freegamestore #126.
 * Only the relay is faked: which `<instance>:node:<name>` slots hold a socket.
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

const MINI = "8de74159-5e07-4e44-8472-56cc7b728cef";
const PINK = "e4fdf96a-0ebc-4dd6-bbd1-1f3a4b69599e";
let d1: RealSchemaD1;
let live: Set<string>;
const relay = {
	idFromName: (n: string) => n,
	get: (name: string) => ({ fetch: async () => Response.json({ connected: live.has(name) }) }),
};

beforeEach(() => {
	d1 = realSchemaD1();
	live = new Set();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('coder', 'u1', 't949-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('fgs', 'coder', 'u1', 'active', '{"runnerNode":"pink-laptop"}'), ('other', 'coder', 'u1', 'active', '{}')`);
	const row = (inst: string, node: string, machine: string, version: string, seen: string) =>
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at)
		         VALUES ('${inst}', 'u1', '${node}', 'relay://', '${version}', '${machine}', 'online', '${seen}')`);
	row("fgs", "pink-laptop", PINK, "0.4.69", "2026-10-06 22:07:52");
	row("fgs", "Sergeys-Mac-mini.local", MINI, "0.4.68", "2026-09-11 23:35:32"); // the old name, never re-registered
	row("other", "Macmini.modem", MINI, "0.4.69", "2026-10-06 22:07:30"); // the Mac mini as it is now
});
afterEach(() => d1.close());

async function runnerNode(instance: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances/${instance}/runner-node`, {}, { DB: d1.DB, RELAY: relay } as unknown as Env);
	expect(res.status).toBe(200);
	return (await res.json()) as { runnerNode: string | null; nodes: string[]; nodesDetail: Array<Record<string, unknown>>; resolvedNode: string | null };
}

describe("instance_runner_node across a machine's names (#949)", () => {
	it("reads the Mac mini online, at its current version, though this agent knows it by an old name", async () => {
		live.add("other:node:Macmini.modem"); // `pags up` on the Mac mini, sockets under its new name
		live.add("fgs:node:pink-laptop");
		const body = await runnerNode("fgs");
		expect(body.nodesDetail.find((n) => n.node === "Sergeys-Mac-mini.local")).toMatchObject({
			aka: ["Macmini.modem"],
			connected: false, // this agent is pinned to pink-laptop, so it holds no socket on the Mac mini
			nodeOnline: true, // ...but the machine is up — which is what the picker must say
			runnerVersion: "0.4.69",
		});
		expect(body.nodesDetail.find((n) => n.node === "pink-laptop")).toMatchObject({ connected: true, nodeOnline: true });
	});

	it("counts THIS agent's socket under the machine's new name as connected", async () => {
		live.add("fgs:node:Macmini.modem");
		const body = await runnerNode("fgs");
		expect(body.nodesDetail.find((n) => n.node === "Sergeys-Mac-mini.local")).toMatchObject({ connected: true, nodeOnline: true });
	});

	it("still reads a machine with no socket under any name as offline", async () => {
		const body = await runnerNode("fgs");
		expect(body.nodesDetail.find((n) => n.node === "Sergeys-Mac-mini.local")).toMatchObject({ connected: false, nodeOnline: false });
	});

	it("never borrows liveness across machines a name cannot prove are the same", async () => {
		d1.exec(`UPDATE instance_runtime_nodes SET machine_id = NULL WHERE runner_node = 'Sergeys-Mac-mini.local'`);
		live.add("other:node:Macmini.modem");
		const detail = (await runnerNode("fgs")).nodesDetail.find((n) => n.node === "Sergeys-Mac-mini.local");
		expect(detail).toMatchObject({ connected: false, nodeOnline: false, runnerVersion: "0.4.68" });
		expect(detail).not.toHaveProperty("aka");
	});

	it("offers a healthy machine only ANOTHER agent registered on, as online but not attached (#1037)", async () => {
		const DELL = "0b6f2c1e-6d3a-4f0e-9b7a-2f1c3d4e5a6b";
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at)
		         VALUES ('other', 'u1', 'dell-laptop', 'relay://', '0.4.69', '${DELL}', 'online', '2026-10-06 22:08:00')`);
		live.add("other:node:dell-laptop");
		const body = await runnerNode("fgs");
		expect(body.nodes).toContain("dell-laptop");
		expect(body.nodesDetail.find((n) => n.node === "dell-laptop")).toMatchObject({ connected: false, nodeOnline: true, runnerVersion: "0.4.69" });
		// The Mac mini is still ONE machine under this agent's spelling — its other agent's name is an alias, not a second tile.
		expect(body.nodes).not.toContain("Macmini.modem");
		expect(body.nodes.filter((n) => n === "Sergeys-Mac-mini.local")).toHaveLength(1);
	});
});

describe("nodeOnline agrees with list_runner_nodes (#1055)", () => {
	/**
	 * pink-laptop on 2026-10-13: up, serving nine agents — but not this one — and registered by many more over its
	 * life. The route probed only the 25 OLDEST (instance, name) pairs, each under the one name it registered with,
	 * so the machine read `nodeOnline: false` while list_runner_nodes showed it connected.
	 */
	beforeEach(() => {
		const old = Array.from({ length: 30 }, (_, i) => `old${i}`);
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ${[...old, "late", "renamed"].map((id) => `('${id}', 'coder', 'u1', 'active', '{}')`).join(", ")}`);
		for (const id of old) {
			d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at, updated_at)
			         VALUES ('${id}', 'u1', 'pink-laptop', 'relay://', '0.4.60', '${PINK}', 'online', '2026-09-01 00:00:00', '2026-09-01 00:00:00')`);
		}
		// Registered LAST, under the machine's two names.
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at, updated_at)
		         VALUES ('late', 'u1', 'pink-laptop', 'relay://', '0.4.117', '${PINK}', 'online', '2026-10-12 18:21:55', '2026-10-12 18:21:55'),
		                ('renamed', 'u1', 'Pinks-MacBook', 'relay://', '0.4.117', '${PINK}', 'online', '2026-10-12 18:21:54', '2026-10-12 18:21:54')`);
	});

	async function fleet() {
		const app = new Hono<{ Bindings: Env }>().route("/v1/terminals", terminalRoutes);
		const res = await app.request("/v1/terminals/nodes", {}, { DB: d1.DB, RELAY: relay } as unknown as Env);
		return ((await res.json()) as { nodes: Array<{ node: string; aka: string[]; connected: boolean }> }).nodes;
	}
	/** Every node `instance_runner_node` reports must read online exactly when list_runner_nodes reads that machine connected — under whichever of its names. */
	async function expectAgreement(instance: string) {
		const [{ nodesDetail }, machines] = await Promise.all([runnerNode(instance), fleet()]);
		for (const d of nodesDetail) {
			const names = [d.node as string, ...((d.aka as string[] | undefined) ?? [])];
			const machine = machines.find((m) => names.some((n) => n === m.node || m.aka.includes(n)));
			expect(machine, `no list_runner_nodes machine for ${d.node}`).toBeDefined();
			expect(d.nodeOnline, `${d.node} (aka ${names.slice(1).join(", ") || "none"})`).toBe(machine?.connected);
		}
		return nodesDetail;
	}

	it("a machine up for agents registered past the 25th reads online — this agent holds no socket there", async () => {
		live.add("late:node:pink-laptop");
		const detail = await expectAgreement("other");
		expect(detail.find((n) => n.node === "pink-laptop" || (n.aka as string[] | undefined)?.includes("pink-laptop"))).toMatchObject({ connected: false, nodeOnline: true });
	});

	it("a socket under the machine's OTHER name counts, whichever name the instance registered with", async () => {
		live.add("late:node:Pinks-MacBook"); // registered as pink-laptop, connected under the alias
		const detail = await expectAgreement("other");
		expect(detail.find((n) => [n.node, ...((n.aka as string[] | undefined) ?? [])].includes("Pinks-MacBook"))).toMatchObject({ nodeOnline: true });
	});

	it("still offline when no instance holds a socket under any name", async () => {
		const detail = await expectAgreement("other");
		expect(detail.every((n) => n.nodeOnline === false)).toBe(true);
	});
});
