import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { adminInstanceDetailRoutes } from "./admin-instance-detail.js";

const TEST_SECRET = "test-secret";

const INSTANCE = {
	id: "i1",
	agent_id: "a1",
	user_id: "u9",
	status: "active",
	config: "{}",
	created_at: "2026-08-01 00:00:00",
	updated_at: "2026-08-02 00:00:00",
	agent_name: "Coder",
	agent_slug: "coder",
	owner_login: "alice",
};

/** `relayConnected` returns `connected` from the RelayDO; with no RELAY binding it is false. */
function testApp(opts: { dbRoles?: string | null; instance?: unknown; nodes?: unknown[]; relayConnected?: boolean } = {}) {
	const app = new Hono();
	app.route("/v1/admin", adminInstanceDetailRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: String(err) }, 500);
	});
	const firstFor = (sql: string) => {
		if (sql.includes("SELECT suspended FROM users")) return { suspended: 0 };
		if (sql.includes("SELECT roles, github_login FROM users")) return { roles: opts.dbRoles ?? null, github_login: null };
		if (sql.includes("FROM agent_instances i")) return opts.instance === undefined ? INSTANCE : opts.instance;
		if (sql.includes("FROM ai_usage")) return { calls: 0, input_tokens: 0, output_tokens: 0, cost_micros: 0 };
		return null;
	};
	const allFor = (sql: string) => ({ results: sql.includes("instance_runtime_nodes") ? (opts.nodes ?? []) : [] });
	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		RELAY: opts.relayConnected === undefined
			? undefined
			: {
					idFromName: () => "id",
					get: () => ({ fetch: async () => new Response(JSON.stringify({ connected: opts.relayConnected })) }),
				},
		DB: {
			prepare(sql: string) {
				const first = async () => firstFor(sql);
				const all = async () => allFor(sql);
				return { bind: () => ({ first, all, run: async () => ({}) }), first, all };
			},
		},
	};
	return { app, env };
}

const token = (uid: string, roles: string[]) => signSession(uid, TEST_SECRET, { roles });

const get = (app: Hono, env: unknown, path: string, tok?: string) =>
	app.request(path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }, env);

const NODE = {
	runner_node: "laptop",
	placement: "local",
	status: "online", // the STALE column — deliberately contradicts the live check below
	last_seen_at: "2026-07-01 00:00:00",
	runner_version: "0.4.16",
	capabilities: "{}",
	created_at: "2026-07-01 00:00:00",
	updated_at: "2026-07-01 00:00:00",
};

describe("GET /v1/admin/instances/:id/detail", () => {
	it("403s a non-admin", async () => {
		const { app, env } = testApp({ dbRoles: '["user"]' });
		expect((await get(app, env, "/v1/admin/instances/i1/detail", await token("u2", ["user"]))).status).toBe(403);
	});

	it("401s without a token", async () => {
		const { app, env } = testApp();
		expect((await get(app, env, "/v1/admin/instances/i1/detail")).status).toBe(401);
	});

	it("404s an unknown instance", async () => {
		const { app, env } = testApp({ instance: null });
		expect((await get(app, env, "/v1/admin/instances/nope/detail", await token("u1", ["admin"]))).status).toBe(404);
	});

	it("reports the LIVE relay status, overriding the stale runtime-node status column", async () => {
		// instance_runtime_nodes.status is not cleared on an unclean disconnect, so it can
		// say "online" for a machine that has been off since July. An operator debugging
		// "why is nothing running" was being told the runner was fine (issue #31 AC).
		const { app, env } = testApp({ nodes: [NODE], relayConnected: false });
		const res = await get(app, env, "/v1/admin/instances/i1/detail", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const b = (await res.json()) as { runtimeConnected: boolean; runtimeNodes: Array<{ status: string; connected: boolean }> };
		expect(b.runtimeNodes[0].status).toBe("online"); // the DB's claim, kept for comparison
		expect(b.runtimeNodes[0].connected).toBe(false); // the truth
		expect(b.runtimeConnected).toBe(false);
	});

	it("reports connected when a relay socket really is open", async () => {
		const { app, env } = testApp({ nodes: [NODE], relayConnected: true });
		const b = (await (await get(app, env, "/v1/admin/instances/i1/detail", await token("u1", ["admin"]))).json()) as { runtimeConnected: boolean };
		expect(b.runtimeConnected).toBe(true);
	});

	it("never returns a runtime-node token column", async () => {
		// The node rows hold the runner's envelope-encrypted token; an operator view must
		// not become a credential-exfiltration path.
		const { app, env } = testApp({ nodes: [NODE], relayConnected: true });
		const raw = await (await get(app, env, "/v1/admin/instances/i1/detail", await token("u1", ["admin"]))).text();
		expect(raw).not.toMatch(/token_ciphertext|token_dek_wrapped|token_iv|token_plaintext/);
	});
});
