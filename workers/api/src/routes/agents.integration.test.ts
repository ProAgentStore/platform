import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { agentRoutes } from "./agents.js";
import type { Env } from "../types.js";

/**
 * INTEGRATION test for the agent CRUD routes — list/detail/create/update/delete/
 * clone + capabilities & settings-schema. Drives the real handlers through the Hono
 * app: auth (requireUser/requireCreator) → ownership/role gates → mock D1 (canned
 * rows + recorded writes) → AgentDO init (recording stub). GITHUB_TOKEN is left
 * unset so the ops/deploy paths degrade gracefully (no live fetch). The uniqueness,
 * slug validation, role gating, ownership, and config-merge logic all run for real.
 */

const SECRET = "agents-integration-secret";

interface Write { sql: string; args: unknown[] }
interface DoCall { name: string; path: string; body?: unknown }

interface Opts {
	agents?: Array<Record<string, unknown>>;
	/** slugs that already exist (uniqueness check) */
	takenSlugs?: string[];
}

function buildApp(opts: Opts = {}) {
	const agents = opts.agents ?? [];
	const taken = new Set(opts.takenSlugs ?? []);
	const writes: Write[] = [];
	const batches: Write[][] = [];
	const doCalls: DoCall[] = [];

	const env = {
		SESSION_SIGNING_KEY: SECRET,
		// GITHUB_TOKEN intentionally unset.
		DB: {
			prepare(sql: string) {
				return {
					_sql: sql,
					bind(...args: unknown[]) {
						return {
							_sql: sql,
							_args: args,
							async first() {
								if (sql.includes("SELECT id FROM agents WHERE slug")) {
									const slug = args[0] as string;
									return taken.has(slug) ? { id: `existing-${slug}` } : null;
								}
								if (sql.includes("FROM agents")) {
									const key = args[0] as string;
									const a = agents.find(
										(x) =>
											(x.id === key || x.slug === key) &&
											(!sql.includes("visibility = 'published'") || x.visibility === "published"),
									);
									return a ?? null;
								}
								if (sql.includes("FROM user_api_keys")) return null;
								return null;
							},
							async all() {
								if (sql.includes("owner_id = ?1")) {
									const ownerId = args[0] as string;
									return { results: agents.filter((a) => a.owner_id === ownerId) };
								}
								if (sql.includes("FROM agents") && sql.includes("visibility = 'published'")) {
									return { results: agents.filter((a) => a.visibility === "published") };
								}
								if (sql.includes("FROM agent_executions")) return { results: [] };
								return { results: agents };
							},
							async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
						};
					},
				};
			},
			async batch(stmts: Array<{ _sql: string; _args: unknown[] }>) {
				batches.push(stmts.map((s) => ({ sql: s._sql, args: s._args })));
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		},
		AGENT: {
			idFromName(name: string) { return { name }; },
			get(id: { name: string }) {
				return {
					async fetch(req: Request) {
						const url = new URL(req.url);
						let body: unknown;
						if (req.method === "POST") body = await req.clone().json().catch(() => undefined);
						doCalls.push({ name: id.name, path: url.pathname, body });
						if (url.pathname === "/state") return Response.json({ name: "Tmpl", model: "m", guardrails: {} });
						if (url.pathname === "/knowledge") return Response.json({ documents: [] });
						return Response.json({ ok: true });
					},
				};
			},
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", agentRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return { app, env, writes, batches, doCalls };
}

const tokenFor = (uid: string, roles: string[] = ["user"]) => signSession(uid, SECRET, { roles });

function json(app: Hono, env: unknown, method: string, path: string, body: unknown, tok?: string) {
	return app.request(path, {
		method,
		headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	}, env);
}
function get(app: Hono, env: unknown, path: string, tok?: string) {
	return app.request(path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }, env);
}

describe("GET /v1/agents (public list)", () => {
	it("lists only published agents (no token required)", async () => {
		const { app, env } = buildApp({ agents: [
			{ id: "a1", slug: "pub", name: "Pub", visibility: "published", owner_id: "u1" },
			{ id: "a2", slug: "draft", name: "Draft", visibility: "draft", owner_id: "u1" },
		] });
		const res = await app.request("/v1/agents", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.agents.map((a: any) => a.slug)).toEqual(["pub"]);
	});
});

describe("GET /v1/agents/my/agents", () => {
	it("401s without a token", async () => {
		const { app, env } = buildApp();
		expect((await get(app, env, "/v1/agents/my/agents")).status).toBe(401);
	});

	it("returns only the caller's own agents", async () => {
		const { app, env } = buildApp({ agents: [
			{ id: "a1", slug: "mine", owner_id: "u1", visibility: "draft" },
			{ id: "a2", slug: "theirs", owner_id: "u2", visibility: "published" },
		] });
		const res = await get(app, env, "/v1/agents/my/agents", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.agents).toHaveLength(1);
		expect(body.agents[0].slug).toBe("mine");
	});
});

describe("GET /v1/agents/:id (detail visibility)", () => {
	it("404s a missing agent", async () => {
		const { app, env } = buildApp({ agents: [] });
		const res = await get(app, env, "/v1/agents/ghost");
		expect(res.status).toBe(404);
		expect((await res.json() as any).error).toContain("Agent not found");
	});

	it("404s an unpublished agent to an anonymous caller", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "draft", owner_id: "u1", visibility: "draft" }] });
		const res = await get(app, env, "/v1/agents/draft");
		expect(res.status).toBe(404);
	});

	it("returns a published agent WITHOUT owner_id to anonymous callers", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "pub", owner_id: "u1", visibility: "published", name: "Pub" }] });
		const res = await get(app, env, "/v1/agents/pub");
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.slug).toBe("pub");
		expect(body.owner_id).toBeUndefined(); // stripped for non-owners
	});

	it("owner sees their own draft WITH owner_id", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "draft", owner_id: "u1", visibility: "draft", name: "D" }] });
		const res = await get(app, env, "/v1/agents/draft", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.owner_id).toBe("u1");
	});
});

describe("POST /v1/agents (create — requires creator)", () => {
	it("403s a plain user (no creator role)", async () => {
		const { app, env } = buildApp();
		const res = await json(app, env, "POST", "/v1/agents", { slug: "new-a", name: "New" }, await tokenFor("u1", ["user"]));
		expect(res.status).toBe(403);
		expect((await res.json() as any).error).toContain("Creator access required");
	});

	it("400s a missing slug/name", async () => {
		const { app, env } = buildApp();
		const res = await json(app, env, "POST", "/v1/agents", { name: "New" }, await tokenFor("u1", ["creator"]));
		expect(res.status).toBe(400);
		expect((await res.json() as any).error).toContain("slug and name required");
	});

	it("400s an invalid slug format", async () => {
		const { app, env } = buildApp();
		const res = await json(app, env, "POST", "/v1/agents", { slug: "Bad_Slug", name: "New" }, await tokenFor("u1", ["creator"]));
		expect(res.status).toBe(400);
		expect((await res.json() as any).error).toContain("lowercase alphanumeric");
	});

	it("409s a taken slug", async () => {
		const { app, env } = buildApp({ takenSlugs: ["dupe"] });
		const res = await json(app, env, "POST", "/v1/agents", { slug: "dupe", name: "Dup" }, await tokenFor("u1", ["creator"]));
		expect(res.status).toBe(409);
		expect((await res.json() as any).error).toContain("already taken");
	});

	it("creates the agent, inits its DO, and returns id+slug (201)", async () => {
		const { app, env, writes, doCalls } = buildApp();
		const res = await json(app, env, "POST", "/v1/agents", { slug: "brand-new", name: "Brand New", personality: "helpful" }, await tokenFor("creatorUid", ["creator"]));
		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(body.slug).toBe("brand-new");
		expect(typeof body.id).toBe("string");
		// A row was inserted...
		const insert = writes.find((w) => w.sql.includes("INSERT INTO agents"));
		expect(insert).toBeTruthy();
		expect(insert!.args).toContain("creatorUid"); // owner_id bound to the session uid
		// ...and its DO was initialized.
		const init = doCalls.find((c) => c.path === "/init");
		expect(init).toBeTruthy();
		expect((init!.body as any).name).toBe("Brand New");
	});
});

describe("PUT /v1/agents/:id (update)", () => {
	it("404s a missing agent", async () => {
		const { app, env } = buildApp({ agents: [] });
		const res = await json(app, env, "PUT", "/v1/agents/ghost", { name: "x" }, await tokenFor("u1"));
		expect(res.status).toBe(404);
	});

	it("403s a non-owner", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "owner" }] });
		const res = await json(app, env, "PUT", "/v1/agents/a1", { name: "x" }, await tokenFor("attacker"));
		expect(res.status).toBe(403);
	});

	it("400s when there is nothing to update", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "u1" }] });
		const res = await json(app, env, "PUT", "/v1/agents/a1", { notAllowed: "x" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as any).error).toContain("Nothing to update");
	});

	it("owner updates allowed fields → builds a scoped UPDATE and returns success", async () => {
		const { app, env, writes } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "u1" }] });
		const res = await json(app, env, "PUT", "/v1/agents/a1", { name: "Renamed", visibility: "published", bogus: "ignored" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await res.json() as any).success).toBe(true);
		const upd = writes.find((w) => w.sql.startsWith("UPDATE agents SET"));
		expect(upd).toBeTruthy();
		// id is bound as ?1, then only the allowed fields.
		expect(upd!.args[0]).toBe("a1");
		expect(upd!.args).toContain("Renamed");
		expect(upd!.args).toContain("published");
		expect(upd!.args).not.toContain("ignored");
	});
});

describe("DELETE /v1/agents/:id", () => {
	it("403s a non-owner", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "owner" }] });
		const res = await app.request("/v1/agents/a1", { method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor("attacker")}` } }, env);
		expect(res.status).toBe(403);
	});

	it("owner delete cascades via a batch (executions + usage + agent)", async () => {
		const { app, env, batches } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "u1" }] });
		const res = await app.request("/v1/agents/a1", { method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor("u1")}` } }, env);
		expect(res.status).toBe(200);
		expect((await res.json() as any).success).toBe(true);
		expect(batches).toHaveLength(1);
		const sqls = batches[0].map((s) => s.sql);
		expect(sqls.some((s) => s.includes("DELETE FROM agent_executions"))).toBe(true);
		expect(sqls.some((s) => s.includes("DELETE FROM usage"))).toBe(true);
		expect(sqls.some((s) => s.includes("DELETE FROM agents"))).toBe(true);
	});
});

describe("POST /v1/agents/:id/clone", () => {
	it("403s a non-creator", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "src", owner_id: "u1", visibility: "published" }] });
		const res = await json(app, env, "POST", "/v1/agents/src/clone", { slug: "fork" }, await tokenFor("u2", ["user"]));
		expect(res.status).toBe(403);
	});

	it("400s a missing slug", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "src", owner_id: "u1", visibility: "published" }] });
		const res = await json(app, env, "POST", "/v1/agents/src/clone", {}, await tokenFor("u2", ["creator"]));
		expect(res.status).toBe(400);
		expect((await res.json() as any).error).toContain("slug required");
	});

	it("404s cloning an unpublished / missing source", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "src", owner_id: "u1", visibility: "draft" }] });
		const res = await json(app, env, "POST", "/v1/agents/src/clone", { slug: "fork" }, await tokenFor("u2", ["creator"]));
		expect(res.status).toBe(404);
	});

	it("clones a published agent → new draft owned by the caller, DO state+KB copied (201)", async () => {
		const { app, env, writes, doCalls } = buildApp({ agents: [{ id: "a1", slug: "src", owner_id: "u1", visibility: "published", name: "Src", model: "m" }] });
		const res = await json(app, env, "POST", "/v1/agents/src/clone", { slug: "my-fork" }, await tokenFor("cloner", ["creator"]));
		expect(res.status).toBe(201);
		const body = (await res.json()) as any;
		expect(body.slug).toBe("my-fork");
		expect(body.clonedFrom).toBe("a1");
		const insert = writes.find((w) => w.sql.includes("INSERT INTO agents"));
		expect(insert!.args).toContain("cloner"); // owned by the cloner
		// New DO was initialized (state read from source, init on the new one).
		expect(doCalls.some((c) => c.path === "/init")).toBe(true);
		expect(doCalls.some((c) => c.path === "/state")).toBe(true);
	});
});

describe("settings-schema + capabilities (owner-gated config merge)", () => {
	it("403s reading settings-schema for a non-owner", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "owner", config: null }] });
		const res = await get(app, env, "/v1/agents/a1/settings-schema", await tokenFor("attacker"));
		expect(res.status).toBe(403);
	});

	it("owner reads an empty settings-schema when config is null", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "u1", config: null }] });
		const res = await get(app, env, "/v1/agents/a1/settings-schema", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await res.json() as any).settingsSchema).toEqual([]);
	});

	it("owner writes a sanitized settings-schema → persists merged config", async () => {
		const { app, env, writes } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "u1", config: JSON.stringify({ capabilities: { surfaces: ["chat"] } }) }] });
		const schema = [{ id: "target_language", label: "Language", type: "select", options: [{ value: "en", label: "English" }, { value: "es", label: "Spanish" }] }];
		const res = await json(app, env, "PUT", "/v1/agents/a1/settings-schema", { settingsSchema: schema }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(Array.isArray(body.settingsSchema)).toBe(true);
		expect(body.settingsSchema[0].id).toBe("target_language");
		expect(body.settingsSchema[0].options).toHaveLength(2);
		// The write must preserve the pre-existing capabilities and add settingsSchema.
		const upd = writes.find((w) => w.sql.includes("UPDATE agents SET config"));
		expect(upd).toBeTruthy();
		const merged = JSON.parse(upd!.args[0] as string);
		expect(merged.capabilities.surfaces).toEqual(["chat"]);
		expect(merged.settingsSchema[0].id).toBe("target_language");
	});

	it("PUT capabilities rejects a non-https bundle URL (filters it out)", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "u1", config: null }] });
		const res = await json(app, env, "PUT", "/v1/agents/a1/capabilities", {
			customSurfaces: [
				{ id: "s1", label: "Ok", bundleUrl: "https://cdn.example.com/s1.js" },
				{ id: "bad", label: "Bad", bundleUrl: "http://insecure/s2.js" },
				{ id: "js", label: "XSS", bundleUrl: "javascript:alert(1)" },
			],
		}, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		// Only the https surface survives.
		expect(body.customSurfaces).toHaveLength(1);
		expect(body.customSurfaces[0].id).toBe("s1");
	});

	it("POST /agents persists declarative capabilities (#141 — a Coder-equivalent as data)", async () => {
		const { app, env, writes } = buildApp();
		const res = await json(app, env, "POST", "/v1/agents", {
			slug: "my-coder", name: "My Coder",
			capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION", tools: ["list_coding_repos", "bogus tool"] },
		}, await tokenFor("creatorUid", ["creator"]));
		expect(res.status).toBe(201);
		const cfgWrite = writes.find((w) => w.sql.includes("UPDATE agents SET config"));
		expect(cfgWrite).toBeTruthy();
		const caps = JSON.parse(cfgWrite!.args[0] as string).capabilities;
		expect(caps.surfaces).toEqual(["coding"]);
		expect(caps.runtime).toBe("coding");
		expect(caps.workflow).toBe("CODING_SESSION");
		expect(caps.tools).toEqual(["list_coding_repos"]); // "bogus tool" dropped by sanitizer
	});

	it("PUT capabilities merges power fields, coerces unknown enums, and preserves customSurfaces", async () => {
		const { app, env, writes } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "u1", config: JSON.stringify({ capabilities: { customSurfaces: [{ id: "notes", label: "Notes", bundleUrl: "https://cdn.example.com/n.js" }] } }) }] });
		const res = await json(app, env, "PUT", "/v1/agents/a1/capabilities", {
			surfaces: ["coding", "bogus"], runtime: "gpu", workflow: "CODING_SESSION", tools: ["read_terminal"],
		}, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.surfaces).toEqual(["coding"]); // unknown surface dropped
		expect(body.runtime).toBeNull(); // unknown runtime → null
		expect(body.workflow).toBe("CODING_SESSION");
		expect(body.tools).toEqual(["read_terminal"]);
		// A capabilities-only PATCH must NOT wipe the pre-existing code-bundle surfaces.
		expect(body.customSurfaces).toHaveLength(1);
		const upd = writes.find((w) => w.sql.includes("UPDATE agents SET config"));
		const merged = JSON.parse(upd!.args[0] as string);
		expect(merged.capabilities.customSurfaces[0].id).toBe("notes");
	});

	it("GET capabilities returns the declared power fields", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", slug: "a", owner_id: "u1", config: JSON.stringify({ capabilities: { surfaces: ["repo"], runtime: null, workflow: null, tools: ["search_knowledge"] } }) }] });
		const res = await get(app, env, "/v1/agents/a1/capabilities", await tokenFor("u1"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.surfaces).toEqual(["repo"]);
		expect(body.tools).toEqual(["search_knowledge"]);
	});
});
