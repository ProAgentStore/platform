/** #1551: a derived offline row must not veto a presently responsive, owner-scoped relay. */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { getBoundRunnerConn, getRunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

vi.mock("./auth.js", async (original) => ({ ...await original<typeof import("./auth.js")>(), requireUser: async () => ({ uid: "u1551", roles: [] }) }));
const { instanceRoutes } = await import("../routes/instances.js");
const MID = "e4fdf96a-0ebc-4dd6-bbd1-1f3a4b69599e";
let d1: RealSchemaD1;
let connected: boolean;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1(); connected = true;
	d1.exec(`INSERT INTO users (id,github_login) VALUES ('u1551','u1551')`);
	d1.exec(`INSERT INTO agents (id,owner_id,slug,name,config) VALUES ('coder1551','u1551','fixture-coder-1551','Coder','{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id,agent_id,user_id,status,config) VALUES ('ski1551','coder1551','u1551','active','{"runnerMachineId":"${MID}"}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id,user_id,runner_node,endpoint_url,token_plaintext,runner_version,machine_id,status,last_seen_at) VALUES ('ski1551','u1551','pink-laptop','http://127.0.0.1:49171','fixture','0.4.223','${MID}','offline','2026-11-05 10:44:04')`);
	d1.exec(`INSERT INTO instance_runtimes (instance_id,user_id,endpoint_url,token_plaintext,runner_node,status,last_seen_at) VALUES ('ski1551','u1551','http://127.0.0.1:49171','fixture','pink-laptop','offline','2026-11-05 10:44:04')`);
	const relay = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async () => Response.json({ connected: connected && name === "ski1551:node:pink-laptop" }) }) };
	env = { DB: d1.DB, RELAY: relay } as unknown as Env;
});
afterEach(() => d1.close());

describe("live relay routing ignores historical availability status", () => {
	it.each(["online", "offline"])("dashboard and routing agree on a responsive socket with a %s registration", async (status) => {
		await d1.DB.prepare("UPDATE instance_runtime_nodes SET status = ?1").bind(status).run();
		const app = new Hono<{ Bindings: Env }>(); app.route("/v1/instances", instanceRoutes);
		const response = await app.request("/v1/instances/ski1551/runner-node", {}, env);
		expect(response.status).toBe(200);
		const body = await response.json() as { nodesDetail: Array<{ node: string; connected: boolean; responsive: boolean }> };
		expect(body.nodesDetail.find((node) => node.node === "pink-laptop")).toMatchObject({ connected: true, responsive: true });
		expect(await getBoundRunnerConn(env, "ski1551", "u1551")).toMatchObject({ runnerNode: "pink-laptop", relayName: "ski1551:node:pink-laptop" });
	});

	it("the live-checked default resolver also recovers a historically offline registration", async () => {
		expect(await getRunnerConn(env, "ski1551", "u1551")).toMatchObject({ runnerNode: "pink-laptop" });
	});

	it("does not route an offline registration without an actual relay socket", async () => {
		connected = false;
		expect(await getBoundRunnerConn(env, "ski1551", "u1551")).toBeNull();
		expect(await getRunnerConn(env, "ski1551", "u1551")).toBeNull();
	});

	it("never replaces a missing or explicitly removed registration with socket evidence alone", async () => {
		d1.exec("DELETE FROM instance_runtime_nodes; DELETE FROM instance_runtimes");
		expect(await getBoundRunnerConn(env, "ski1551", "u1551")).toBeNull();
		expect(await getRunnerConn(env, "ski1551", "u1551", "pink-laptop")).toBeNull();
	});

	it("keeps registrations owner-scoped despite a responsive socket", async () => {
		expect(await getBoundRunnerConn(env, "ski1551", "other-owner")).toBeNull();
		expect(await getRunnerConn(env, "ski1551", "other-owner", "pink-laptop")).toBeNull();
	});
});
