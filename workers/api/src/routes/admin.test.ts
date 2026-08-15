import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { adminRoutes } from "./admin.js";

/**
 * Readers for JSON that came back from a route, for use in assertions.
 *
 * Every field is `unknown`, not `any`. These response shapes are not declared types anywhere in
 * the worker, so an interface written here would be a second source of truth that nothing keeps
 * in step — and the compiler would then vouch for it. `unknown` leaves the `expect` below as the
 * only thing making a claim about the shape, which is what a test is for.
 */
const jsonBody = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);
/** The object counterpart of `rows` — a non-object degrades to `{}` so the `expect` still fails loudly instead of throwing. */
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const TEST_SECRET = "test-secret";

/**
 * Build a test app with a mocked D1. `dbRoles` is what `SELECT roles FROM users`
 * returns for the live-role check; `allowlist` seeds ADMIN_ALLOWLIST; `audit` is
 * the rows the audit query returns.
 */
function testApp(opts: { dbRoles?: string | null; dbLogin?: string | null; allowlist?: string; audit?: unknown[]; usageRows?: unknown[]; platformAiEnabled?: boolean; userRows?: unknown[]; userCount?: number; userDetail?: unknown; agentRows?: unknown[]; agentCount?: number; agentDetail?: unknown; instanceRows?: unknown[]; errorRows?: unknown[] } = {}) {
	const app = new Hono();
	app.route("/v1/admin", adminRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	// Route a query to the right canned result by inspecting its SQL.
	const firstFor = (sql: string) => {
		if (sql.includes("SELECT roles, github_login FROM users")) return { roles: opts.dbRoles ?? null, github_login: opts.dbLogin ?? null };
		if (sql.includes("FROM agents a LEFT JOIN users") && sql.includes("WHERE a.id")) return opts.agentDetail ?? null; // getAgentDetail main row
		if (sql.includes("COUNT(*) AS n FROM agents")) return { n: opts.agentCount ?? (opts.agentRows?.length ?? 0) };
		if (sql.includes("COUNT(*) AS n FROM users")) return { n: opts.userCount ?? (opts.userRows?.length ?? 0) };
		if (sql.includes("COUNT(*) AS n FROM agent_instances")) return { n: opts.instanceRows?.length ?? 0 };
		if (sql.includes("COUNT(*) AS n") || sql.includes("SUM(cost_micros)")) return { n: 0 }; // other overview counts
		if (sql.includes("FROM users u WHERE u.id")) return opts.userDetail ?? null; // getUserDetail main row
		return null;
	};
	const allFor = (sql: string) => {
		// Order matters: the users list SELECTs an ai_usage sub-query, so match the
		// primary table first. The usage endpoint aliases the ledger as "ai_usage u".
		if (sql.includes("FROM users u")) return { results: opts.userRows ?? [] }; // listUsers page
		if (sql.includes("FROM ai_usage u")) return { results: opts.usageRows ?? [] };
		if (sql.includes("admin_audit_log")) return { results: opts.audit ?? [] };
		if (sql.includes("FROM agents a")) return { results: opts.agentRows ?? [] };
		if (sql.includes("instance_connector_consent")) return { results: [] }; // agent-detail consents
		if (sql.includes("FROM agent_instances i")) return { results: opts.instanceRows ?? [] };
		if (sql.includes("FROM error_log")) return { results: opts.errorRows ?? [] };
		return { results: [] }; // agents/instances/keys/errors sub-queries in getUserDetail
	};
	// Every prepared statement + its binds, so a test can assert that a request's query
	// params actually reached the SQL rather than being silently dropped by the handler.
	const queries: Array<{ sql: string; binds: unknown[] }> = [];
	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		ADMIN_ALLOWLIST: opts.allowlist,
		PLATFORM_AI_ENABLED: opts.platformAiEnabled ? "true" : "false",
		DB: {
			prepare(sql: string) {
				const first = async () => firstFor(sql);
				const all = async () => allFor(sql);
				return {
					bind(...binds: unknown[]) {
						queries.push({ sql, binds });
						return { first, all, run: async () => ({}) };
					},
					first,
					all,
				};
			},
		},
	};
	return { app, env, queries };
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

	it("honors ADMIN_ALLOWLIST by github_login/email (case-insensitive)", async () => {
		const { app, env } = testApp({ dbRoles: '["user"]', dbLogin: "Serge-Ivo", allowlist: "serge.the.dev@gmail.com,serge-ivo" });
		const res = await req(app, env, "/v1/admin/me", await token("someHashUid", ["user"]));
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

// #647: `payer` and the cache columns are part of the row because `loadAdminUsage` selects them
// and every charged figure is decided from `payer`. A fixture without them is not a simpler
// fixture — it is the one shape that hides the bug, which is how the real omission survived: the
// production select list and this stub agreed with each other and both were wrong.
const USAGE_ROWS = [
	{ user_id: "u1", agent_id: null, instance_id: null, provider: "anthropic", model: "claude-sonnet-4-6", kind: "chat", input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 10500, payer: "byok-api", created_at: "2026-08-01 10:00:00", agent_name: null, user_login: "alice" },
	{ user_id: "u2", agent_id: null, instance_id: null, provider: "platform", model: "@cf/baai/bge-base-en-v1.5", kind: "embedding", input_tokens: 200, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 40, payer: "platform", created_at: "2026-08-01 11:00:00", agent_name: null, user_login: "bob" },
];

describe("GET /v1/admin/users", () => {
	const USER_ROWS = [
		{ id: "u1", github_login: "alice", github_name: "Alice", avatar_url: "", roles: '["user","admin"]', subscription_status: "active", created_at: "2026-07-01 00:00:00", updated_at: "2026-08-01 00:00:00", agents_owned: 2, active_instances: 1, key_providers: "anthropic,openai", value_30d_micros: 12345, charged_30d_micros: 500 },
		{ id: "u2", github_login: "bob", github_name: "Bob", avatar_url: "", roles: null, subscription_status: "none", created_at: "2026-07-02 00:00:00", updated_at: "2026-08-01 00:00:00", agents_owned: 0, active_instances: 0, key_providers: null, value_30d_micros: 0, charged_30d_micros: 0 },
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
		const body = await jsonBody(res);
		expect(body.total).toBe(2);
		expect(rows(body.users)[0].roles).toEqual(["user", "admin"]);
		expect(rows(body.users)[0].key_providers).toEqual(["anthropic", "openai"]);
		expect(rows(body.users)[0].value30dMicros).toBe(12345);
		// Value and charge are separate columns, and the charged one carries the payer filter —
		// a per-user figure an operator reads as a bill must not include a subscription's tokens.
		expect(rows(body.users)[0].charged30dMicros).toBe(500);
		// null roles / null providers degrade safely
		expect(rows(body.users)[1].roles).toEqual(["user"]);
		expect(rows(body.users)[1].key_providers).toEqual([]);
	});
});

describe("GET /v1/admin/users/:id", () => {
	it("404s when the user does not exist", async () => {
		const { app, env } = testApp({ userDetail: null });
		const res = await req(app, env, "/v1/admin/users/nope", await token("u1", ["admin"]));
		expect(res.status).toBe(404);
	});

	it("returns detail with empty sub-collections", async () => {
		const detail = { id: "u1", github_login: "alice", github_name: "Alice", avatar_url: "", roles: '["user"]', subscription_status: "none", created_at: "2026-07-01 00:00:00", updated_at: "2026-08-01 00:00:00", agents_owned: 0, active_instances: 0, key_providers: null, value_30d_micros: 0, charged_30d_micros: 0 };
		const { app, env } = testApp({ userDetail: detail });
		const res = await req(app, env, "/v1/admin/users/u1", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(obj(body.user).github_login).toBe("alice");
		expect(body.agents).toEqual([]);
		expect(body.recentErrors).toEqual([]);
	});
});

describe("new operator views (#31/#33)", () => {
	it("GET /v1/admin/overview → 403 non-admin, stats for admin", async () => {
		const denied = testApp({ dbRoles: '["user"]' });
		expect((await req(denied.app, denied.env, "/v1/admin/overview", await token("u2", ["user"]))).status).toBe(403);
		const { app, env } = testApp({ userCount: 5, agentCount: 3 });
		const res = await req(app, env, "/v1/admin/overview", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const b = await jsonBody(res);
		expect(b.users).toBe(5);
		expect(b.agents).toBe(3);
		expect(b).toHaveProperty("platformSpend30dMicros");
		expect(b).toHaveProperty("value30dMicros");
	});

	it("GET /v1/admin/agents lists agents with owner + instance count", async () => {
		const agentRows = [{ id: "a1", slug: "coder", name: "Coder", category: "code", model: "claude-sonnet-4-6", visibility: "published", status: "active", created_at: "2026-08-01 00:00:00", owner_login: "alice", instances: 4 }];
		const { app, env } = testApp({ agentRows });
		const res = await req(app, env, "/v1/admin/agents", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const b = await jsonBody(res);
		expect(rows(b.agents)[0].slug).toBe("coder");
		expect(rows(b.agents)[0].instances).toBe(4);
	});

	it("GET /v1/admin/agents/:id → 404 when missing, detail with connectors when found", async () => {
		const missing = testApp({ agentDetail: null });
		expect((await req(missing.app, missing.env, "/v1/admin/agents/nope", await token("u1", ["admin"]))).status).toBe(404);
		const agentDetail = { id: "a1", slug: "coder", name: "Coder", category: "code", model: "claude-sonnet-4-6", visibility: "published", status: "active", created_at: "2026-08-01 00:00:00", owner_login: "alice", instances: 1, config: JSON.stringify({ capabilities: { tools: ["github_workflow_runs", "github_create_issue"] } }) };
		const { app, env } = testApp({ agentDetail });
		const res = await req(app, env, "/v1/admin/agents/coder", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const b = await jsonBody(res);
		expect(obj(b.agent).slug).toBe("coder");
		expect(obj(b.agent).connectors).toContain("github");
		expect(rows(b.connectorTools)[0].connector).toBe("github");
	});

	it("GET /v1/admin/agents passes visibility/status/owner filters through to the query", async () => {
		// A handler that reads only `search` still returns 200 with plausible-looking data,
		// so the filter silently doing nothing is invisible without asserting the binds.
		const { app, env, queries } = testApp();
		await req(app, env, "/v1/admin/agents?visibility=draft&status=error&owner=alice&limit=10&offset=20", await token("u1", ["admin"]));
		const list = queries.find((q) => q.sql.includes("ORDER BY a.created_at"));
		expect(list?.binds).toEqual(["draft", "error", "alice", "alice", 10, 20]);
	});

	it("GET /v1/admin/instances passes agent/owner/status filters through to the query", async () => {
		const { app, env, queries } = testApp();
		await req(app, env, "/v1/admin/instances?agent=coder&owner=alice&status=canceled&live=0", await token("u1", ["admin"]));
		const list = queries.find((q) => q.sql.includes("ORDER BY i.created_at"));
		expect(list?.binds.slice(0, 5)).toEqual(["coder", "coder", "alice", "alice", "canceled"]);
	});

	it("GET /v1/admin/instances → 403 non-admin, list for admin", async () => {
		const denied = testApp({ dbRoles: '["user"]' });
		expect((await req(denied.app, denied.env, "/v1/admin/instances", await token("u2", ["user"]))).status).toBe(403);
		const { app, env } = testApp({ instanceRows: [{ id: "i1", agent_id: "a1", agent_name: "Coder", owner_login: "alice", status: "active", created_at: "2026-08-01 00:00:00" }] });
		const res = await req(app, env, "/v1/admin/instances", await token("u1", ["admin"]));
		expect(rows((await jsonBody(res)).instances)[0].agent_name).toBe("Coder");
	});

	it("GET /v1/admin/terminals → 403 non-admin, node list for admin", async () => {
		const denied = testApp({ dbRoles: '["user"]' });
		expect((await req(denied.app, denied.env, "/v1/admin/terminals", await token("u2", ["user"]))).status).toBe(403);
		const { app, env } = testApp(); // no runtime nodes → empty
		const res = await req(app, env, "/v1/admin/terminals", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const b = await jsonBody(res);
		expect(b).toHaveProperty("nodes");
		expect(Array.isArray(b.nodes)).toBe(true);
	});

	it("GET /v1/admin/connectors returns the catalog + consents (403 non-admin)", async () => {
		const denied = testApp({ dbRoles: '["user"]' });
		expect((await req(denied.app, denied.env, "/v1/admin/connectors", await token("u2", ["user"]))).status).toBe(403);
		const { app, env } = testApp();
		const res = await req(app, env, "/v1/admin/connectors", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const b = await jsonBody(res);
		expect(b).toHaveProperty("connectors");
		expect(b).toHaveProperty("consents");
		expect(rows(b.connectors).map((c) => c.connector)).toContain("github");
	});

	it("GET /v1/admin/errors returns the cross-user log", async () => {
		const errorRows = [{ id: "e1", created_at: "2026-08-01 00:00:00", user_id: "u9", source: "auth", status: 500, message: "boom" }];
		const { app, env } = testApp({ errorRows });
		const res = await req(app, env, "/v1/admin/errors", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		expect(rows((await jsonBody(res)).errors)[0].message).toBe("boom");
	});

	it("GET /v1/admin/errors/summary groups into signatures", async () => {
		const errorRows = [
			{ id: "e1", created_at: "2026-08-01 10:00:00", user_id: "u1", source: "job-apply", status: 504, message: "timeout after 25s", context: null },
			{ id: "e2", created_at: "2026-08-01 09:00:00", user_id: "u2", source: "job-apply", status: 504, message: "timeout after 9s", context: null },
		];
		const { app, env } = testApp({ errorRows });
		const res = await req(app, env, "/v1/admin/errors/summary", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const b = await jsonBody(res);
		expect(rows(b.signatures)[0].count).toBe(2);
		expect(rows(b.signatures)[0].users).toBe(2);
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
		const body = await jsonBody(res);
		expect(obj(body.totals).calls).toBe(2);
		expect(rows(body.byUser).map((b) => b.label).sort()).toEqual(["alice", "bob"]);
		expect(obj(obj(body.split).platformPaid).calls).toBe(1);
		expect(obj(obj(body.split).byok).calls).toBe(1);
	});
});

describe("GET /v1/admin/spending", () => {
	it("surfaces BYOK spend, top spenders, and the platform-paid caveat", async () => {
		const { app, env } = testApp({ usageRows: USAGE_ROWS, platformAiEnabled: true });
		const res = await req(app, env, "/v1/admin/spending", await token("u1", ["admin"]));
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(obj(body.byok).costMicros).toBe(10500);
		expect(body.platformAiEnabled).toBe(true);
		expect(obj(body.platformPaid).metered).toBe(true);
		expect(obj(body.platformPaid).estimated).toBe(true);
		expect(obj(body.platformPaid).calls).toBe(1); // the platform embedding row
		expect(rows(body.topSpenders)[0].label).toBe("alice");
	});
});
