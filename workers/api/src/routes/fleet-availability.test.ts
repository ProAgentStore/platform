import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { fleetHistory } from "../lib/fleet-resources.js";
import { recordHeartbeatReceipt, runnerAvailability } from "../lib/runner-heartbeat-history.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => ({ ...await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js"), requireUser: async () => ({ uid: "owner", roles: [] }) }));
const { instanceRoutes } = await import("./instances.js");
const NOW = Date.parse("2026-11-06T08:00:00Z");
let db: RealSchemaD1;
let env: Env;
beforeEach(() => {
 db = realSchemaD1(); env = { DB: db.DB } as Env;
 db.exec(`INSERT INTO users (id, github_login) VALUES ('owner','owner'),('other','other');
 INSERT INTO agents (id,owner_id,slug,name) VALUES ('a','owner','availability','Coder');
 INSERT INTO agent_instances (id,agent_id,user_id,status,config) VALUES ('i','a','owner','active','{}');
 INSERT INTO instance_runtimes (instance_id,user_id,endpoint_url,runner_node,status) VALUES ('i','owner','relay://','pink','online');
 INSERT INTO instance_runtime_nodes (instance_id,user_id,runner_node,endpoint_url,machine_id,status) VALUES ('i','owner','pink','relay://','machine-pink','online');`);
 vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); db.close(); });
async function heartbeat(body: Record<string, unknown>) {
 const app = new Hono<{ Bindings: Env }>(); app.route("/v1/instances", instanceRoutes);
 return app.request("/v1/instances/i/runtime/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
}

describe("server heartbeat receipt timeline", () => {
 it("records authenticated heartbeats without resources using receipt time, never the supplied sample clock", async () => {
  expect((await heartbeat({ runnerNode: "pink", machineId: "machine-pink" })).status).toBe(200);
  expect((await heartbeat({ runnerNode: "pink", machineId: "machine-pink", resources: { sampledAt: NOW + 999999999 } })).status).toBe(200);
  const fleet = await fleetHistory(env, "owner", { tier: "dense", now: NOW });
  expect(fleet.machines[0].latest).toBeNull();
  expect(fleet.machines[0].availability.buckets).toEqual([{ at: new Date(NOW).toISOString(), receipts: 2, firstReceivedAt: new Date(NOW).toISOString(), lastReceivedAt: new Date(NOW).toISOString() }]);
  expect(fleet.machines[0].availability.coverage).toBe("observed_only");
 });
 it("does not fabricate history from registration timestamps, resource samples, or empty gaps", async () => {
  const fleet = await fleetHistory(env, "owner", { tier: "dense", now: NOW });
  expect(fleet.machines[0].availability).toMatchObject({ buckets: [], error: null, missingBucketMeaning: "no_recorded_receipt" });
  await recordHeartbeatReceipt(env, "owner", "pink", "machine-pink", NOW - 600000);
  await recordHeartbeatReceipt(env, "owner", "pink", "machine-pink", NOW);
  const result = await runnerAvailability(env, "owner", ["machine-pink"], NOW - 7200000, NOW, NOW);
  expect(result.buckets).toHaveLength(2);
 });
 it("keeps owner isolation and merges stable identity across renames without consuming resource cursor", async () => {
  await recordHeartbeatReceipt(env, "other", "pink", "machine-pink", NOW);
  await recordHeartbeatReceipt(env, "owner", "pink-old", "machine-pink", NOW - 60000);
  await recordHeartbeatReceipt(env, "owner", "pink", "machine-pink", NOW);
  const result = await fleetHistory(env, "owner", { tier: "dense", now: NOW, since: NOW });
  expect(result.machines[0].availability.buckets.map((b) => b.receipts)).toEqual([1, 1]);
  expect(result.machines[0].points).toEqual([]);
 });
 it("adopts legacy node receipts only where inventory proves an unambiguous identity", async () => {
  await recordHeartbeatReceipt(env, "owner", "pink", null, NOW);
  const fleet = await fleetHistory(env, "owner", { tier: "dense", now: NOW });
  expect(fleet.machines[0].availability.buckets).toHaveLength(1);
 });
 it("bounds retention and returns five-minute receipt aggregates without claiming uptime", async () => {
  await recordHeartbeatReceipt(env, "owner", "pink", "machine-pink", NOW - 90000000);
  await recordHeartbeatReceipt(env, "owner", "pink", "machine-pink", NOW - 120000);
  await recordHeartbeatReceipt(env, "owner", "pink", "machine-pink", NOW - 60000);
  expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM runner_heartbeat_receipts").get() as { n: number }).n).toBe(2);
  const history = await fleetHistory(env, "owner", { tier: "coarse", from: NOW - 90000000, now: NOW });
  expect(history.machines[0].availability).toMatchObject({ bucketMs: 300000, truncated: true, coverage: "observed_only" });
  expect(history.machines[0].availability.buckets).toHaveLength(1);
  expect(history.machines[0].availability.buckets[0].receipts).toBe(2);
 });
 it("exposes storage read failure and preserves heartbeat success while migration is unavailable", async () => {
  db.exec("DROP TABLE runner_heartbeat_receipts");
  expect((await heartbeat({ runnerNode: "pink", machineId: "machine-pink" })).status).toBe(200);
  const fleet = await fleetHistory(env, "owner", { tier: "dense", now: NOW });
  expect(fleet.machines[0].availability).toMatchObject({ error: "Heartbeat receipt history unavailable", buckets: [] });
 });
});
