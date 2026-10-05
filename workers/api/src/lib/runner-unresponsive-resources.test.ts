/**
 * A "connected but not responding" dispatch is recorded with what the machine was doing (#924).
 *
 * That failure ends Pilot runs (#913), and its usual cause is a machine too loaded to answer the
 * relay's ping in time — which was inferred from a laptop's fan. Now the error log carries the
 * machine's last heartbeat sample beside the failure, so a postmortem can check it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { callRunner, type RunnerConn } from "./runner-client.js";
import { RunnerUnreachableError } from "./runner-unreachable.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't924-unresp', 'Coder')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}'), ('i2', 'ag', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url) VALUES ('i1', 'u1', 'pink-laptop', 'relay://'), ('i2', 'u1', 'pink-laptop', 'relay://')`);
});
afterEach(() => d1.close());

function conn(answer: Response): RunnerConn {
	const env = { DB: d1.DB, RELAY: { idFromName: (n: string) => n, get: () => ({ fetch: async () => answer.clone() }) } } as unknown as Env;
	return { endpointUrl: "relay://", token: "", instanceId: "i1", userId: "u1", env, runnerNode: "pink-laptop", relayName: "i1:node:pink-laptop" };
}
const unresponsive = () => Response.json({ error: "Runner relay is connected but not responding", code: "RUNNER_RELAY_UNRESPONSIVE" }, { status: 503 });
const logged = () => d1.DB.prepare("SELECT source, level, message, context FROM error_log WHERE user_id = 'u1'").first<{ source: string; level: string; message: string; context: string }>();

describe("an unresponsive dispatch carries the machine's last resource sample (#924)", () => {
	it("logs the freshest sample from any of the machine's agents, and still throws the same error", async () => {
		const sample = (load: number, at: number) => JSON.stringify({ loadAvg: [load, 9, 7], cpus: 8, memTotalBytes: 16e9, memFreeBytes: 1e9, platform: "darwin", sampledAt: at });
		d1.exec(`UPDATE instance_runtime_nodes SET resources = '${sample(3, 1_000)}' WHERE instance_id = 'i1'`);
		d1.exec(`UPDATE instance_runtime_nodes SET resources = '${sample(13.6, 2_000)}' WHERE instance_id = 'i2'`);
		await expect(callRunner(conn(unresponsive()), "/coding/start", {})).rejects.toBeInstanceOf(RunnerUnreachableError);
		const row = await logged();
		expect(row).toMatchObject({ source: "runner", level: "warn" });
		expect(row?.message).toContain("load 13.6 on 8 cores");
		expect(JSON.parse(row?.context ?? "{}")).toMatchObject({ instanceId: "i1", runnerNode: "pink-laptop", path: "/coding/start", resources: { load1: 13.6, loadPerCpu: 1.7 } });
	});

	it("says the machine reports nothing when its CLI predates the sample", async () => {
		await expect(callRunner(conn(unresponsive()), "/health")).rejects.toBeInstanceOf(RunnerUnreachableError);
		expect((await logged())?.message).toContain("reports no resource sample");
	});

	it("records nothing for a plain disconnect — that is not the machine being slow", async () => {
		await expect(callRunner(conn(Response.json({ error: "No runner connected" }, { status: 503 })), "/health")).rejects.toBeInstanceOf(RunnerUnreachableError);
		expect(await logged()).toBeNull();
	});
});
