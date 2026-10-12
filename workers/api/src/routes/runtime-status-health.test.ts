/**
 * `GET /runtime/status` reports heartbeat, relay, health and eligibility apart (#1032).
 *
 * The live state, on CLI 0.4.111: a fresh heartbeat and `relayConnected: true` beside a `/health`
 * 504. A fresh heartbeat used to let the failed probe answer `runtime.status: "online"`. Only the
 * relay touches are faked: a live socket is resolved, `/health` answers the relay's timeout, and
 * `/capabilities` answers.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let healthStatus = 504;

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
vi.mock("./instances-runtime.js", async () => {
	const actual = await vi.importActual<typeof import("./instances-runtime.js")>("./instances-runtime.js");
	return {
		...actual,
		getLiveRuntime: async () => d1.DB.prepare("SELECT * FROM instance_runtimes WHERE instance_id = 'i1'").first(),
		callRuntime: async (_env: unknown, _rt: unknown, path: string) =>
			path === "/health" && healthStatus !== 200
				? Response.json({ error: "Relay command timed out" }, { status: healthStatus })
				: Response.json({ ok: true }),
	};
});

const { instanceRoutes } = await import("./instances.js");

const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
beforeEach(() => {
	healthStatus = 504;
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't1032-coder', 'Coder')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, runner_node, status, last_seen_at) VALUES ('i1', 'u1', 'relay://', 'pink-laptop', 'online', '${sqlTime(Date.now() - 10_000)}')`);
});
afterEach(() => d1.close());

async function status() {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/i1/runtime/status", {}, { DB: d1.DB } as unknown as Env);
	return { code: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /runtime/status: relay attached, health timing out, heartbeat fresh (#1032)", () => {
	it("never reads online: the four facts apart, and not eligible to run work", async () => {
		const { code, body } = await status();
		expect(code).toBe(200);
		expect((body.runtime as { status: string }).status).toBe("unresponsive");
		expect((body.relay as { connected: boolean }).connected).toBe(true);
		expect(body.statusView).toMatchObject({
			status: "unresponsive",
			heartbeat: { fresh: true },
			relay: { attached: true },
			rpc: { health: "timeout", error: expect.stringMatching(/did not answer in time/) },
			eligible: { ok: false, reason: "rpc_unhealthy", detail: expect.stringMatching(/runner_restart/) },
		});
	});

	it("keeps the stored status online through the blip — it only stops CLAIMING online", async () => {
		await status();
		const row = await d1.DB.prepare("SELECT status FROM instance_runtimes WHERE instance_id = 'i1'").first<{ status: string }>();
		expect(row?.status).toBe("online");
	});

	it("a runner that answers is online and eligible", async () => {
		healthStatus = 200;
		const { body } = await status();
		expect((body.runtime as { status: string }).status).toBe("online");
		expect(body.statusView).toMatchObject({ status: "online", rpc: { health: "ok" }, eligible: { ok: true, reason: "ready" } });
	});
});
