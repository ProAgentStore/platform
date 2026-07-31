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
function testApp(opts: { dbRoles?: string | null; allowlist?: string; audit?: unknown[] } = {}) {
	const app = new Hono();
	app.route("/v1/admin", adminRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		ADMIN_ALLOWLIST: opts.allowlist,
		DB: {
			prepare(sql: string) {
				return {
					bind() {
						return {
							first: async () =>
								sql.includes("FROM users") ? { roles: opts.dbRoles ?? null } : null,
							all: async () => ({ results: opts.audit ?? [] }),
							run: async () => ({}),
						};
					},
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
