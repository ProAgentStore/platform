/**
 * The transient answer the console's readers are built around (#933), pinned at the source.
 *
 * When the live probe THROWS, `GET /v1/instances/:id/runtime/status` answers one of two ways:
 *   - runner seen recently → 200 `{runtime:{status:"online"}, transient:true}` with NO `relay` —
 *     it has no fresh socket reading and must not invent one;
 *   - heartbeat stale → 502 with `runtime.status: "offline"`, a genuine offline.
 * coder-web's `relayVerdict` keeps the last reading on the first and says offline on the second; if
 * this shape changes, those readers are wrong, so this test fails first.
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
// Only the two relay touches are faked: no live socket was resolved, and the probe itself throws.
vi.mock("./instances-runtime.js", async () => {
	const actual = await vi.importActual<typeof import("./instances-runtime.js")>("./instances-runtime.js");
	return {
		...actual,
		getLiveRuntime: async () => null,
		callRuntime: async () => {
			throw new Error("relay probe failed");
		},
	};
});

const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't933-coder', 'Coder')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}')`);
});
afterEach(() => d1.close());

async function status(lastSeenMsAgo: number) {
	d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, runner_node, status, last_seen_at) VALUES ('i1', 'u1', 'relay://', 'pink-laptop', 'online', '${sqlTime(Date.now() - lastSeenMsAgo)}')`);
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request("/v1/instances/i1/runtime/status", {}, { DB: d1.DB } as unknown as Env);
	return { code: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /runtime/status when the probe throws (#933)", () => {
	it("a recently-seen runner answers transient, with NO relay reading", async () => {
		const { code, body } = await status(10_000);
		expect(code).toBe(200);
		expect(body.transient).toBe(true);
		expect(body).not.toHaveProperty("relay");
		expect((body.runtime as { status: string }).status).toBe("online");
	});

	it("a runner whose heartbeat went stale answers a genuine offline", async () => {
		const { code, body } = await status(30 * 60_000);
		expect(code).toBe(502);
		expect(body.transient).toBeUndefined();
		expect((body.runtime as { status: string }).status).toBe("offline");
	});
});
