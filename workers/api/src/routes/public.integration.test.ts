import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { resetFunnelReportingForTests } from "../lib/store-funnel.js";
import { publicRoutes } from "./public.js";
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
	/** Make every funnel upsert throw — stands in for the FK violation of #383. */
	failFunnelWrites?: boolean;
}

interface DoCall {
	path: string;
	method: string;
	body?: unknown;
}

interface DbWrite {
	sql: string;
	args: unknown[];
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
	const writes: DbWrite[] = [];

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
								if (db.failFunnelWrites && sql.includes("INTO agent_funnel_daily")) {
									throw new Error("FOREIGN KEY constraint failed");
								}
								writes.push({ sql, args });
								// An UPDATE reports NO change here, because this double holds no rows to
								// match. Reporting one made `logError`'s repeat-collapse (#424) believe an
								// identical failure was already recorded and skip the INSERT — so the
								// assertion below, that a swallowed reason reaches the durable log, silently
								// stopped testing anything. `changes: 1` was never true for a statement whose
								// WHERE cannot match; the double was overstating what D1 does.
								if (sql.trimStart().toUpperCase().startsWith("UPDATE")) return { meta: { changes: 0 } };
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
	// executionCtx.waitUntil carries the funnel counters (#383). The real runtime keeps the
	// isolate alive until they settle, so the test has to as well — a no-op stub would make
	// every assertion about them race the write it is asserting on.
	const pending: Promise<unknown>[] = [];
	const wrap = async (path: string, init?: RequestInit) => {
		const res = await app.request(path, init, env, {
			waitUntil(p: Promise<unknown>) {
				pending.push(p);
			},
			passThroughOnException() {},
		} as unknown as ExecutionContext);
		await Promise.allSettled(pending.splice(0));
		return res;
	};
	return { app, env, doCalls, usageWrites, writes, wrap };
}

const tokenFor = (uid: string, roles: string[] = ["user"]) => signSession(uid, SECRET, { roles });

/** A plausible browser UA — `shouldCountView` refuses to count a request without one. */
const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// The failure-report latch is module-level (one report per isolate), so a test that expects
// a report must not inherit a latch set by the test before it.
beforeEach(() => {
	resetFunnelReportingForTests();
});

describe("GET /v1/public/agents/:id", () => {
	it("404s an unpublished / missing agent", async () => {
		const { wrap } = buildApp({ agents: [{ id: "a1", slug: "draft", visibility: "draft" }] });
		const res = await wrap("/v1/public/agents/a1");
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error).toContain("not found");
	});

	it("returns a published agent's public detail row", async () => {
		const row = { id: "a1", slug: "coder", name: "Coder", description: "d", visibility: "published", subscriber_count: 3 };
		const { wrap } = buildApp({ agents: [row] });
		const res = await wrap("/v1/public/agents/coder"); // resolvable by slug too
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(body.slug).toBe("coder");
		expect(body.subscriber_count).toBe(3);
	});
});

/**
 * The funnel counters (#383). Before this, `view` was an INSERT into `usage` binding
 * `user_id = ''` against `user_id TEXT NOT NULL REFERENCES users(id)` — a foreign-key
 * violation on every request, swallowed by `.catch(() => {})` inside a `waitUntil`.
 */
describe("GET /v1/public/agents/:id — view counting", () => {
	const published = { id: "a1", slug: "coder", name: "Coder", visibility: "published" };

	it("counts the view into agent_funnel_daily, with no user id anywhere in the statement", async () => {
		const { wrap, writes, usageWrites } = buildApp({ agents: [published] });
		await wrap("/v1/public/agents/coder", { headers: { "User-Agent": BROWSER_UA } });
		const view = writes.find((w) => w.sql.includes("INTO agent_funnel_daily"));
		expect(view, "a browser view must be counted").toBeTruthy();
		expect(view?.args).toEqual(["a1", expect.any(String), "view"]);
		expect(view?.sql).not.toContain("user_id");
		// And it must NOT go back into `usage`, whose FK is what made it impossible.
		expect(usageWrites).toHaveLength(0);
	});

	it("does not count a crawler, or a caller that sends no User-Agent", async () => {
		const bot = buildApp({ agents: [published] });
		await bot.wrap("/v1/public/agents/coder", { headers: { "User-Agent": "Googlebot/2.1" } });
		expect(bot.writes.some((w) => w.sql.includes("agent_funnel_daily"))).toBe(false);

		const bare = buildApp({ agents: [published] });
		await bare.wrap("/v1/public/agents/coder");
		expect(bare.writes.some((w) => w.sql.includes("agent_funnel_daily"))).toBe(false);
	});

	it("REPORTS a failed count to the durable error log instead of swallowing it", async () => {
		const { wrap, writes } = buildApp({ agents: [published], failFunnelWrites: true });
		const res = await wrap("/v1/public/agents/coder", { headers: { "User-Agent": BROWSER_UA } });
		// The visitor still gets their page — a counter must never break what it counts.
		expect(res.status).toBe(200);
		const logged = writes.find((w) => w.sql.includes("INSERT INTO error_log"));
		expect(logged, "the reason must survive the request that produced it").toBeTruthy();
		expect(String(logged?.args[2])).toBe("store-funnel");
		expect(logged?.args[1]).toBeNull(); // no user id — the counter stays cookieless
	});
});

describe("GET /v1/public/developers/:login", () => {
	it("404s an unknown developer", async () => {
		const { wrap } = buildApp({ users: [] });
		const res = await wrap("/v1/public/developers/ghost");
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error).toContain("Developer not found");
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
		const body = await jsonBody(res);
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
		expect((await jsonBody(res)).error).toContain("message required");
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
		const body = await jsonBody(res);
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
		const body = await jsonBody(res);
		expect(body.error).toContain("Trial limit reached");
		// It must NOT have forwarded the chat once the cap is hit.
		expect(doCalls.some((c) => c.path === "/chat")).toBe(false);
	});

	it("counts trial_start exactly when the trial DO is created (#383)", async () => {
		// Nothing in the codebase wrote this event, so `funnel.trials` was 0 for every agent
		// forever — a funnel asserting a measurement nobody took.
		const agent = { id: "a1", slug: "coder", visibility: "published", model: "m", name: "Coder" };
		const { wrap, writes } = buildApp(
			{ agents: [agent] },
			{ stateExists: false, chatReply: { reply: "hello" }, messageCount: 0 },
		);
		await wrap("/v1/public/agents/coder/try", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
			body: JSON.stringify({ message: "hi" }),
		});
		const trial = writes.find((w) => w.sql.includes("INTO agent_funnel_daily"));
		expect(trial?.args).toEqual(["a1", expect.any(String), "trial_start"]);
	});

	it("does NOT count a trial_start for each message of an existing trial", async () => {
		// A trial STARTS once. Counting per request would make `trials` a message count, and the
		// step of the funnel it is supposed to measure would silently stop existing.
		const agent = { id: "a1", slug: "coder", visibility: "published", model: "m", name: "Coder" };
		const { wrap, writes } = buildApp({ agents: [agent] }, { stateExists: true, messageCount: 4, chatReply: { reply: "ok" } });
		await wrap("/v1/public/agents/coder/try", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
			body: JSON.stringify({ message: "again" }),
		});
		expect(writes.some((w) => w.sql.includes("agent_funnel_daily"))).toBe(false);
	});

	it("derives the same trial session id for the same IP (cap can't be reset by client sessionId)", async () => {
		const agent = { id: "a1", slug: "coder", visibility: "published", model: "m", name: "Coder" };
		const { wrap } = buildApp({ agents: [agent] }, { stateExists: true, messageCount: 0, chatReply: { reply: "x" } });
		const call = (sessionId: string) => wrap("/v1/public/agents/coder/try", {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": "7.7.7.7" },
			body: JSON.stringify({ message: "hi", sessionId }),
		});
		const a = await jsonBody(await call("client-chosen-A"));
		const b = await jsonBody(await call("client-chosen-B"));
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
		expect((await jsonBody(res)).error).toContain("Instance not found");
	});

	it("400s when title/content missing", async () => {
		const { wrap } = buildApp({ instances: [{ id: "i1", user_id: "u1", status: "active" }] });
		const res = await wrap("/v1/public/webhook/i1/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor("u1")}` },
			body: JSON.stringify({ title: "only-title" }),
		});
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error).toContain("title and content required");
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
		expect((await jsonBody(res)).id).toBe("doc-9");
		const post = doCalls.find((c) => c.path === "/knowledge" && c.method === "POST");
		expect(post).toBeTruthy();
		expect(rec(post!.body).title).toBe("Report");
		expect(rec(post!.body).source).toBe("zapier");
	});
});
