/**
 * The Terminals routes mark an ON-but-stuck machine (#1034) — on the fleet list and the machine
 * detail (what list_runner_nodes and get_machine_policy return) — and leave the registry alone when
 * no connected machine has auto-update ON.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { reportMachinePolicyStatus, setMachinePolicy } from "../lib/machine-policy.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const publishedCli = vi.hoisted(() => vi.fn());
vi.mock("../lib/auto-update-stuck.js", async () => ({ ...(await vi.importActual<typeof import("../lib/auto-update-stuck.js")>("../lib/auto-update-stuck.js")), publishedCli }));

const { terminalRoutes } = await import("./terminals.js");

const M = "machine-aaaa1111";
const DAY = 24 * 60 * 60_000;
let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1034-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at, updated_at)
	         VALUES ('i1', 'u1', 'pink-laptop', 'relay://', '0.4.94', '${M}', 'online', '2026-10-12 06:00:00', '2026-10-12 06:00:00')`);
	publishedCli.mockReset();
	publishedCli.mockResolvedValue({ latest: "0.4.111", published: { "0.4.95": Date.now() - 3 * DAY, "0.4.111": Date.now() - DAY / 2 } });
});
afterEach(() => d1.close());

const relay = (live: string[]) => ({
	idFromName: (n: string) => n,
	get: (name: string) => ({ fetch: async () => new Response(JSON.stringify({ connected: live.includes(name) })) }),
});
const env = (live = ["i1:node:pink-laptop"]) => ({ DB: d1.DB, RELAY: relay(live) }) as unknown as Env;
const app = new Hono<{ Bindings: Env }>().route("/v1/terminals", terminalRoutes);
type Stuck = { reason: string; remedy: string; published_version: string } | null | undefined;

describe("auto-update stuck on the Terminals routes (#1034)", () => {
	it("marks the connected ON machine stuck on the fleet list and the machine detail, with runner_update as the remedy", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		await reportMachinePolicyStatus(env(), "u1", M, { status: "waiting_for_idle", latestVersion: "0.4.98" });

		const list = (await (await app.request("/v1/terminals/nodes", {}, env())).json()) as { nodes: Array<{ machineId: string; auto_update_status: string; auto_update_stuck: Stuck }> };
		const row = list.nodes.find((n) => n.machineId === M);
		expect(row?.auto_update_status).toBe("waiting_for_idle"); // the runner's record, unchanged
		expect(row?.auto_update_stuck).toMatchObject({ reason: "behind_published", remedy: "runner_update", published_version: "0.4.111" });

		const detail = (await (await app.request(`/v1/terminals/machines/${M}`, {}, env())).json()) as { machine: { auto_update_stuck: Stuck } };
		expect(detail.machine.auto_update_stuck).toMatchObject({ reason: "behind_published", remedy: "runner_update" });
		expect(publishedCli).toHaveBeenCalledTimes(2); // the mocked registry, never the network
	});

	it("turning the policy off clears it in the write's own answer", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		const res = await app.request(`/v1/terminals/machines/${M}/policy`, { method: "PUT", body: JSON.stringify({ auto_update: false }), headers: { "content-type": "application/json" } }, env());
		expect(((await res.json()) as { machine: { auto_update_stuck: Stuck } }).machine.auto_update_stuck).toBeNull();
	});

	it("does not ask the registry when no connected machine has auto-update ON", async () => {
		const res = (await (await app.request("/v1/terminals/nodes", {}, env())).json()) as { nodes: Array<{ auto_update_stuck: Stuck }> };
		expect(res.nodes[0]?.auto_update_stuck).toBeUndefined();
		await setMachinePolicy(env(), "u1", M, true);
		await app.request("/v1/terminals/nodes", {}, env([]));
		expect(publishedCli).not.toHaveBeenCalled();
	});
});
