import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { adminRoutes } from "./admin.js";

const TEST_SECRET = "test-secret";

/**
 * Build a test app with a mocked D1. `dbRoles` is what `SELECT roles FROM users`
 * returns for the live-role check; `allowlist` seeds ADMIN_ALLOWLIST; `audit` is
 * the rows the audit query returns.
 */
function testApp(opts: { dbRoles?: string | null; allowlist?: string; audit?: unknown[]; usageRows?: unknown[]; platformAiEnabled?: boolean; userRows?: unknown[]; userCount?: number; userDetail?: unknown } = {}) {
	const app = new Hono();
	app.route("/v1/admin", adminRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	// Route a query to the right canned result by inspecting its SQL.
	const firstFor = (sql: string) => {
		if (sql.includes("SELECT roles FROM users")) return { roles: opts.dbRoles ?? null };
		if (sql.includes("COUNT(*) AS n FROM users")) return { n: opts.userCount ?? (opts.userRows?.length ?? 0) };
		if (sql.includes("FROM users u WHERE u.id")) return opts.userDetail ?? null; // getUserDetail main row
		return null;
	};
	const allFor = (sql: string) => {
		// Order matters: the users list SELECTs an ai_usage sub-query, so match the
		// primary table first. The usage endpoint aliases the ledger as "ai_usage u".
		if (sql.includes("FROM users u")) return { results: opts.userRows ?? [] }; // listUsers page
		if (sql.includes("FROM ai_usage u")) return { results: opts.usageRows ?? [] };
		if (sql.includes("admin_audit_log")) return { results: opts.audit ?? [] };
		return { results: [] }; // agents/instances/keys/errors sub-queries in getUserDetail
	};
	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		ADMIN_ALLOWLIST: opts.allowlist,
		PLATFORM_AI_ENABLED: opts.platformAiEnabled ? "true" : "false",
		DB: {
			prepare(sql: string) {
				const first = async () => firstFor(sql);
				const all = async () => allFor(sql);
				return {
					bind() {
						return { first, all, run: async () => ({}) };
					},
					first,
					all,
				};
			},
		},
	};
	return { app, env };
}

async function token(uid: string, roles: string[]) {
	return signSession(uid, TEST_SECRET, { roles });
}

function req(app: Hono, env: unknown, path: string, tok?: string) {
	return app.request(path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }, env);
}

describe("GET /v1/admin/me", () => {
	it("returns admin:true when the session carries the admin role", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/admin/me", await token("u1", ["user", "admin"]));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ admin: true });
	});

	it("returns admin:false (not 403) for a non-admin", async () => {
		const { app, env } = testApp({ dbRoles: '["user"]' });
		const res = await req(app, env, "/v1/admin/me", await token("u2", ["user"]));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ admin: false });
	});

	it("honors a live users.roles grant even when the token lacks admin", async () => {
		const { app, env } = testApp({ dbRoles: '["user","admin"]' });
		const res = await req(app, env, "/v1/admin/me", await token("u3", ["user"]));
		expect(await res.json()).toEqual({ admin: true });
	});

	it("honors the ADMIN_ALLOWLIST break-glass fallback by uid", async () => {
		const { app, env } = testApp({ dbRoles: '["user"]', allowlist: "u4, u9" });
		const res = await req(app, env, "/v1/admin/me", await token("u4", ["user"]));
		expect(await res.json()).toEqual({ admin: true });
	});

	it("401s without a token", async () => {
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/admin/me");
		expect(res.status).toBe(401);
	});
});

describe("GET /v1/admin/audit", () => {
	it("403s a non-admin", async () => {
		const { app, env } = testApp({ dbRoles: '["user"]' });
		const res = await req(app, env, "/v1/admin/audit", await token("u2", ["user"]));
		expect(res.status).toBe(403);
	});

	it("returns rows for an admin", async () => {
		const audit = [
			{ id: "a1", created_at: "2026-08-01T00:00:00Z", actor_user_id: "u1", action: "user.suspend", target_type: "user", target_id: "u9", detail: null },
		];
		const { app, env } = testApp({ audit });
		const res = await req(app, env, "/v1/admin/audit", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ count: 1, audit });
	});
});

const USAGE_ROWS = [
	{ user_id: "u1", agent_id: null, instance_id: null, provider: "anthropic", model: "claude-sonnet-4-6", kind: "chat", input_tokens: 1000, output_tokens: 500, cost_micros: 10500, created_at: "2026-08-01 10:00:00", agent_name: null, user_login: "alice" },
	{ user_id: "u2", agent_id: null, instance_id: null, provider: "platform", model: "@cf/baai/bge-base-en-v1.5", kind: "embedding", input_tokens: 200, output_tokens: 0, cost_micros: 40, created_at: "2026-08-01 11:00:00", agent_name: null, user_login: "bob" },
];

describe("GET /v1/admin/users", () => {
	const USER_ROWS = [
		{ id: "u1", github_login: "alice", github_name: "Alice", avatar_url: "", roles: '["user","admin"]', subscription_status: "active", created_at: "2026-07-01 00:00:00", updated_at: "2026-08-01 00:00:00", agents_owned: 2, active_instances: 1, key_providers: "anthropic,openai", spend_30d_micros: 12345 },
		{ id: "u2", github_login: "bob", github_name: "Bob", avatar_url: "", roles: null, subscription_status: "none", created_at: "2026-07-02 00:00:00", updated_at: "2026-08-01 00:00:00", agents_owned: 0, active_instances: 0, key_providers: null, spend_30d_micros: 0 },
	];

	it("403s a non-admin", async () => {
		const { app, env } = testApp({ dbRoles: '["user"]' });
		const res = await req(app, env, "/v1/admin/users", await token("u2", ["user"]));
		expect(res.status).toBe(403);
	});

	it("lists users with parsed roles, key providers, and totals", async () => {
		const { app, env } = testApp({ userRows: USER_ROWS, userCount: 2 });
		const res = await req(app, env, "/v1/admin/users", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.total).toBe(2);
		expect(body.users[0].roles).toEqual(["user", "admin"]);
		expect(body.users[0].key_providers).toEqual(["anthropic", "openai"]);
		expect(body.users[0].spend30dMicros).toBe(12345);
		// null roles / null providers degrade safely
		expect(body.users[1].roles).toEqual(["user"]);
		expect(body.users[1].key_providers).toEqual([]);
	});
});

describe("GET /v1/admin/users/:id", () => {
	it("404s when the user does not exist", async () => {
		const { app, env } = testApp({ userDetail: null });
		const res = await req(app, env, "/v1/admin/users/nope", await token("u1", ["admin"]));
		expect(res.status).toBe(404);
	});

	it("returns detail with empty sub-collections", async () => {
		const detail = { id: "u1", github_login: "alice", github_name: "Alice", avatar_url: "", roles: '["user"]', subscription_status: "none", created_at: "2026-07-01 00:00:00", updated_at: "2026-08-01 00:00:00", agents_owned: 0, active_instances: 0, key_providers: null, spend_30d_micros: 0 };
		const { app, env } = testApp({ userDetail: detail });
		const res = await req(app, env, "/v1/admin/users/u1", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.user.github_login).toBe("alice");
		expect(body.agents).toEqual([]);
		expect(body.recentErrors).toEqual([]);
	});
});

describe("GET /v1/admin/usage", () => {
	it("403s a non-admin", async () => {
		const { app, env } = testApp({ dbRoles: '["user"]' });
		const res = await req(app, env, "/v1/admin/usage", await token("u2", ["user"]));
		expect(res.status).toBe(403);
	});

	it("returns a cross-user rollup for an admin", async () => {
		const { app, env } = testApp({ usageRows: USAGE_ROWS });
		const res = await req(app, env, "/v1/admin/usage?range=30d", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.totals.calls).toBe(2);
		expect(body.byUser.map((b: any) => b.label).sort()).toEqual(["alice", "bob"]);
		expect(body.split.platformPaid.calls).toBe(1);
		expect(body.split.byok.calls).toBe(1);
	});
});

describe("GET /v1/admin/spending", () => {
	it("surfaces BYOK spend, top spenders, and the platform-paid caveat", async () => {
		const { app, env } = testApp({ usageRows: USAGE_ROWS, platformAiEnabled: true });
		const res = await req(app, env, "/v1/admin/spending", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.byok.costMicros).toBe(10500);
		expect(body.platformAiEnabled).toBe(true);
		expect(body.platformPaid.metered).toBe(true);
		expect(body.platformPaid.estimated).toBe(true);
		expect(body.platformPaid.calls).toBe(1); // the platform embedding row
		expect(body.topSpenders[0].label).toBe("alice");
	});
});
