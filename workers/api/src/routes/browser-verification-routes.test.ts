/**
 * Browser verification settings and runtime eligibility over the real schema (#1031). Only the relay
 * is faked: which `<instance>@<node>` sockets exist, and how each runner answers `/health`.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

const live = new Set<string>();
const unhealthy = new Set<string>();
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	relayConnected: async (_env: unknown, id: string, node: string) => live.has(`${id}@${node}`),
	getRunnerConnIgnoringLiveness: async (_env: unknown, id: string, _uid: string, node: string) => ({ instanceId: id, runnerNode: node }),
	callRunner: async (conn: { instanceId: string; runnerNode: string }, path: string) => {
		if (path === "/health" && unhealthy.has(conn.runnerNode)) throw new Error('Runner /health → 504: {"error":"Relay command timed out"}');
		return { ok: true };
	},
}));

const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
beforeEach(() => {
	live.clear();
	unhealthy.clear();
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('scout', 'u1', 't1031-scout', 'Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{}}}'),
	  ('chat', 'u1', 't1031-chat', 'Chat', '{"capabilities":{"surfaces":[],"runtime":null}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('i1', 'scout', 'u1', 'active', '{"runnerNode":"mac"}'),
	  ('i2', 'chat', 'u1', 'active', '{}')`);
	const node = (inst: string, n: string, machine: string, version: string) =>
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at)
		         VALUES ('${inst}', 'u1', '${n}', 'relay://', '${version}', '${machine}', 'online', datetime('now'))`);
	node("i1", "mac", "m-mac", "0.4.114");
	node("i1", "dell", "m-dell", "0.4.114");
	node("i1", "pink", "m-pink", "0.4.114");
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { DB: d1.DB } as unknown as Env);
	// biome-ignore lint/suspicious/noExplicitAny: assertions read the JSON field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("browser verification settings (#1031)", () => {
	it("reads defaults beside the declared capability, the pin and the events the notification policy decides", async () => {
		const res = await call("GET", "/i1/browser-verification");
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ settings: { enabled: false, runtime: "pinned" }, capability: { declared: true }, runnerNode: "mac" });
		expect(res.body.notificationEvents).toEqual(expect.arrayContaining(["takeover_required", "browser_verification_failed", "browser_verification_completed"]));
	});

	it("an owner turns the declared capability on, and it is stored on the instance only", async () => {
		const res = await call("PUT", "/i1/browser-verification", { enabled: true, runtime: "any_eligible", allowMobile: false });
		expect(res.body.settings).toMatchObject({ enabled: true, runtime: "any_eligible", allowMobile: false });
		expect((await call("GET", "/i1/browser-verification")).body.settings).toMatchObject({ enabled: true, runtime: "any_eligible" });
		// The pin is untouched: attachment is not a verification setting.
		expect((await call("GET", "/i1/browser-verification")).body.runnerNode).toBe("mac");
	});

	it("refuses to enable it on an agent that does not declare a local browser, and refuses pin or consent fields", async () => {
		expect(await call("PUT", "/i2/browser-verification", { enabled: true })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/does not declare a local browser/) } });
		expect((await call("GET", "/i2/browser-verification")).body.capability).toMatchObject({ declared: false });
		expect(await call("PUT", "/i1/browser-verification", { runnerNode: "dell" })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/runner-node/) } });
	});
});

describe("eligible browser runtimes (#1031)", () => {
	it("reports attachment, health and eligibility apart, and selects the pinned machine only when eligible", async () => {
		live.add("i1@mac");
		live.add("i1@dell");
		unhealthy.add("mac");
		const res = await call("GET", "/i1/browser-verification/runtimes");
		const by = Object.fromEntries((res.body.machines as Array<{ node: string }>).map((m) => [m.node, m]));
		expect(by.mac).toMatchObject({ pinned: true, attached: true, health: { state: "timeout" }, eligible: false, reason: "unhealthy" });
		expect(by.dell).toMatchObject({ pinned: false, attached: true, health: { state: "ok" }, eligible: true });
		expect(by.pink).toMatchObject({ attached: false, eligible: false, reason: "not_attached" });
		// runtime "pinned": the pinned machine is unhealthy, so nothing is selected and the fallback applies.
		expect(res.body).toMatchObject({ runtime: "pinned", selected: null, fallback: "wait" });
		await call("PUT", "/i1/browser-verification", { runtime: "any_eligible" });
		expect((await call("GET", "/i1/browser-verification/runtimes")).body.selected).toBe("dell");
	});

	it("an agent without the capability lists nothing", async () => {
		expect((await call("GET", "/i2/browser-verification/runtimes")).body).toMatchObject({ capability: { declared: false }, machines: [], selected: null });
	});
});
