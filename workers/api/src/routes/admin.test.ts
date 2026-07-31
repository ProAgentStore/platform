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
function testApp(opts: { dbRoles?: string | null; allowlist?: string; audit?: unknown[]; usageRows?: unknown[]; platformAiEnabled?: boolean } = {}) {
	const app = new Hono();
	app.route("/v1/admin", adminRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		ADMIN_ALLOWLIST: opts.allowlist,
		PLATFORM_AI_ENABLED: opts.platformAiEnabled ? "true" : "false",
		DB: {
			prepare(sql: string) {
				// requireAdmin's live-role check reads FROM users with a single-row .first();
				// the usage/audit queries return result sets via .all().
				const isRoleLookup = sql.includes("SELECT roles FROM users");
				return {
					bind() {
						return {
							first: async () => (isRoleLookup ? { roles: opts.dbRoles ?? null } : null),
							all: async () =>
								sql.includes("FROM ai_usage")
									? { results: opts.usageRows ?? [] }
									: { results: opts.audit ?? [] },
							run: async () => ({}),
						};
					},
					first: async () => (isRoleLookup ? { roles: opts.dbRoles ?? null } : null),
					all: async () =>
						sql.includes("FROM ai_usage")
							? { results: opts.usageRows ?? [] }
							: { results: opts.audit ?? [] },
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
		expect(body.platformPaid.metered).toBe(false);
		expect(body.topSpenders[0].label).toBe("alice");
	});
});
