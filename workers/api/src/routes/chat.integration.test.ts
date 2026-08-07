import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signChatToken, signRelayToken, signSession, verifyChatToken, verifySession } from "../lib/session.js";
import { chatRoutes } from "./chat.js";
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
 * INTEGRATION test for the agent (creator-facing) chat/memory/tasks/state/knowledge
 * routes. Drives the real handlers through the Hono app: auth (requireUser) →
 * ownership gate (resolveAgent, mock D1) → AgentDO proxy (recording stub) → JSON.
 * Only the D1 + AgentDO boundaries are faked; the ownership + admin-override logic
 * and the DO-status passthrough run for real.
 */

const SECRET = "chat-integration-secret";

interface DoCall {
	agentDoName: string;
	path: string;
	method: string;
	body?: unknown;
}

/**
 * @param agents rows the resolveAgent SELECT can return (by id or slug).
 * @param user   the `users` row every uid resolves to — `{suspended: 1}` exercises the
 *               moderation gate the WS upgrade applies by hand (#273).
 */
function buildApp(
	agents: Array<{ id: string; slug?: string; name?: string; model?: string; owner_id: string }> = [],
	user: { suspended?: number; roles?: string } | null = null,
) {
	const doCalls: DoCall[] = [];
	const usageWrites: unknown[][] = [];
	// DO responses are canned per-path; tests that care override via `doResponse`.
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
									const a = agents.find((x) => x.id === key || x.slug === key);
									return a ?? null;
								}
								if (sql.includes("FROM users")) return user;
								return null;
							},
							async all() {
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
						doCalls.push({ agentDoName: id.name, path, method: req.method, body });
						return doResponse(path, req.method);
					},
				};
			},
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", chatRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return {
		app,
		env,
		doCalls,
		usageWrites,
		setDoResponse(fn: (path: string, method: string) => Response) { doResponse = fn; },
	};
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

describe("POST /v1/agents/:id/chat (auth + ownership)", () => {
	it("401s without a token", async () => {
		const { app, env } = buildApp([{ id: "a1", owner_id: "u1" }]);
		const res = await json(app, env, "POST", "/v1/agents/a1/chat", { message: "hi" });
		expect(res.status).toBe(401);
	});

	it("400s when message is missing", async () => {
		const { app, env } = buildApp([{ id: "a1", owner_id: "u1" }]);
		const res = await json(app, env, "POST", "/v1/agents/a1/chat", {}, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error).toContain("message required");
	});

	it("404s when the agent does not exist", async () => {
		const { app, env } = buildApp([]);
		const res = await json(app, env, "POST", "/v1/agents/ghost/chat", { message: "hi" }, await tokenFor("u1"));
		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error).toContain("Agent not found");
	});

	it("403s when the caller does not own the agent (and is not admin)", async () => {
		const { app, env, doCalls } = buildApp([{ id: "a1", owner_id: "owner", name: "A" }]);
		const res = await json(app, env, "POST", "/v1/agents/a1/chat", { message: "hi" }, await tokenFor("attacker"));
		expect(res.status).toBe(403);
		expect((await jsonBody(res)).error).toContain("Not your agent");
		// It never reached the DO.
		expect(doCalls).toHaveLength(0);
	});

	it("owner chats → forwards message+uid to the DO and records a usage row", async () => {
		const { app, env, doCalls, usageWrites, setDoResponse } = buildApp([{ id: "a1", owner_id: "u1", name: "Coder" }]);
		setDoResponse(() => Response.json({ reply: "hello" }));
		const res = await json(app, env, "POST", "/v1/agents/a1/chat", { message: "hi" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).reply).toBe("hello");
		const chat = doCalls.find((c) => c.path === "/chat");
		expect(chat).toBeTruthy();
		expect(rec(chat!.body).message).toBe("hi");
		expect(rec(chat!.body).userId).toBe("u1"); // server-pinned uid
		expect(rec(chat!.body).agentName).toBe("Coder");
		expect(usageWrites).toHaveLength(1);
	});

	it("admin can chat with an agent they don't own", async () => {
		const { app, env, setDoResponse } = buildApp([{ id: "a1", owner_id: "someone-else", name: "A" }]);
		setDoResponse(() => Response.json({ reply: "ok" }));
		const res = await json(app, env, "POST", "/v1/agents/a1/chat", { message: "hi" }, await tokenFor("adm", ["user", "admin"]));
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).reply).toBe("ok");
	});

	it("propagates a non-OK DO status to the caller", async () => {
		const { app, env, setDoResponse } = buildApp([{ id: "a1", owner_id: "u1", name: "A" }]);
		setDoResponse(() => Response.json({ error: "rate limited" }, { status: 429 }));
		const res = await json(app, env, "POST", "/v1/agents/a1/chat", { message: "hi" }, await tokenFor("u1"));
		expect(res.status).toBe(429);
		expect((await jsonBody(res)).error).toBe("rate limited");
	});

	it("does not throw an opaque 500 when the DO returns a non-JSON body (hard crash)", async () => {
		const { app, env, setDoResponse } = buildApp([{ id: "a1", owner_id: "u1", name: "A" }]);
		// Simulate a platform-level DO crash: a non-JSON 500 body (was → SyntaxError → generic 500).
		setDoResponse(() => new Response("Error: Worker exceeded CPU time limit.", { status: 500 }));
		const res = await json(app, env, "POST", "/v1/agents/a1/chat", { message: "hi" }, await tokenFor("u1"));
		expect(res.status).toBe(500);
		// The real DO body is surfaced (traceable) instead of a masked "Internal server error".
		expect((await jsonBody(res)).error).toContain("CPU time");
	});
});

describe("POST /v1/agents/:id/ws-token (mint the handshake credential)", () => {
	it("401s without an account session", async () => {
		const { app, env } = buildApp([{ id: "a1", owner_id: "u1" }]);
		expect((await json(app, env, "POST", "/v1/agents/a1/ws-token", undefined)).status).toBe(401);
	});

	it("403s a non-owner — the mint route is where authorization happens", async () => {
		const { app, env } = buildApp([{ id: "a1", owner_id: "owner" }]);
		const res = await json(app, env, "POST", "/v1/agents/a1/ws-token", undefined, await tokenFor("attacker"));
		expect(res.status).toBe(403);
	});

	it("404s a missing agent", async () => {
		const { app, env } = buildApp([]);
		const res = await json(app, env, "POST", "/v1/agents/ghost/ws-token", undefined, await tokenFor("u1"));
		expect(res.status).toBe(404);
	});

	it("mints a chat token that is NOT an account session, scoped to the resolved agent id", async () => {
		const { app, env } = buildApp([{ id: "a1", slug: "coder", owner_id: "u1" }]);
		// Minted via the SLUG — the token must still name the concrete id.
		const res = await json(app, env, "POST", "/v1/agents/coder/ws-token", undefined, await tokenFor("u1"));
		expect(res.status).toBe(200);
		const { token, expiresAt } = await res.json() as { token: string; expiresAt: string };
		const chat = await verifyChatToken(token, SECRET);
		expect(chat).toMatchObject({ typ: "chat", agentId: "a1", uid: "u1" });
		// It cannot be turned around and used as an account session anywhere else.
		expect(await verifySession(token, SECRET)).toBeNull();
		// Minutes, not the 30-day account session.
		expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
	});
});

describe("GET /v1/agents/:id/ws (WebSocket auth boundary)", () => {
	const chatTokenFor = async (agentId: string, uid: string) =>
		(await signChatToken(agentId, uid, SECRET)).token;

	it("426s without the Upgrade: websocket header", async () => {
		const { app, env } = buildApp([{ id: "a1", owner_id: "u1" }]);
		const res = await app.request("/v1/agents/a1/ws", {}, env);
		expect(res.status).toBe(426);
	});

	it("401s (plain text) when the ?token= query is missing", async () => {
		const { app, env } = buildApp([{ id: "a1", owner_id: "u1" }]);
		const res = await app.request("/v1/agents/a1/ws", { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("Missing token");
	});

	it("401s a bogus token", async () => {
		const { app, env } = buildApp([{ id: "a1", owner_id: "u1" }]);
		const res = await app.request("/v1/agents/a1/ws?token=garbage", { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("Invalid");
	});

	// THE regression guard for #317. This used to be the accepted credential: a 30-day,
	// every-route account session sitting in a URL (history, Referer, proxy/CDN logs).
	// The failure mode of this fix is silently continuing to accept it alongside the new
	// token, which no other test here would notice.
	it("REFUSES the account session JWT, even the agent owner's", async () => {
		const { app, env, doCalls } = buildApp([{ id: "a1", owner_id: "u1" }]);
		const account = await tokenFor("u1");
		const res = await app.request(`/v1/agents/a1/ws?token=${account}`, { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("Invalid");
		expect(doCalls).toHaveLength(0);
	});

	it("REFUSES an admin's account session JWT (no role bypasses the token type)", async () => {
		const { app, env, doCalls } = buildApp([{ id: "a1", owner_id: "someone-else" }]);
		const account = await tokenFor("root", ["user", "admin"]);
		const res = await app.request(`/v1/agents/a1/ws?token=${account}`, { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(401);
		expect(doCalls).toHaveLength(0);
	});

	it("REFUSES a relay token — the other WS door's credential is not this one's", async () => {
		const { app, env } = buildApp([{ id: "a1", owner_id: "u1" }]);
		const { token } = await signRelayToken("a1", "u1", SECRET);
		const res = await app.request(`/v1/agents/a1/ws?token=${token}`, { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(401);
	});

	it("403s a chat token minted for a DIFFERENT agent", async () => {
		const { app, env, doCalls } = buildApp([{ id: "a1", owner_id: "u1" }, { id: "a2", owner_id: "u1" }]);
		const res = await app.request(`/v1/agents/a1/ws?token=${await chatTokenFor("a2", "u1")}`, { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(403);
		expect(doCalls).toHaveLength(0);
	});

	it("403s when ownership changed after the token was minted", async () => {
		const { app, env, doCalls } = buildApp([{ id: "a1", owner_id: "new-owner" }]);
		const res = await app.request(`/v1/agents/a1/ws?token=${await chatTokenFor("a1", "old-owner")}`, { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("Forbidden");
		expect(doCalls).toHaveLength(0);
	});

	it("404s a missing agent", async () => {
		const { app, env } = buildApp([]);
		const res = await app.request(`/v1/agents/ghost/ws?token=${await chatTokenFor("ghost", "u1")}`, { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(404);
	});

	it("403s a suspended account, even with a still-valid token (#273)", async () => {
		const { app, env, doCalls } = buildApp([{ id: "a1", owner_id: "u1" }], { suspended: 1 });
		const res = await app.request(`/v1/agents/a1/ws?token=${await chatTokenFor("a1", "u1")}`, { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("suspended");
		expect(doCalls).toHaveLength(0);
	});

	it("owner upgrade forwards to the DO with the server-verified uid pinned, and the token stripped", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp([{ id: "a1", owner_id: "u1" }]);
		setDoResponse(() => Response.json({ upgraded: true }));
		const res = await app.request(`/v1/agents/a1/ws?token=${await chatTokenFor("a1", "u1")}`, { headers: { Upgrade: "websocket" } }, env);
		expect(res.status).toBe(200);
		expect(doCalls).toHaveLength(1);
		expect(doCalls[0].path).toContain("user_id=u1"); // pinned, not client-supplied
		expect(doCalls[0].path).not.toContain("token="); // done its job at this boundary
	});
});

describe("GET /v1/agents/:id/messages + memory + tasks (owner-scoped DO proxy)", () => {
	it("401s unauthenticated reads", async () => {
		const { app, env } = buildApp([{ id: "a1", owner_id: "u1" }]);
		expect((await get(app, env, "/v1/agents/a1/messages")).status).toBe(401);
	});

	it("404s a missing agent on message history", async () => {
		const { app, env } = buildApp([]);
		const res = await get(app, env, "/v1/agents/ghost/messages", await tokenFor("u1"));
		expect(res.status).toBe(404);
	});

	it("owner reads messages → forwards limit and returns the DO body", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp([{ id: "a1", owner_id: "u1" }]);
		setDoResponse(() => Response.json({ messages: [{ id: "m1" }] }));
		const res = await get(app, env, "/v1/agents/a1/messages?limit=5", await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).messages).toHaveLength(1);
		expect(doCalls[0].path).toContain("/messages?limit=5");
	});

	it("PUT memory forwards the body to the DO for the owner", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp([{ id: "a1", owner_id: "u1" }]);
		setDoResponse(() => Response.json({ saved: true }));
		const res = await json(app, env, "PUT", "/v1/agents/a1/memory", { key: "k", value: "v" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).saved).toBe(true);
		const put = doCalls.find((c) => c.path === "/memory" && c.method === "PUT");
		expect(put).toBeTruthy();
		expect(rec(put!.body).key).toBe("k");
	});

	it("POST tasks preserves the DO's 201 status", async () => {
		const { app, env, setDoResponse } = buildApp([{ id: "a1", owner_id: "u1" }]);
		setDoResponse(() => Response.json({ id: "t1" }, { status: 201 }));
		const res = await json(app, env, "POST", "/v1/agents/a1/tasks", { title: "do it" }, await tokenFor("u1"));
		expect(res.status).toBe(201);
		expect((await jsonBody(res)).id).toBe("t1");
	});

	it("blocks a non-owner from reading memory (403, no DO hit)", async () => {
		const { app, env, doCalls } = buildApp([{ id: "a1", owner_id: "owner" }]);
		const res = await get(app, env, "/v1/agents/a1/memory", await tokenFor("attacker"));
		expect(res.status).toBe(403);
		expect(doCalls).toHaveLength(0);
	});
});

describe("knowledge routes (owner-scoped DO proxy)", () => {
	it("DELETE knowledge/:docId forwards a DELETE to the DO", async () => {
		const { app, env, doCalls, setDoResponse } = buildApp([{ id: "a1", owner_id: "u1" }]);
		setDoResponse(() => Response.json({ deleted: true }));
		const res = await app.request("/v1/agents/a1/knowledge/doc-7", {
			method: "DELETE", headers: { Authorization: `Bearer ${await tokenFor("u1")}` },
		}, env);
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).deleted).toBe(true);
		const del = doCalls.find((c) => c.method === "DELETE");
		expect(del!.path).toContain("/knowledge/doc-7");
	});

	it("POST knowledge/ingest-url maps a non-OK DO status through", async () => {
		const { app, env, setDoResponse } = buildApp([{ id: "a1", owner_id: "u1" }]);
		setDoResponse(() => Response.json({ error: "bad url" }, { status: 400 }));
		const res = await json(app, env, "POST", "/v1/agents/a1/knowledge/ingest-url", { url: "x" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error).toBe("bad url");
	});
});
