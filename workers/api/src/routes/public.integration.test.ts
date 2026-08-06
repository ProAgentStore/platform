import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { publicRoutes } from "./public.js";
import type { Env } from "../types.js";

/**
 * INTEGRATION test for the public (no-auth) routes — agent detail, developer
 * profile, trial chat, and the authenticated webhook-ingest path. Drives the real
 * handlers end-to-end through the Hono app. Only the D1 + AgentDO boundaries are
 * faked (canned rows + a recording DO stub); the auth (verifySession) and the
 * IP-derived trial-cap logic run for real.
 */

const SECRET = "public-integration-secret";

interface DbOpts {
	agents?: Record<string, unknown>[];
	users?: Record<string, unknown>[];
	instances?: Array<{ id: string; user_id: string; status: string }>;
}

interface DoCall {
	path: string;
	method: string;
	body?: unknown;
}

interface DoOpts {
	/** message count returned by GET /messages (drives the 20-msg trial cap) */
	messageCount?: number;
	/** whether GET /state 404s (triggers template copy) or 200s (already inited) */
	stateExists?: boolean;
	/** documents returned by the template GET /knowledge during copy */
	templateKb?: Record<string, unknown>[];
	/** JSON returned by POST /chat */
	chatReply?: Record<string, unknown>;
	/** status of the POST /chat response */
	chatStatus?: number;
	/** JSON returned by POST /knowledge */
	knowledgeReply?: Record<string, unknown>;
	knowledgeStatus?: number;
}

function buildApp(db: DbOpts = {}, doOpts: DoOpts = {}) {
	const agents = db.agents ?? [];
	const users = db.users ?? [];
	const instances = db.instances ?? [];
	const doCalls: DoCall[] = [];
	const usageWrites: unknown[][] = [];

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
									return (
										agents.find(
											(a) =>
												(a.id === key || a.slug === key) &&
												(!sql.includes("visibility = 'published'") ||
													a.visibility === "published"),
										) ?? null
									);
								}
								if (sql.includes("FROM users")) {
									const login = args[0] as string;
									return users.find((u) => u.github_login === login) ?? null;
								}
								if (sql.includes("FROM agent_instances")) {
									const [id, uid] = args as [string, string];
									const inst = instances.find(
										(i) => i.id === id && i.user_id === uid && i.status === "active",
									);
									return inst ? { id: inst.id } : null;
								}
								return null;
							},
							async all() {
								if (sql.includes("FROM agents") && sql.includes("owner_id")) {
									const ownerId = args[0] as string;
									return {
										results: agents.filter(
											(a) => a.owner_id === ownerId && a.visibility === "published",
										),
									};
								}
								return { results: [] };
							},
							async run() {
								if (sql.includes("INSERT INTO usage")) usageWrites.push(args);
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
		AGENT: {
			idFromName(name: string) {
				return { name };
			},
			get(id: { name: string }) {
				return {
					async fetch(req: Request) {
						const url = new URL(req.url);
						const path = url.pathname + url.search;
						let body: unknown;
						if (req.method === "POST" || req.method === "PUT") {
							body = await req.clone().json().catch(() => undefined);
						}
						doCalls.push({ path, method: req.method, body });

						// Template DO (keyed by the raw agent id, no "trial:" prefix)
						const isTrialDo = id.name.startsWith("trial:");

						if (path === "/state") {
							if (!isTrialDo) {
								// template state read during the copy
								return Response.json({ name: "Tmpl", model: "m", guardrails: {} });
							}
							return doOpts.stateExists === false
								? new Response("not found", { status: 404 })
								: Response.json({ ok: true });
						}
						if (path.startsWith("/messages")) {
							return Response.json({
								messages: Array.from({ length: doOpts.messageCount ?? 0 }, (_, i) => ({ i })),
							});
						}
						if (path === "/knowledge" && req.method === "GET") {
							return Response.json({ documents: doOpts.templateKb ?? [] });
						}
						if (path === "/knowledge" && req.method === "POST") {
							return Response.json(
								doOpts.knowledgeReply ?? { id: "doc-1", success: true },
								{ status: doOpts.knowledgeStatus ?? 201 },
							);
						}
						if (path === "/init") return Response.json({ ok: true });
						if (path === "/chat") {
							return Response.json(doOpts.chatReply ?? { reply: "hi" }, {
								status: doOpts.chatStatus ?? 200,
							});
						}
						return Response.json({});
					},
				};
			},
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/public", publicRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	// executionCtx.waitUntil is used by the view-tracker; give the test a no-op.
	const wrap = (path: string, init?: RequestInit) =>
		app.request(path, init, env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
	return { app, env, doCalls, usageWrites, wrap };
}

const tokenFor = (uid: string, roles: string[] = ["user"]) => signSession(uid, SECRET, { roles });

describe("GET /v1/public/agents/:id", () => {
	it("404s an unpublished / missing agent", async () => {
		const { wrap } = buildApp({ agents: [{ id: "a1", slug: "draft", visibility: "draft" }] });
		const res = await wrap("/v1/public/agents/a1");
		expect(res.status).toBe(404);
		expect((await res.json() as any).error).toContain("not found");
	});

	it("returns a published agent's public detail row", async () => {
		const row = { id: "a1", slug: "coder", name: "Coder", description: "d", visibility: "published", subscriber_count: 3 };
		const { wrap } = buildApp({ agents: [row] });
		const res = await wrap("/v1/public/agents/coder"); // resolvable by slug too
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.slug).toBe("coder");
		expect(body.subscriber_count).toBe(3);
	});
});

describe("GET /v1/public/developers/:login", () => {
	it("404s an unknown developer", async () => {
		const { wrap } = buildApp({ users: [] });
		const res = await wrap("/v1/public/developers/ghost");
		expect(res.status).toBe(404);
		expect((await res.json() as any).error).toContain("Developer not found");
	});

	it("returns the profile + published agents, NEVER leaking roles", async () => {
		const user = {
			id: "u1", github_login: "alice", github_name: "Alice", avatar_url: "http://x/a.png",
			display_name: "", bio: "hi", website: "http://a.dev", twitter: "@a", roles: '["user","admin"]',
		};
		const agents = [
			{ id: "a1", slug: "one", name: "One", visibility: "published", owner_id: "u1" },
			{ id: "a2", slug: "two", name: "Two", visibility: "draft", owner_id: "u1" }, // filtered out
		];
		const { wrap } = buildApp({ users: [user], agents });
		const res = await wrap("/v1/public/developers/alice");
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.developer.login).toBe("alice");
		expect(body.developer.name).toBe("Alice"); // falls back to github_name when display_name empty
		expect(body.developer.agentCount).toBe(1); // only the published one
		expect(body.agents).toHaveLength(1);
		// roles must NOT be exposed on this unauthenticated endpoint
		expect(JSON.stringify(body)).not.toContain("roles");
		expect(body.developer.roles).toBeUndefined();
	});
});

describe("POST /v1/public/agents/:id/try (trial chat)", () => {
	it("400s when message is missing", async () => {
		const { wrap } = buildApp({ agents: [{ id: "a1", slug: "coder", visibility: "published", model: "m", name: "Coder" }] });
		const res = await wrap("/v1/public/agents/coder/try", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect((await res.json() as any).error).toContain("message required");
	});

	it("404s an unpublished agent", async () => {
		const { wrap } = buildApp({ agents: [{ id: "a1", slug: "draft", visibility: "draft", model: "m", name: "D" }] });
		const res = await wrap("/v1/public/agents/a1/try", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }),
		});
		expect(res.status).toBe(404);
	});

	it("copies template state+KB into a fresh trial DO, then chats", async () => {
		const agent = { id: "a1", slug: "coder", visibility: "published", model: "m", name: "Coder" };
		const { wrap, doCalls } = buildApp(
			{ agents: [agent] },
			{ stateExists: false, templateKb: [{ title: "doc", content: "x" }], chatReply: { reply: "hello" }, messageCount: 0 },
		);
		const res = await wrap("/v1/public/agents/coder/try", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
			body: JSON.stringify({ message: "hi" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.reply).toBe("hello");
		expect(typeof body.sessionId).toBe("string"); // server-derived, ip-hashed
		// The template copy path ran: init + a KB POST both happened.
		expect(doCalls.some((c) => c.path === "/init" && c.method === "POST")).toBe(true);
		expect(doCalls.some((c) => c.path === "/knowledge" && c.method === "POST")).toBe(true);
		expect(doCalls.some((c) => c.path === "/chat" && c.method === "POST")).toBe(true);
	});

	it("does NOT re-copy when the trial DO already has state", async () => {
		const agent = { id: "a1", slug: "coder", visibility: "published", model: "m", name: "Coder" };
		const { wrap, doCalls } = buildApp({ agents: [agent] }, { stateExists: true, messageCount: 2, chatReply: { reply: "ok" } });
		const res = await wrap("/v1/public/agents/coder/try", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
			body: JSON.stringify({ message: "again" }),
		});
		expect(res.status).toBe(200);
		expect(doCalls.some((c) => c.path === "/init")).toBe(false); // no re-init
		expect(doCalls.some((c) => c.path === "/chat")).toBe(true);
	});

	it("429s when the 20-message trial cap is reached", async () => {
		const agent = { id: "a1", slug: "coder", visibility: "published", model: "m", name: "Coder" };
		const { wrap, doCalls } = buildApp({ agents: [agent] }, { stateExists: true, messageCount: 20 });
		const res = await wrap("/v1/public/agents/coder/try", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": "5.5.5.5" },
			body: JSON.stringify({ message: "one more" }),
		});
		expect(res.status).toBe(429);
		const body = (await res.json()) as any;
		expect(body.error).toContain("Trial limit reached");
		// It must NOT have forwarded the chat once the cap is hit.
		expect(doCalls.some((c) => c.path === "/chat")).toBe(false);
	});

	it("derives the same trial session id for the same IP (cap can't be reset by client sessionId)", async () => {
		const agent = { id: "a1", slug: "coder", visibility: "published", model: "m", name: "Coder" };
		const { wrap } = buildApp({ agents: [agent] }, { stateExists: true, messageCount: 0, chatReply: { reply: "x" } });
		const call = (sessionId: string) => wrap("/v1/public/agents/coder/try", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": "7.7.7.7" },
			body: JSON.stringify({ message: "hi", sessionId }),
		});
		const a = (await (await call("client-chosen-A")).json()) as any;
		const b = (await (await call("client-chosen-B")).json()) as any;
		// Different client-supplied sessionIds → SAME server session id (tied to IP).
		expect(a.sessionId).toBe(b.sessionId);
	});
});

describe("POST /v1/public/webhook/:instanceId/ingest", () => {
	it("401s without a bearer token", async () => {
		const { wrap } = buildApp();
		const res = await wrap("/v1/public/webhook/i1/ingest", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "t", content: "c" }),
		});
		expect(res.status).toBe(401);
		// The route now authenticates through requireUser, so the wording is the platform's one
		// message rather than this route's own — same 401, one fewer copy of the auth logic.
		expect(((await res.json()) as { error: string }).error).toContain("Missing Authorization header");
	});

	it("401s an invalid token", async () => {
		const { wrap } = buildApp();
		const res = await wrap("/v1/public/webhook/i1/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token" },
			body: JSON.stringify({ title: "t", content: "c" }),
		});
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: string }).error).toContain("Invalid or expired token");
	});

	it("403s a SUSPENDED account (#306)", async () => {
		// The reason this route moved to requireUser. It used to verify the session inline, which
		// meant a suspended account kept ingesting third-party content into its instance's vector
		// store — the one surface a moderation lever most needs to reach.
		const { wrap } = buildApp({
			users: [{ github_login: "owner", suspended: 1 }],
			instances: [{ id: "i1", user_id: "owner", status: "active" }],
		});
		const res = await wrap("/v1/public/webhook/i1/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor("owner")}` },
			body: JSON.stringify({ title: "t", content: "c" }),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toContain("suspended");
	});

	it("404s when the caller does not own the (active) instance", async () => {
		const { wrap } = buildApp({ instances: [{ id: "i1", user_id: "owner", status: "active" }] });
		const res = await wrap("/v1/public/webhook/i1/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor("attacker")}` },
			body: JSON.stringify({ title: "t", content: "c" }),
		});
		expect(res.status).toBe(404);
		expect((await res.json() as any).error).toContain("Instance not found");
	});

	it("400s when title/content missing", async () => {
		const { wrap } = buildApp({ instances: [{ id: "i1", user_id: "u1", status: "active" }] });
		const res = await wrap("/v1/public/webhook/i1/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor("u1")}` },
			body: JSON.stringify({ title: "only-title" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json() as any).error).toContain("title and content required");
	});

	it("owner ingests a doc → forwards to the instance DO and returns 201", async () => {
		const { wrap, doCalls } = buildApp(
			{ instances: [{ id: "i1", user_id: "u1", status: "active" }] },
			{ knowledgeReply: { id: "doc-9" }, knowledgeStatus: 201 },
		);
		const res = await wrap("/v1/public/webhook/i1/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor("u1")}` },
			body: JSON.stringify({ title: "Report", content: "the body", source: "zapier" }),
		});
		expect(res.status).toBe(201);
		expect((await res.json() as any).id).toBe("doc-9");
		const post = doCalls.find((c) => c.path === "/knowledge" && c.method === "POST");
		expect(post).toBeTruthy();
		expect((post!.body as any).title).toBe("Report");
		expect((post!.body as any).source).toBe("zapier");
	});
});
