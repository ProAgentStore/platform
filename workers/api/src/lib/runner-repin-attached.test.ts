/**
 * `attachedOnMachine` — the look a closing confirmation window takes before answering (#922) — finds
 * the agent's socket under any name the machine is provably known by, and nowhere else.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { attachedOnMachine } from "./runner-repin.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't922-repin', 'Coder')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}')`);
	const row = (node: string, machine: string, seen: string) =>
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id, last_seen_at, updated_at)
		         VALUES ('i1', 'u1', '${node}', 'relay://', '${machine}', '${seen}', '${seen}')`);
	row("Sergeys-Mac-mini.local", "mini-0000-machine-id", "2026-10-05 06:06:10");
	row("Macmini", "mini-0000-machine-id", "2026-09-11 23:35:32");
	row("pink-laptop", "pink-0000-machine-id", "2026-10-05 06:04:19");
});
afterEach(() => d1.close());

const env = (live: string[]) =>
	({
		DB: d1.DB,
		RELAY: { idFromName: (n: string) => n, get: (n: string) => ({ fetch: async () => new Response(JSON.stringify({ connected: live.includes(n) })) }) },
	}) as unknown as Env;

describe("attachedOnMachine (#922)", () => {
	it("is true when the socket sits under another name of the same machine", async () => {
		expect(await attachedOnMachine(env(["i1:node:Macmini"]), "i1", "u1", "Sergeys-Mac-mini.local")).toBe(true);
	});

	it("is false when only a different machine holds one", async () => {
		expect(await attachedOnMachine(env(["i1:node:pink-laptop"]), "i1", "u1", "Macmini")).toBe(false);
	});
});
