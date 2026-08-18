import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { adminModerationRoutes } from "./admin-moderation.js";

const TEST_SECRET = "test-secret";

interface Recorded {
	sql: string;
	binds: unknown[];
}

/**
 * Test app with a mocked D1 that RECORDS every statement, so a test can assert both
 * what changed and that the audit row was written. `rows` maps a SQL fragment to the
 * canned `first()` result.
 */
function testApp(opts: { dbRoles?: string | null; rows?: Array<[string, unknown]>; changes?: number } = {}) {
	const app = new Hono();
	app.route("/v1/admin", adminModerationRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: String(err) }, 500);
	});
	const recorded: Recorded[] = [];
	const firstFor = (sql: string) => {
		// requireUser's own suspension probe for the CALLER — matched first so a canned
		// target-user row (which is also a "FROM users WHERE id" query) can't accidentally
		// suspend the acting operator and turn every assertion into a 403.
		if (sql.includes("SELECT suspended FROM users")) return { suspended: 0 };
		// The isAdmin live-role probe. Must be matched before the generic user lookups.
		if (sql.includes("SELECT roles, github_login FROM users")) return { roles: opts.dbRoles ?? null, github_login: null };
		for (const [frag, row] of opts.rows ?? []) if (sql.includes(frag)) return row;
		return null;
	};
	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		DB: {
			prepare(sql: string) {
				const stmt = (binds: unknown[]) => ({
					first: async () => firstFor(sql),
					all: async () => ({ results: [] }),
					run: async () => {
						recorded.push({ sql, binds });
						return { meta: { changes: opts.changes ?? 1 } };
					},
					__sql: sql,
					__binds: binds,
				});
				return {
					bind: (...binds: unknown[]) => stmt(binds),
					first: async () => firstFor(sql),
					all: async () => ({ results: [] }),
					run: async () => {
						recorded.push({ sql, binds: [] });
						return { meta: { changes: opts.changes ?? 1 } };
					},
				};
			},
			batch: async (stmts: Array<{ __sql: string; __binds: unknown[] }>) => {
				for (const s of stmts) recorded.push({ sql: s.__sql, binds: s.__binds });
				return [];
			},
		},
	};
	return { app, env, recorded };
}

const token = (uid: string, roles: string[]) => signSession(uid, TEST_SECRET, { roles });

function call(app: Hono, env: unknown, method: string, path: string, tok?: string, json?: unknown) {
	return app.request(
		path,
		{
			method,
			headers: {
				...(tok ? { Authorization: `Bearer ${tok}` } : {}),
				...(json ? { "Content-Type": "application/json" } : {}),
			},
			...(json ? { body: JSON.stringify(json) } : {}),
		},
		env,
	);
}

/** Did exactly one admin_audit_log row get written, and with this action? */
function auditRows(recorded: Recorded[]) {
	return recorded.filter((r) => r.sql.includes("admin_audit_log"));
}

const USER = { id: "u9", github_login: "victim", roles: '["user"]', suspended: 0 };
const AGENT = { id: "a1", slug: "coder", name: "Coder", visibility: "published", owner_id: "u9" };
const INSTANCE = { id: "i1", agent_id: "a1", user_id: "u9", status: "active" };
/** The single subscriber-count read the delete route makes (`countAgentSubscribers`, #646). */
const SUBSCRIBED: [string, unknown] = [
	"AS foreign_subscriptions",
	{ instances: 3, active_instances: 3, foreign_instances: 3, subscriptions: 3, foreign_subscriptions: 3 },
];

/**
 * The authorization boundary, asserted PER ROUTE rather than inferred from a shared
 * helper. These routes deliberately break the platform's tenant-isolation invariant, so
 * "the gate is surely there because the other handlers have it" is not good enough: a new
 * handler that forgets `requireAdmin` would be a cross-tenant destructive endpoint open
 * to any signed-in user. Issue #108 (Cloudflare Access on the /v1/admin perimeter) is
 * still open, so nothing upstream is covering for a missing gate here.
 */
describe("moderation routes reject a non-admin (per route)", () => {
	const routes: Array<[string, string, unknown?]> = [
		["POST", "/v1/admin/users/u9/suspend", { reason: "spam" }],
		["POST", "/v1/admin/users/u9/unsuspend"],
		["PUT", "/v1/admin/users/u9/roles", { roles: ["user", "admin"] }],
		["POST", "/v1/admin/users/u9/keys/revoke", { provider: "anthropic" }],
		["POST", "/v1/admin/agents/a1/unpublish"],
		["DELETE", "/v1/admin/agents/a1", { confirm: "coder" }],
		["POST", "/v1/admin/instances/i1/cancel"],
	];

	for (const [method, path, json] of routes) {
		it(`403s ${method} ${path}`, async () => {
			const { app, env, recorded } = testApp({ dbRoles: '["user"]', rows: [["FROM users WHERE id", USER], ["FROM agents WHERE id", AGENT], ["FROM agent_instances WHERE id", INSTANCE]] });
			const res = await call(app, env, method, path, await token("attacker", ["user", "creator"]), json);
			expect(res.status).toBe(403);
			// And nothing was mutated on the way to the rejection.
			expect(recorded).toEqual([]);
		});

		it(`401s ${method} ${path} without a token`, async () => {
			const { app, env } = testApp();
			expect((await call(app, env, method, path, undefined, json)).status).toBe(401);
		});
	}
});

describe("POST /v1/admin/users/:id/suspend", () => {
	it("suspends, stores the reason, and writes one audit row", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM users WHERE id", USER]] });
		const res = await call(app, env, "POST", "/v1/admin/users/u9/suspend", await token("op", ["admin"]), { reason: "abuse" });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, suspended: true, reason: "abuse" });
		const update = recorded.find((r) => r.sql.includes("SET suspended = 1"));
		expect(update?.binds).toEqual(["u9", "abuse"]);
		const audit = auditRows(recorded);
		expect(audit).toHaveLength(1); // an unaudited suspension is not acceptable
		expect(audit[0].binds[2]).toBe("user.suspend");
		expect(audit[0].binds[4]).toBe("u9");
	});

	it("404s an unknown user instead of writing a phantom audit row", async () => {
		const { app, env, recorded } = testApp({ rows: [] });
		expect((await call(app, env, "POST", "/v1/admin/users/nope/suspend", await token("op", ["admin"]))).status).toBe(404);
		expect(recorded).toEqual([]);
	});

	it("refuses to suspend the caller's OWN account", async () => {
		// Self-suspension locks the only operator out of the portal that would undo it,
		// and requireUser reads suspension live, so it takes effect on the very next call.
		const { app, env, recorded } = testApp({ rows: [["FROM users WHERE id", { ...USER, id: "op" }]] });
		const res = await call(app, env, "POST", "/v1/admin/users/op/suspend", await token("op", ["admin"]));
		expect(res.status).toBe(400);
		expect(recorded).toEqual([]);
	});
});

describe("POST /v1/admin/users/:id/unsuspend", () => {
	it("clears the flag and audits", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM users WHERE id", { ...USER, suspended: 1 }]] });
		const res = await call(app, env, "POST", "/v1/admin/users/u9/unsuspend", await token("op", ["admin"]));
		expect(res.status).toBe(200);
		expect(recorded.some((r) => r.sql.includes("SET suspended = 0"))).toBe(true);
		expect(auditRows(recorded)[0].binds[2]).toBe("user.unsuspend");
	});
});

describe("PUT /v1/admin/users/:id/roles", () => {
	it("sets a validated role list, always implying 'user'", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM users WHERE id", USER]] });
		const res = await call(app, env, "PUT", "/v1/admin/users/u9/roles", await token("op", ["admin"]), { roles: ["creator"] });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ roles: ["user", "creator"] });
		expect(recorded.find((r) => r.sql.includes("SET roles"))?.binds).toEqual(["u9", '["user","creator"]']);
		expect(auditRows(recorded)[0].binds[2]).toBe("user.roles");
	});

	it("rejects a role outside the closed set", async () => {
		// `users.roles` is free-form JSON; without this an operator typo ('admn', or an
		// invented 'superadmin') would be written and silently mean nothing — or, worse,
		// mean something to a future check.
		const { app, env, recorded } = testApp({ rows: [["FROM users WHERE id", USER]] });
		const res = await call(app, env, "PUT", "/v1/admin/users/u9/roles", await token("op", ["admin"]), { roles: ["superadmin"] });
		expect(res.status).toBe(400);
		expect(recorded).toEqual([]);
	});

	it("rejects a non-array body", async () => {
		const { app, env } = testApp({ rows: [["FROM users WHERE id", USER]] });
		expect((await call(app, env, "PUT", "/v1/admin/users/u9/roles", await token("op", ["admin"]), { roles: "admin" })).status).toBe(400);
	});

	it("refuses to remove the caller's OWN admin role", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM users WHERE id", { ...USER, id: "op", roles: '["user","admin"]' }]] });
		const res = await call(app, env, "PUT", "/v1/admin/users/op/roles", await token("op", ["admin"]), { roles: ["user"] });
		expect(res.status).toBe(400);
		expect(recorded).toEqual([]);
	});
});

describe("POST /v1/admin/users/:id/keys/revoke", () => {
	it("deletes exactly the named provider and never touches the secret", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM users WHERE id", USER]] });
		const res = await call(app, env, "POST", "/v1/admin/users/u9/keys/revoke", await token("op", ["admin"]), { provider: "anthropic" });
		expect(res.status).toBe(200);
		const del = recorded.find((r) => r.sql.includes("DELETE FROM user_api_keys"));
		expect(del?.binds).toEqual(["u9", "anthropic"]);
		// The response and the audit row carry the provider NAME only — no ciphertext, no plaintext.
		expect(JSON.stringify(await res.json())).not.toMatch(/ciphertext|key_/);
		expect(auditRows(recorded)[0].binds[2]).toBe("user.key.revoke");
	});

	it("requires an explicit provider — there is no wildcard revoke", async () => {
		// An omitted field must not become "delete every key this user owns".
		const { app, env, recorded } = testApp({ rows: [["FROM users WHERE id", USER]] });
		expect((await call(app, env, "POST", "/v1/admin/users/u9/keys/revoke", await token("op", ["admin"]), {})).status).toBe(400);
		expect(recorded).toEqual([]);
	});

	it("404s when the user has no key for that provider", async () => {
		const { app, env } = testApp({ rows: [["FROM users WHERE id", USER]], changes: 0 });
		const res = await call(app, env, "POST", "/v1/admin/users/u9/keys/revoke", await token("op", ["admin"]), { provider: "openai" });
		expect(res.status).toBe(404);
	});
});

describe("POST /v1/admin/agents/:id/unpublish", () => {
	it("flips visibility to draft and records the previous value", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM agents WHERE id", AGENT]] });
		const res = await call(app, env, "POST", "/v1/admin/agents/a1/unpublish", await token("op", ["admin"]));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ visibility: "draft" });
		expect(recorded.some((r) => r.sql.includes("visibility = 'draft'"))).toBe(true);
		const audit = auditRows(recorded);
		expect(audit[0].binds[2]).toBe("agent.unpublish");
		expect(String(audit[0].binds[5])).toContain('"before":"published"'); // reversible: the old value is recoverable
	});

	it("404s an unknown agent", async () => {
		const { app, env } = testApp();
		expect((await call(app, env, "POST", "/v1/admin/agents/nope/unpublish", await token("op", ["admin"]))).status).toBe(404);
	});
});

describe("DELETE /v1/admin/agents/:id", () => {
	it("refuses without a slug confirmation", async () => {
		// A mistyped id must fail loudly rather than destroy a different creator's agent.
		const { app, env, recorded } = testApp({ rows: [["FROM agents WHERE id", AGENT]] });
		const res = await call(app, env, "DELETE", "/v1/admin/agents/a1", await token("op", ["admin"]), {});
		expect(res.status).toBe(400);
		expect(recorded).toEqual([]);
	});

	it("refuses a wrong slug confirmation", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM agents WHERE id", AGENT]] });
		const res = await call(app, env, "DELETE", "/v1/admin/agents/a1", await token("op", ["admin"]), { confirm: "some-other-agent" });
		expect(res.status).toBe(400);
		expect(recorded).toEqual([]);
	});

	it("409s when subscriber rows exist and force was not given", async () => {
		// Deleting the template out from under live subscribers strands them on an agent
		// that no longer exists; the operator has to say so on purpose.
		const { app, env, recorded } = testApp({ rows: [["FROM agents WHERE id", AGENT], SUBSCRIBED] });
		const res = await call(app, env, "DELETE", "/v1/admin/agents/a1", await token("op", ["admin"]), { confirm: "coder" });
		expect(res.status).toBe(409);
		expect(recorded).toEqual([]);
	});

	it("409s on instances that are all CANCELED — the row holds the key, not the status", async () => {
		// #646: the old guard counted `status = 'active'`, so this case skipped the 409 and then
		// failed the batch on the foreign key — a 500 where a refusal was the intended answer.
		const { app, env, recorded } = testApp({
			rows: [["FROM agents WHERE id", AGENT], ["AS foreign_subscriptions", { instances: 3, active_instances: 0, foreign_instances: 3, subscriptions: 0, foreign_subscriptions: 0 }]],
		});
		const res = await call(app, env, "DELETE", "/v1/admin/agents/a1", await token("op", ["admin"]), { confirm: "coder" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain("3 instance(s) (0 active)");
		expect(recorded).toEqual([]);
	});

	it("with force, removes the subscriber rows in the same batch and audits the count", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM agents WHERE id", AGENT], SUBSCRIBED] });
		const res = await call(app, env, "DELETE", "/v1/admin/agents/a1", await token("op", ["admin"]), { confirm: "coder", force: true });
		expect(res.status).toBe(200);
		// `canceledInstances` keeps its name and meaning (the live subscriptions this ended) because
		// the operator portal and `e2e/admin.spec.ts` read it.
		expect(await res.json()).toMatchObject({ success: true, canceledInstances: 3, removedInstances: 3 });
		// The rows are DELETED now, not flipped to 'canceled' — a canceled row still holds the FK,
		// which is why force used to 500 on exactly the agents it exists for (#646).
		expect(recorded.some((r) => r.sql.includes("DELETE FROM agent_instances"))).toBe(true);
		expect(recorded.some((r) => r.sql.includes("SET status = 'canceled'"))).toBe(false);
		expect(recorded.some((r) => r.sql.includes("DELETE FROM agents"))).toBe(true);
		expect(String(auditRows(recorded)[0].binds[5])).toContain('"canceledInstances":3');
	});

	it("deletes cleanly when nothing is subscribed, and clears agent_versions", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM agents WHERE id", AGENT], ["AS foreign_subscriptions", { instances: 0, active_instances: 0, foreign_instances: 0, subscriptions: 0, foreign_subscriptions: 0 }]] });
		const res = await call(app, env, "DELETE", "/v1/admin/agents/a1?confirm=coder", await token("op", ["admin"]));
		expect(res.status).toBe(200);
		expect(recorded.some((r) => r.sql.includes("DELETE FROM agents"))).toBe(true);
		// The row only `batch.ts` used to clear. All three routes now share one cascade (#646).
		expect(recorded.some((r) => r.sql.includes("DELETE FROM agent_versions"))).toBe(true);
		expect(auditRows(recorded)[0].binds[2]).toBe("agent.delete");
	});
});

describe("POST /v1/admin/instances/:id/cancel", () => {
	it("cancels the instance and its subscription, and audits", async () => {
		const { app, env, recorded } = testApp({ rows: [["FROM agent_instances WHERE id", INSTANCE]] });
		const res = await call(app, env, "POST", "/v1/admin/instances/i1/cancel", await token("op", ["admin"]), { reason: "runaway" });
		expect(res.status).toBe(200);
		const inst = recorded.find((r) => r.sql.includes("UPDATE agent_instances"));
		expect(inst?.binds).toEqual(["i1"]); // addressed by id ONLY — no agent-wide or owner-wide cancel
		expect(recorded.some((r) => r.sql.includes("UPDATE subscriptions"))).toBe(true);
		const audit = auditRows(recorded);
		expect(audit[0].binds[2]).toBe("instance.cancel");
		expect(String(audit[0].binds[5])).toContain('"reason":"runaway"');
	});

	it("404s an unknown instance", async () => {
		const { app, env, recorded } = testApp();
		expect((await call(app, env, "POST", "/v1/admin/instances/nope/cancel", await token("op", ["admin"]))).status).toBe(404);
		expect(recorded).toEqual([]);
	});
});
