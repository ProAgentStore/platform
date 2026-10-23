/**
 * #1312 end to end over the real schema: a runner's heartbeat carries its capability record, the platform stores a
 * validated copy and answers whether it holds the hash, the machine list and the read routes show it, and the check
 * route refuses a WebKit requirement on the macOS 12 laptop. Synthetic machines only.
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
const { capabilityHash } = await import("../lib/machine-capability-schema.js");
const { parseMachineCapabilities } = await import("../lib/machine-capability-schema.js");

const LAPTOP = "laptop-0000-machine-id";
const MINI = "mini-00000-machine-id";
let d1: RealSchemaD1;

const rec = (over: Record<string, unknown> = {}) => ({
	detectedAt: "2026-10-23T00:00:00.000Z", os: { name: "macOS", version: "12.7.6", arch: "x64" }, cpuCount: 4, memoryGb: 8, diskGb: 250, nodeVersion: "22.4.0",
	playwright: { version: "1.58.2", probes: [{ browser: "webkit", success: false, error: "Executable doesn't exist at /Users/serge/x", durationMs: 40 }] },
	ios: false, android: false, docker: false, inventory: [{ name: "git", version: "2.45.2" }], ...over,
});

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1312', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i-a', 'ag', 'u1', 'active', '{}'), ('i-b', 'ag', 'u1', 'active', '{}')`);
	for (const [inst, node, mid] of [["i-a", "Laptop", LAPTOP], ["i-b", "Mini", MINI]] as const) {
		d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, runner_node, status) VALUES ('${inst}', 'u1', 'relay://', '${node}', 'online')`);
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at) VALUES ('${inst}', 'u1', '${node}', 'relay://', '0.4.177', '${mid}', 'online', '2026-10-23 00:00:00')`);
	}
});
afterEach(() => d1.close());

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", instanceRoutes);
	a.route("/v1/terminals", terminalRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
}
const relay = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ connected: false })) }) };
const env = () => ({ DB: d1.DB, RELAY: relay }) as unknown as Env;
// biome-ignore lint/suspicious/noExplicitAny: responses are read field by field
type Body = Record<string, any>;
async function get(path: string) {
	const res = await app().request(path, {}, env());
	return { status: res.status, json: (await res.json()) as Body };
}
async function beat(instanceId: string, node: string, machineId: string, extra: Record<string, unknown>) {
	const res = await app().request(`/v1/instances/${instanceId}/runtime/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runnerNode: node, machineId, ...extra }) }, env());
	expect(res.status).toBe(200);
	return (await res.json()) as Body;
}

describe("the heartbeat carries the record (#1312)", () => {
	it("the platform asks for the record when it holds a different hash, stores it, then acknowledges the hash alone", async () => {
		const record = rec();
		const hash = await capabilityHash(parseMachineCapabilities(record)!);
		// A hash with no record behind it: the platform does not hold it and says so.
		expect(await beat("i-a", "Laptop", LAPTOP, { capabilityHash: hash })).toMatchObject({ capabilitiesWanted: true });
		// The record arrives with its hash: stored, and the answer says the hash is held.
		expect(await beat("i-a", "Laptop", LAPTOP, { capabilityHash: hash, capabilities: record })).toMatchObject({ capabilitiesStored: true });
		// Thirty seconds later: the hash alone is enough.
		const again = await beat("i-a", "Laptop", LAPTOP, { capabilityHash: hash });
		expect(again.capabilitiesStored).toBe(true);
		expect(again.capabilitiesWanted).toBeUndefined();
		// A change on the machine: a new hash is wanted in full.
		expect(await beat("i-a", "Laptop", LAPTOP, { capabilityHash: "f".repeat(64) })).toMatchObject({ capabilitiesWanted: true });
	});

	it("a runner that predates the record, or sends nothing usable, still heartbeats and stores nothing", async () => {
		expect(await beat("i-a", "Laptop", LAPTOP, {})).toMatchObject({ success: true });
		expect(await beat("i-a", "Laptop", LAPTOP, { capabilities: { nonsense: 1 } })).toMatchObject({ success: true });
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM machine_capabilities").get() as { n: number }).n).toBe(0);
	});

	it("a heartbeat with no machine id cannot attach a record to anything", async () => {
		await app().request("/v1/instances/i-a/runtime/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runnerNode: "Laptop", capabilities: rec() }) }, env());
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM machine_capabilities").get() as { n: number }).n).toBe(0);
	});

	it("stores a scrubbed copy: the path in a probe error never reaches the database", async () => {
		await beat("i-a", "Laptop", LAPTOP, { capabilities: rec() });
		const raw = (d1.sqlite.prepare("SELECT raw_json FROM machine_capabilities").get() as { raw_json: string }).raw_json;
		expect(raw).toContain("Executable doesn't exist at <path>");
		expect(raw).not.toMatch(/serge|\/Users/);
	});
});

describe("read-back (#1312)", () => {
	beforeEach(async () => {
		await beat("i-a", "Laptop", LAPTOP, { capabilities: rec() });
		await beat("i-b", "Mini", MINI, { capabilities: rec({ os: { name: "macOS", version: "14.5", arch: "arm64" }, playwright: { version: "1.60.0", probes: [{ browser: "webkit", success: true, durationMs: 700 }, { browser: "chromium", success: true, durationMs: 900 }] }, ios: true, docker: true }) });
	});

	it("every connected machine shows a record, and the tiny laptop shows WebKit and Chromium unsupported", async () => {
		const { json } = await get("/v1/terminals/nodes");
		const byId = Object.fromEntries((json.nodes as Array<{ machineId: string; capabilities: Body }>).map((n) => [n.machineId, n.capabilities]));
		expect(byId[LAPTOP]).toMatchObject({ os: "macOS 12.7.6", browsers: { webkit: { supported: false, probed: true }, chromium: { supported: false, probed: false } } });
		expect(byId[LAPTOP].browsers.chromium.reason).toMatch(/macOS 12\.7\.6 is incompatible with Playwright 1\.58\.2/);
		expect(byId[MINI]).toMatchObject({ os: "macOS 14.5", ios: true, docker: true, browsers: { webkit: { supported: true, probed: true }, chromium: { supported: true } } });
	});

	it("the machine route returns the record, its change history on request, and 404 for a machine that is not yours", async () => {
		const r = await get(`/v1/terminals/machines/${LAPTOP}/capabilities?history=1`);
		expect(r.json).toMatchObject({ reported: true, summary: { arch: "x64" }, capabilities: { nodeVersion: "22.4.0" }, history: [{ changes: ["first report"] }] });
		expect((await get("/v1/terminals/machines/nobody-0000-machine/capabilities")).status).toBe(404);
	});

	it("a machine that has not reported says so instead of an empty record", async () => {
		d1.exec("DELETE FROM machine_capabilities");
		expect((await get(`/v1/terminals/machines/${LAPTOP}/capabilities`)).json).toMatchObject({ reported: false, message: expect.stringMatching(/has not reported/) });
	});

	it("the check route is the start gate without the start: webkit fails on the laptop and passes on the mini", async () => {
		const bad = await get(`/v1/terminals/machines/${LAPTOP}/capabilities/check?needs=${encodeURIComponent("webkit,node>=22")}`);
		expect(bad.json).toMatchObject({ reported: true, satisfied: false });
		expect(bad.json.failures).toEqual([expect.stringMatching(/^needs webkit: webkit failed to launch on macOS 12\.7\.6 with Playwright 1\.58\.2: Executable doesn't exist at <path>/)]);
		expect((await get(`/v1/terminals/machines/${MINI}/capabilities/check?needs=${encodeURIComponent("webkit,node>=22,docker")}`)).json).toMatchObject({ satisfied: true, failures: [] });
		expect((await get(`/v1/terminals/machines/${MINI}/capabilities/check`)).status).toBe(400);
		expect((await get(`/v1/terminals/machines/${MINI}/capabilities/check?needs=${"a,".repeat(25)}`)).status).toBe(400);
	});
});
