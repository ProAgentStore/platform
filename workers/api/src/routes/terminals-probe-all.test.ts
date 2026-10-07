/**
 * Every instance on a machine is probed (#898 N1–N3). The Terminals route probed the first 25 and
 * stamped the rest `connected: false`; live, seven agents pinned to a live machine read as
 * disconnected purely by list position, and the forget preflight could read a live machine as off.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { terminalRoutes, preflightForgetNode } = await import("./terminals.js");

const N = 40;
const ids = Array.from({ length: N }, (_, i) => `i-${String(i).padStart(2, "0")}`);
let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't898-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	for (const id of ids) {
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${id}', 'ag', 'u1', 'active', '{}')`);
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at, updated_at)
		         VALUES ('${id}', 'u1', 'pink-laptop', 'relay://', '0.4.74', 'pink-id', 'online', '2026-10-07 06:00:00', '2026-10-07 06:00:00')`);
	}
});
afterEach(() => d1.close());

const relay = (live: string[]) => ({
	idFromName: (n: string) => n,
	get: (name: string) => ({ fetch: async () => new Response(JSON.stringify({ connected: live.includes(name) })) }),
});
const env = (live: string[]) => ({ DB: d1.DB, RELAY: relay(live) }) as unknown as Env;

describe("list_runner_nodes probes every instance, not the first 25 (#898 N1)", () => {
	it("reports an instance past the 25th as connected when its socket is live", async () => {
		const last = ids[N - 1];
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/terminals", terminalRoutes);
		const res = await app.request("/v1/terminals/nodes", {}, env([`${last}:node:pink-laptop`]));
		const { nodes } = (await res.json()) as { nodes: Array<{ node: string; connected: boolean; instances: Array<{ instanceId: string; connected: boolean }> }> };
		const pink = nodes.find((n) => n.node === "pink-laptop");
		expect(pink?.instances).toHaveLength(N);
		expect(pink?.instances.find((i) => i.instanceId === last)?.connected).toBe(true);
		expect(pink?.connected).toBe(true);
		expect(pink?.instances.filter((i) => i.connected)).toHaveLength(1);
	});
});

describe("the forget preflight sees a socket past the 25th instance (#898 N2)", () => {
	it("reads the machine as connected", async () => {
		const pre = await preflightForgetNode(env([`${ids[N - 1]}:node:pink-laptop`]), "u1", "pink-laptop");
		expect(pre.ok && pre.connected).toBe(true);
	});
});
