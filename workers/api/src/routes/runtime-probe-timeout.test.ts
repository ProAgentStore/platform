/**
 * #1167 — a liveness probe through the relay is bounded. `callRuntime` sent `{ method, path, body }` with no `timeoutMs`, so a wedged
 * runtime held `/runtime/status` for the relay's whole 120s command deadline. Probes now ask for 5s; commands that may run long still don't.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
const asked: Array<{ path: string; body: Record<string, unknown> }> = [];

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { callRuntime, RUNTIME_PROBE_TIMEOUT_MS } = await import("./instances-runtime.js");
const { instanceRoutes } = await import("./instances.js");

/** A relay that records the command it is handed and answers it. */
const relay = {
	idFromName: (n: string) => n,
	get: () => ({
		fetch: async (req: Request) => {
			const body = (await req.json()) as Record<string, unknown>;
			asked.push({ path: String(body.path), body });
			return Response.json({ ok: true });
		},
	}),
};
const row = { instance_id: "i1", runner_node: "pink-laptop" } as unknown as Parameters<typeof callRuntime>[1];
const env = () => ({ DB: d1.DB, RELAY: relay }) as unknown as Env;

const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
beforeEach(() => {
	asked.length = 0;
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec("INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't1167-coder', 'Coder')");
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}')");
	d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, endpoint_url, runner_node, status, last_seen_at) VALUES ('i1', 'u1', 'relay://', 'pink-laptop', 'online', '${sqlTime(Date.now() - 10_000)}')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, status, last_seen_at, updated_at) VALUES ('i1', 'u1', 'pink-laptop', 'relay://', 'online', '${sqlTime(Date.now() - 10_000)}', '${sqlTime(Date.now() - 10_000)}')`);
});
afterEach(() => d1.close());

describe("callRuntime's relay command", () => {
	it("carries the probe timeout when asked, and none when not (a long command keeps the relay's own deadline)", async () => {
		await callRuntime(env(), row, "/health", {}, { timeoutMs: RUNTIME_PROBE_TIMEOUT_MS });
		await callRuntime(env(), row, "/coding/start", { method: "POST", body: JSON.stringify({ a: 1 }) });
		expect(asked[0].body).toEqual({ method: "GET", path: "/health", timeoutMs: 5000 });
		expect(asked[1].body).toEqual({ method: "POST", path: "/coding/start", body: { a: 1 } });
		expect("timeoutMs" in asked[1].body).toBe(false);
	});

	it("the probe bound is seconds, well under the relay's 120s", () => {
		expect(RUNTIME_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
		expect(RUNTIME_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
	});
});

describe("GET /runtime/status", () => {
	it("asks the relay for /health and /capabilities with the short timeout", async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/instances", instanceRoutes);
		app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
		await app.request("/v1/instances/i1/runtime/status", {}, env());
		const probes = asked.filter((a) => a.path === "/health" || a.path === "/capabilities");
		expect(probes.map((p) => p.path).sort()).toEqual(["/capabilities", "/health"]);
		for (const p of probes) expect(p.body.timeoutMs, p.path).toBe(RUNTIME_PROBE_TIMEOUT_MS);
	});
});
