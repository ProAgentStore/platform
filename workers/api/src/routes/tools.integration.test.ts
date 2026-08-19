import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { toolRoutes } from "./tools.js";
import type { Env } from "../types.js";

/**
 * Readers for JSON that came back from a route, for use in assertions.
 *
 * Every field is `unknown`, not `any`. These response shapes are not declared types anywhere in
 * the worker, so an interface written here would be a second source of truth that nothing keeps
 * in step — and the compiler would then vouch for it. `unknown` leaves the `expect` below as the
 * only thing making a claim about the shape, which is what a test is for.
 */
const jsonBody = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

/**
 * INTEGRATION test: drives the real tool route handlers end-to-end through the Hono
 * app — auth (verifySession) → ownership gate (requireOwnedInstance, mock D1) →
 * the real connector-tool registry / connector-consent lib → JSON response. No handler
 * internals are stubbed; only the D1 boundary is mocked (canned rows + recorded writes).
 */

const SECRET = "integration-secret";

interface Write { sql: string; args: unknown[] }

/**
 * @param owns  the (instanceId,userId) pairs that resolve to an owned instance row.
 * @param consents  rows returned by the consents SELECT.
 */
function buildApp(opts: { owns?: Array<[string, string]>; consents?: unknown[] } = {}) {
	const writes: Write[] = [];
	const owns = new Set((opts.owns ?? []).map(([i, u]) => `${i}::${u}`));

	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								// requireOwnedInstance: SELECT … FROM agent_instances WHERE id=?1 AND user_id=?2
								if (sql.includes("FROM agent_instances")) {
									const [id, uid] = args as [string, string];
									if (!owns.has(`${id}::${uid}`)) return null;
									// The tool-policy gate joins agents to read capabilities.tools; the fixture
									// agent must declare the tool under test or it is (correctly) refused.
									if (sql.includes("JOIN agents")) {
										return {
											slug: "fixture",
											category: "general",
											config: JSON.stringify({ capabilities: { tools: ["github_workflow_runs", "github_list_issues", "github_read_issue", "github_create_issue", "http_request"] } }),
											instance_config: "{}",
										};
									}
									return { id, agent_id: "a1", user_id: uid, status: "active", config: "{}", created_at: "", updated_at: "" };
								}
								return null;
							},
							async all() {
								if (sql.includes("instance_connector_consent")) return { results: opts.consents ?? [] };
								return { results: [] };
							},
							async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
						};
					},
				};
			},
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", toolRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return { app, env, writes };
}

const tokenFor = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });

function get(app: Hono<{ Bindings: Env }>, env: Env, path: string, tok?: string) {
	return app.request(path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }, env);
}
function put(app: Hono<{ Bindings: Env }>, env: Env, path: string, body: unknown, tok: string) {
	return app.request(path, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
}
function patch(app: Hono<{ Bindings: Env }>, env: Env, path: string, body: unknown, tok: string) {
	return app.request(path, { method: "PATCH", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
}

describe("GET /v1/instances/:id/tools (integration)", () => {
	it("401s without a bearer token (auth boundary)", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await get(app, env, "/v1/instances/inst-1/tools");
		expect(res.status).toBe(401);
	});

	it("404s when the caller does not own the instance (ownership boundary)", async () => {
		const { app, env } = buildApp({ owns: [] }); // u1 owns nothing
		const res = await get(app, env, "/v1/instances/inst-1/tools", await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error).toContain("Instance not found");
	});

	it("returns the real connector-tool registry with schemas for the owner", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		// `?schemas=true` since #569 — the default response omits them (89 KB was over a calling
		// host's limit). An ALLOWED row still carries its schema verbatim when asked for, and this
		// instance declares nothing, so every row here is allowed.
		const res = await get(app, env, "/v1/instances/inst-1/tools?schemas=true", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tools: Array<{ name: string; connector: string; scope?: string; allowed: boolean; jsonSchema: unknown }> };
		expect(Array.isArray(body.tools)).toBe(true);
		expect(body.tools.length).toBeGreaterThan(0);
		// Every tool carries the fields the client relies on.
		for (const t of body.tools) {
			expect(typeof t.name).toBe("string");
			if (t.allowed) expect(t.jsonSchema, t.name).toBeTruthy();
			else expect(t.jsonSchema, t.name).toBeUndefined();
		}
		// A known connector tool from the registry is present with its connector stamped.
		const gh = body.tools.find((t) => t.name === "github_create_issue");
		expect(gh).toBeTruthy();
		expect(gh!.connector).toBe("github");
	});
});

describe("POST /v1/instances/:id/tools/:name (integration)", () => {
	it("404s for an unknown tool name", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await app.request("/v1/instances/inst-1/tools/no_such_tool", {
			method: "POST",
			headers: { Authorization: `Bearer ${await tokenFor("u1")}`, "Content-Type": "application/json" },
			body: "{}",
		}, env);
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error).toContain("Unknown tool");
	});

	it("400s when required schema fields are missing (real schema validation)", async () => {
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]] });
		// github_create_issue requires fields; sending {} must fail validation before dispatch.
		const res = await app.request("/v1/instances/inst-1/tools/github_create_issue", {
			method: "POST",
			headers: { Authorization: `Bearer ${await tokenFor("u1")}`, "Content-Type": "application/json" },
			body: "{}",
		}, env);
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error).toContain("Missing required field");
	});
});

describe("consent routes (integration, cross-boundary write + read)", () => {
	it("PUT grants write consent → persists an INSERT and echoes enabled:true", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await put(app, env, "/v1/instances/inst-1/connectors/github/consent", { enabled: true }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, connector: "github", scope: "write", enabled: true });
		const insert = writes.find((w) => w.sql.includes("INSERT INTO instance_connector_consent"));
		expect(insert).toBeTruthy();
		expect(insert!.args).toEqual(["inst-1", "u1", "github", "write"]);
	});

	it("PUT with enabled:false issues a DELETE (revoke)", async () => {
		const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
		const res = await put(app, env, "/v1/instances/inst-1/connectors/github/consent", { enabled: false }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).enabled).toBe(false);
		expect(writes.some((w) => w.sql.includes("DELETE FROM instance_connector_consent"))).toBe(true);
	});

	it("GET lists the instance's consents (owner-scoped)", async () => {
		const rows = [{ instance_id: "inst-1", user_id: "u1", connector: "github", scope: "write", created_at: "2026-08-01" }];
		const { app, env } = buildApp({ owns: [["inst-1", "u1"]], consents: rows });
		const res = await get(app, env, "/v1/instances/inst-1/connectors/consent", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ consents: rows });
	});

	it("blocks consent writes on an unowned instance (404 before any DB write)", async () => {
		const { app, env, writes } = buildApp({ owns: [] });
		const res = await put(app, env, "/v1/instances/inst-1/connectors/github/consent", { enabled: true }, await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect(writes).toHaveLength(0);
	});
});

// ── The pause routes: `enabled` is strictly a boolean (#644, #664, #667) ─────────────────
//
// Both PATCH handlers refuse anything that is not a boolean rather than coercing it. That rule
// was written down in a comment and enforced by one `typeof` with nothing holding it, and it is
// the rule two new clients now depend on — the console toggle and the MCP `set_*_enabled` tools
// both produce the value in tested code because the route will not clean up after them.
//
// The reason coercion is wrong here and merely sloppy elsewhere: `"false"` and `0` are the shapes
// a hand-written body arrives in, and JS reads `"false"` as TRUTHY. A coercing route handed a
// pause would RESUME the edge — the exact opposite of what was asked, on the one field whose only
// job is to stop work, and silently, since the 200 would carry a perfectly healthy-looking row.
describe("PATCH connections/supervision — enabled must be a real boolean (integration)", () => {
	const paths = ["/v1/instances/inst-1/connections/c-1", "/v1/instances/inst-1/supervision/link-1"];

	it("400s on the non-boolean shapes a hand-written body arrives in, and writes nothing", async () => {
		for (const path of paths) {
			for (const enabled of ["false", "true", 0, 1, null, undefined]) {
				const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
				const res = await patch(app, env, path, { enabled }, await tokenFor("u1"));
				expect(res.status, `${path} <- ${JSON.stringify(enabled)}`).toBe(400);
				expect((await jsonBody(res)).error).toContain("enabled must be true or false");
				// The refusal is worthless if the UPDATE ran anyway.
				expect(writes.some((w) => /UPDATE agent_(connections|supervision)/.test(w.sql))).toBe(false);
			}
		}
	});

	it("reaches the writer for both booleans", async () => {
		for (const path of paths) {
			for (const enabled of [true, false]) {
				const { app, env, writes } = buildApp({ owns: [["inst-1", "u1"]] });
				const res = await patch(app, env, path, { enabled }, await tokenFor("u1"));
				expect(res.status, `${path} <- ${enabled}`).not.toBe(400);
				const update = writes.find((w) => /UPDATE agent_(connections|supervision) SET enabled/.test(w.sql));
				expect(update, `${path} <- ${enabled}`).toBeTruthy();
				// Stored as the integer the column holds — the boundary converts, it does not accept.
				expect(update!.args).toContain(enabled ? 1 : 0);
			}
		}
	});

	// The ownership gate runs before the body is read, so a stranger cannot even learn which
	// shapes the route rejects.
	it("404s a caller who does not own the instance, and never reaches the writer", async () => {
		for (const path of paths) {
			const { app, env, writes } = buildApp({ owns: [] });
			const res = await patch(app, env, path, { enabled: false }, await tokenFor("u1"));
			expect(res.status).toBe(404);
			// The status alone does not distinguish "refused" from "wrote, then could not read
			// the row back" — the writers return null on a zero-row UPDATE, which is also a 404.
			expect(writes.some((w) => /UPDATE agent_(connections|supervision)/.test(w.sql))).toBe(false);
		}
	});
});
