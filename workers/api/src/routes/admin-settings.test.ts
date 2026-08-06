import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { adminSettingsRoutes } from "./admin-settings.js";

/**
 * The runtime platform-AI kill switch (#46). Cloudflare Access on the /v1/admin
 * perimeter (#108) is still OPEN, so every assertion here is about the route defending
 * itself: the authorization boundary is asserted PER ROUTE, not once via a helper,
 * because a route that forgets `requireAdmin` is exactly the failure this catches.
 */

const SECRET = "admin-settings-test-secret";

function testApp(opts: { dbRoles?: string | null; row?: { value: string } | null } = {}) {
	const app = new Hono();
	app.route("/v1/admin", adminSettingsRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	let row = opts.row ?? null;
	const audit: Array<{ sql: string; binds: unknown[] }> = [];
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		PLATFORM_AI_ENABLED: "true",
		DB: {
			prepare(sql: string) {
				const exec = (binds: unknown[]) => {
					if (sql.includes("SELECT suspended FROM users")) return { suspended: 0 };
					if (sql.includes("SELECT roles, github_login FROM users")) {
						return { roles: opts.dbRoles ?? null, github_login: null };
					}
					if (sql.includes("admin_audit_log")) {
						audit.push({ sql, binds });
						return null;
					}
					// Order matters: DELETE also contains "FROM platform_settings", so the
					// mutations have to be matched before the read.
					if (sql.startsWith("DELETE FROM platform_settings")) {
						row = null;
						return null;
					}
					if (sql.startsWith("SELECT") && sql.includes("FROM platform_settings")) return row;
					if (sql.includes("INSERT INTO platform_settings")) {
						row = { value: String(binds[1]) };
						return null;
					}
					return null;
				};
				return {
					bind: (...binds: unknown[]) => ({
						first: async () => exec(binds),
						run: async () => {
							exec(binds);
							return {};
						},
						all: async () => ({ results: [] }),
					}),
				};
			},
		},
	};
	return { app, env, audit: () => audit, current: () => row };
}

const adminToken = () => signSession("admin-1", SECRET, { roles: ["user", "admin"] });
const userToken = () => signSession("u2", SECRET, { roles: ["user"] });

function put(app: Hono, env: unknown, body: unknown, tok?: string) {
	return app.request(
		"/v1/admin/settings/platform-ai",
		{
			method: "PUT",
			headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
			body: JSON.stringify(body),
		},
		env,
	);
}

describe("GET /v1/admin/settings/platform-ai", () => {
	it("403s a signed-in non-admin", async () => {
		// Asserted on THIS route, not via a shared helper — the gate is a line inside the
		// handler and only a per-route test proves the line is there.
		const { app, env } = testApp({ dbRoles: '["user"]' });
		const res = await app.request(
			"/v1/admin/settings/platform-ai",
			{ headers: { Authorization: `Bearer ${await userToken()}` } },
			env,
		);
		expect(res.status).toBe(403);
	});

	it("401s an anonymous caller", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/admin/settings/platform-ai", {}, env);
		expect(res.status).toBe(401);
	});

	it("reports the resolved value, its source, and the off-warning", async () => {
		const { app, env } = testApp();
		const res = await app.request(
			"/v1/admin/settings/platform-ai",
			{ headers: { Authorization: `Bearer ${await adminToken()}` } },
			env,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ enabled: true, source: "env", envDefault: true, override: null });
		// The RAG-goes-dark consequence travels with the lever, so the operator cannot flip
		// it without the warning being in the same payload the UI already reads.
		expect(String(body.warning)).toContain("RAG goes dark");
	});
});

describe("PUT /v1/admin/settings/platform-ai", () => {
	it("403s a signed-in non-admin, and does not write", async () => {
		// The important half is the second clause: a rejected caller must not have flipped
		// the platform's AI off on the way to the 403.
		const { app, env, current } = testApp({ dbRoles: '["user"]' });
		const res = await put(app, env, { enabled: false }, await userToken());
		expect(res.status).toBe(403);
		expect(current()).toBeNull();
	});

	it("401s an anonymous caller, and does not write", async () => {
		const { app, env, current } = testApp();
		const res = await put(app, env, { enabled: false });
		expect(res.status).toBe(401);
		expect(current()).toBeNull();
	});

	it("kills platform-paid AI and takes effect on the next read", async () => {
		const { app, env, current } = testApp();
		const res = await put(app, env, { enabled: false }, await adminToken());
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ enabled: false, source: "override", override: false });
		expect(current()).toEqual({ value: "false" });
	});

	it("clears the override when sent null", async () => {
		const { app, env, current } = testApp({ row: { value: "false" } });
		const res = await put(app, env, { enabled: null }, await adminToken());
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ enabled: true, source: "env", override: null });
		expect(current()).toBeNull();
	});

	it("rejects a non-boolean instead of coercing it", async () => {
		// Prevents the worst outcome this route has available: the string "false" is truthy
		// in JS, so coercion would turn "kill the spend" into "leave it running".
		const { app, env, current } = testApp();
		for (const enabled of ["false", 0, "off", {}]) {
			const res = await put(app, env, { enabled }, await adminToken());
			expect(res.status).toBe(400);
		}
		expect(current()).toBeNull();
	});

	it("audits the flip with the before and after state", async () => {
		// Prevents an unattributable change to platform-wide behaviour — "who turned the
		// platform's AI off at 3am" has to be answerable after the fact.
		const { app, env, audit } = testApp();
		await put(app, env, { enabled: false }, await adminToken());
		const rows = audit();
		expect(rows).toHaveLength(1);
		expect(rows[0].binds[1]).toBe("admin-1"); // actor
		expect(rows[0].binds[2]).toBe("settings.platform_ai"); // action
		const detail = JSON.parse(String(rows[0].binds[5])) as { before: unknown; after: unknown };
		expect(detail.before).toMatchObject({ enabled: true, override: null });
		expect(detail.after).toMatchObject({ enabled: false, override: false });
	});
});
