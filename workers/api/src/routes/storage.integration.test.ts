import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { instanceStorageRoutes, storageRoutes } from "./storage.js";
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
const rec = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);

/**
 * INTEGRATION test for the storage proxy routes (collections/files/search/activity/
 * memory/state/knowledge + repo ingest). Drives the real handlers end-to-end:
 * auth (requireUser) → ownership gate (resolveAgent for agent routes,
 * resolveOwnedInstance for instance routes, mock D1) → AgentDO proxy (recording
 * stub) → JSON. Only D1 + AgentDO are faked; ownership scoping + DO passthrough +
 * the repo-ingest validation run for real.
 */

const SECRET = "storage-integration-secret";

interface DoCall {
	agentDoName: string;
	path: string;
	method: string;
	body?: unknown;
}

interface Opts {
	agents?: Array<{ id: string; slug?: string; owner_id: string }>;
	instances?: Array<{ id: string; user_id: string }>;
}

function buildApp(opts: Opts = {}) {
	const agents = opts.agents ?? [];
	const instances = opts.instances ?? [];
	const doCalls: DoCall[] = [];
	let doResponse: (path: string, method: string) => Response = () => Response.json({ ok: true });

	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (sql.includes("FROM agents")) {
									const key = args[0] as string;
									return agents.find((a) => a.id === key || a.slug === key) ?? null;
								}
								if (sql.includes("FROM agent_instances")) {
									const [id, uid] = args as [string, string];
									const inst = instances.find((i) => i.id === id && i.user_id === uid);
									return inst ? { id: inst.id } : null;
								}
								return null;
							},
							async all() { return { results: [] }; },
							async run() { return { meta: { changes: 1 } }; },
						};
					},
				};
			},
		},
		AGENT: {
			idFromName(name: string) { return { name }; },
			get(id: { name: string }) {
				return {
					async fetch(req: Request) {
						const url = new URL(req.url);
						const path = url.pathname + url.search;
						let body: unknown;
						if (req.method === "POST" || req.method === "PUT") {
							body = await req.clone().json().catch(() => undefined);
						}
						doCalls.push({ agentDoName: id.name, path, method: req.method, body });
						return doResponse(path, req.method);
					},
				};
			},
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", storageRoutes);
	app.route("/v1/instances", instanceStorageRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return { app, env, doCalls, setDoResponse(fn: (p: string, m: string) => Response) { doResponse = fn; } };
}

const tokenFor = (uid: string, roles: string[] = ["user"]) => signSession(uid, SECRET, { roles });

function json(app: Hono<{ Bindings: Env }>, env: Env, method: string, path: string, body: unknown, tok?: string) {
	return app.request(path, {
		method,
		headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	}, env);
}
function get(app: Hono<{ Bindings: Env }>, env: Env, path: string, tok?: string) {
	return app.request(path, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }, env);
}

// ── Agent-scoped storage routes ──────────────────────────────────────────────

describe("agent storage routes (ownership + DO proxy)", () => {
	it("401s an unauthenticated collections list", async () => {
		const { app, env } = buildApp({ agents: [{ id: "a1", owner_id: "u1" }] });
		expect((await get(app, env, "/v1/agents/a1/collections")).status).toBe(401);
	});

	it("404s a missing agent", async () => {
		const { app, env } = buildApp({ agents: [] });
		const res = await get(app, env, "/v1/agents/ghost/collections", await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error).toContain("Agent not found");
	});

	it("403s a non-owner (no DO hit)", async () => {
		const { app, env, doCalls } = buildApp({ agents: [{ id: "a1", owner_id: "owner" }] });
		const res = await get(app, env, "/v1/agents/a1/collections", await tokenFor("attacker"));
		expect(res.status).toBe(403);
		expect(doCalls).toHaveLength(0);
	});

	it("owner lists collections → proxies GET /collections and returns the DO body", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ agents: [{ id: "a1", owner_id: "u1" }] });
		setDoResponse(() => Response.json({ collections: [{ name: "leads" }] }));
		const res = await get(app, env, "/v1/agents/a1/collections", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(rows((await jsonBody(res)).collections)[0].name).toBe("leads");
		expect(doCalls[0].path).toBe("/collections");
		expect(doCalls[0].agentDoName).toBe("a1"); // keyed by agent id
	});

	it("POST search forwards the query body to the DO for the owner", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ agents: [{ id: "a1", owner_id: "u1" }] });
		setDoResponse(() => Response.json({ matches: [{ score: 0.9 }] }));
		const res = await json(app, env, "POST", "/v1/agents/a1/search", { query: "hello" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).matches).toHaveLength(1);
		const search = doCalls.find((c) => c.path === "/search");
		expect(search!.method).toBe("POST");
		expect(rec(search!.body).query).toBe("hello");
	});

	it("record name + query string are forwarded (encoded) to the DO", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ agents: [{ id: "a1", owner_id: "u1" }] });
		setDoResponse(() => Response.json({ records: [] }));
		const res = await get(app, env, "/v1/agents/a1/collections/my%20leads/records?limit=10", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(doCalls[0].path).toContain("/collections/my%20leads/records");
		expect(doCalls[0].path).toContain("limit=10");
	});

	it("DELETE record proxies a DELETE and admin may reach another owner's agent", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ agents: [{ id: "a1", owner_id: "someone" }] });
		setDoResponse(() => Response.json({ deleted: true }));
		const res = await app.request("/v1/agents/a1/collections/leads/records/r1", {
			method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor("adm", ["user", "admin"])}` },
		}, env);
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).deleted).toBe(true);
		expect(doCalls[0].method).toBe("DELETE");
		expect(doCalls[0].path).toContain("/records/r1");
	});

	it("propagates a non-OK DO status (e.g. 404 on a missing collection)", async () => {
		const { app, env, setDoResponse } = buildApp({ agents: [{ id: "a1", owner_id: "u1" }] });
		setDoResponse(() => Response.json({ error: "no such collection" }, { status: 404 }));
		const res = await get(app, env, "/v1/agents/a1/collections/nope", await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error).toBe("no such collection");
	});
});

// ── Instance-scoped storage routes ───────────────────────────────────────────

describe("instance storage routes (owner-scoped, different D1 table)", () => {
	it("401s unauthenticated", async () => {
		const { app, env } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		expect((await get(app, env, "/v1/instances/i1/collections")).status).toBe(401);
	});

	it("404s an instance the caller does not own", async () => {
		const { app, env, doCalls } = buildApp({ instances: [{ id: "i1", user_id: "owner" }] });
		const res = await get(app, env, "/v1/instances/i1/collections", await tokenFor("attacker"));
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error).toContain("Instance not found");
		expect(doCalls).toHaveLength(0);
	});

	it("owner reads memory → proxies GET /memory keyed by instance id", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ memory: [{ key: "name" }] }));
		const res = await get(app, env, "/v1/instances/i1/memory", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(rows((await jsonBody(res)).memory)[0].key).toBe("name");
		expect(doCalls[0].agentDoName).toBe("i1"); // instance id, not agent id
		expect(doCalls[0].path).toBe("/memory");
	});

	it("PUT state forwards the body to the instance DO", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ saved: true }));
		const res = await json(app, env, "PUT", "/v1/instances/i1/state", { guardrails: { maxLength: 500 } }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const put = doCalls.find((c) => c.path === "/state" && c.method === "PUT");
		expect(put).toBeTruthy();
		expect(rec(rec(put!.body).guardrails).maxLength).toBe(500);
	});

	it("DELETE memory/:key forwards an (encoded) DELETE to the instance DO", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ deleted: true }));
		const res = await app.request("/v1/instances/i1/memory/some%20key", {
			method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor("u1")}` },
		}, env);
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).deleted).toBe(true);
		expect(doCalls[0].method).toBe("DELETE");
		expect(doCalls[0].path).toContain("/memory/some%20key");
	});

	// #337: the DO task store had no instance-scoped door at all — chatRoutes mounts only at
	// /v1/agents and resolves `:id` against the `agents` table, so an instance id 404'd there
	// while the tasks kept steering every prompt.
	it("owner reads agent-tasks → proxies GET /tasks keyed by instance id", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ tasks: [{ id: "t1", assignedBy: "self", stale: false }] }));
		const res = await get(app, env, "/v1/instances/i1/agent-tasks", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(rows((await jsonBody(res)).tasks)[0].assignedBy).toBe("self");
		expect(doCalls[0].agentDoName).toBe("i1");
		expect(doCalls[0].path).toBe("/tasks");
	});

	it("404s agent-tasks for an instance the caller does not own, without touching the DO", async () => {
		const { app, env, doCalls } = buildApp({ instances: [{ id: "i1", user_id: "owner" }] });
		const res = await get(app, env, "/v1/instances/i1/agent-tasks", await tokenFor("attacker"));
		expect(res.status).toBe(404);
		expect(doCalls).toHaveLength(0);
	});

	it("POST agent-tasks forwards the body to the instance DO", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ id: "t2" }, { status: 201 }));
		const res = await json(app, env, "POST", "/v1/instances/i1/agent-tasks", { title: "Renew the domain" }, await tokenFor("u1"));
		expect(res.status).toBe(201);
		expect(doCalls[0]).toMatchObject({ path: "/tasks", method: "POST" });
		expect(rec(doCalls[0].body).title).toBe("Renew the domain");
	});

	it("PUT/DELETE agent-tasks/:taskId reach the DO's per-task path, id-encoded", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ ok: true }));
		await json(app, env, "PUT", "/v1/instances/i1/agent-tasks/t%201", { status: "complete" }, await tokenFor("u1"));
		await app.request("/v1/instances/i1/agent-tasks/t%201", {
			method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor("u1")}` },
		}, env);
		expect(doCalls[0]).toMatchObject({ path: "/tasks/t%201", method: "PUT" });
		expect(doCalls[1]).toMatchObject({ path: "/tasks/t%201", method: "DELETE" });
	});

	it("DELETE messages clears the conversation via the DO", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ cleared: true }));
		const res = await app.request("/v1/instances/i1/messages", {
			method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor("u1")}` },
		}, env);
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).cleared).toBe(true);
		expect(doCalls[0]).toMatchObject({ path: "/messages", method: "DELETE" });
	});
});

// ── Repo ingestion (validation-heavy) ────────────────────────────────────────

describe("instance repo ingestion (real URL validation)", () => {
	it("400s when repoUrl is missing", async () => {
		const { app, env } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		const res = await json(app, env, "POST", "/v1/instances/i1/ingest-repo", {}, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error).toContain("repoUrl required");
	});

	it("400s a non-GitHub URL (parseGithubUrl rejects it)", async () => {
		const { app, env } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		const res = await json(app, env, "POST", "/v1/instances/i1/ingest-repo", { repoUrl: "https://gitlab.com/foo/bar" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error).toContain("GitHub");
	});

	it("404s the ingest when the instance isn't owned (before any DO call)", async () => {
		const { app, env, doCalls } = buildApp({ instances: [{ id: "i1", user_id: "owner" }] });
		const res = await json(app, env, "POST", "/v1/instances/i1/ingest-repo", { repoUrl: "https://github.com/o/r" }, await tokenFor("attacker"));
		expect(res.status).toBe(404);
		expect(doCalls).toHaveLength(0);
	});

	it("owner ingests a valid GitHub repo → proxies to the DO with a parsed repoUrl and no token (app not configured)", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ status: "queued" }));
		const res = await json(app, env, "POST", "/v1/instances/i1/ingest-repo", { repoUrl: "https://github.com/octocat/hello", branch: "main" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).status).toBe("queued");
		const ingest = doCalls.find((c) => c.path === "/ingest-repo");
		expect(ingest).toBeTruthy();
		expect(rec(ingest!.body).repoUrl).toBe("https://github.com/octocat/hello");
		expect(rec(ingest!.body).branch).toBe("main");
		// GitHub App is unconfigured in the test env → no installation token injected.
		expect(rec(ingest!.body).token).toBeUndefined();
	});

	/**
	 * The reason there is no token travels with the job (#724).
	 *
	 * The route is the LAST place that knows which of `resolveGithubAccess`'s five conditions
	 * applied: `installationTokenForOwner` collapses them all to `string | null`, and by the time
	 * the tarball 404s one tick later inside the DO, "the App is not installed on TheRocketLab"
	 * has become "no token" has become "connect GitHub for private repos" — which is what an owner
	 * with sixteen installations was told. This asserts the channel exists and carries the state,
	 * so the wordings pinned in repo-ingest.test.ts are reachable rather than theoretical.
	 *
	 * The env here has no GitHub App, so the condition under test is `app-not-configured`. The
	 * other four need a configured App and a mocked GitHub, and are covered at the unit level —
	 * this proves the plumbing, not every branch through it.
	 */
	it("hands the DO WHY there is no token, not just that there is none", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ status: "queued" }));
		await json(app, env, "POST", "/v1/instances/i1/ingest-repo", { repoUrl: "https://github.com/TheRocketLab/mountain-unlocked" }, await tokenFor("u1"));
		const auth = rec(rec(doCalls.find((c) => c.path === "/ingest-repo")!.body).auth);
		expect(auth.authenticated).toBe(false);
		expect(auth.state).toBe("app-not-configured");
		// A bare `{authenticated:false}` would satisfy the type and lose the whole point.
		expect(auth.state).not.toBeUndefined();
	});

	it("ingest-repo/status proxies a GET to the DO", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp({ instances: [{ id: "i1", user_id: "u1" }] });
		setDoResponse(() => Response.json({ repos: [{ key: "octocat/hello", progress: 1 }] }));
		const res = await get(app, env, "/v1/instances/i1/ingest-repo/status", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(rows((await jsonBody(res)).repos)[0].key).toBe("octocat/hello");
		expect(doCalls[0]).toMatchObject({ path: "/ingest-repo/status", method: "GET" });
	});
});
