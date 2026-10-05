/**
 * `GET /v1/terminals/nodes` (list_runner_nodes) finds a machine's socket under any of its names (#922).
 *
 * Live: the Mac mini registered and heartbeated as `Sergeys-Mac-mini.local` (seen seconds ago) while
 * its relay sockets — opened after macOS renamed it — sat under `Macmini`. This route probed only the
 * freshest name and reported every agent there `connected: false`; `coding_diagnostics` walks the
 * machine's aliases, found the socket, and said online. One runner, two answers, 90 seconds apart.
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

const MINI = "mini-0000-machine-id";
let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't922-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i-a', 'ag', 'u1', 'active', '{}'), ('i-b', 'ag', 'u1', 'active', '{}')`);
	const row = (inst: string, node: string, seen: string, machine: string | null) =>
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at, updated_at)
		         VALUES ('${inst}', 'u1', '${node}', 'relay://', '0.4.69', ${machine ? `'${machine}'` : "NULL"}, 'online', '${seen}', '${seen}')`);
	// The freshest name is the one the runner heartbeats under; the older one is where its sockets are.
	row("i-a", "Sergeys-Mac-mini.local", "2026-10-05 06:06:10", MINI);
	row("i-a", "Macmini", "2026-09-11 23:35:32", MINI);
	row("i-b", "Sergeys-Mac-mini.local", "2026-10-05 06:06:10", MINI);
	// A different machine, with no socket anywhere.
	row("i-b", "pink-laptop", "2026-10-05 06:04:19", "pink-0000-machine-id");
});
afterEach(() => d1.close());

/** A relay whose live slots are exactly `live` — `${instanceId}:node:${name}`. */
function relay(live: string[]) {
	return {
		idFromName: (n: string) => n,
		get: (name: string) => ({
			fetch: async () => new Response(JSON.stringify({ connected: live.includes(name) })),
		}),
	};
}

async function nodes(live: string[]) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/terminals", terminalRoutes);
	const res = await app.request("/v1/terminals/nodes", {}, { DB: d1.DB, RELAY: relay(live) } as unknown as Env);
	expect(res.status).toBe(200);
	return ((await res.json()) as { nodes: Array<{ node: string; aka: string[]; connected: boolean; lastSeenAt: string; instances: Array<{ instanceId: string; connected: boolean }> }> }).nodes;
}

describe("list_runner_nodes reads a machine's sockets under every name it has (#922)", () => {
	it("reports connected when the socket sits under an alias, not the freshest name", async () => {
		const all = await nodes(["i-a:node:Macmini"]);
		const mini = all.find((n) => n.node === "Sergeys-Mac-mini.local");
		expect(mini?.aka).toEqual(["Macmini"]);
		expect(mini?.connected).toBe(true);
		expect(mini?.instances.find((i) => i.instanceId === "i-a")?.connected).toBe(true);
		// The agent with no socket under ANY of the machine's names stays disconnected.
		expect(mini?.instances.find((i) => i.instanceId === "i-b")?.connected).toBe(false);
	});

	it("still reads the freshest name, and never borrows another machine's socket", async () => {
		const all = await nodes(["i-b:node:Sergeys-Mac-mini.local"]);
		expect(all.find((n) => n.node === "Sergeys-Mac-mini.local")?.instances.find((i) => i.instanceId === "i-b")?.connected).toBe(true);
		expect(all.find((n) => n.node === "pink-laptop")?.connected).toBe(false);
	});
});
