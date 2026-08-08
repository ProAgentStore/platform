import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, isAdmin, isSuspended, requireUser } from "../lib/auth.js";
import { signChatToken, verifyChatToken } from "../lib/session.js";
import type { Env } from "../types.js";

export const chatRoutes = new Hono<{ Bindings: Env }>();

/** Resolve agent from :id param (by id or slug). Returns id + name for DO init. */
async function resolveAgent(c: Context<{ Bindings: Env }>) {
	// SECURITY: these are creator-management routes (the TEMPLATE agent's state/memory/
	// knowledge/tasks/chat). Without an ownership check any authenticated user could
	// read another creator's chat history or OVERWRITE their agent's memory/identity/
	// knowledge by id or slug. Require ownership (or admin).
	const session = await requireUser(c);
	const id = c.req.param("id");
	const agent = await c.env.DB.prepare(
		"SELECT id, name, model, owner_id FROM agents WHERE (id = ?1 OR slug = ?1)",
	)
		.bind(id)
		.first<{ id: string; name: string; model: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (agent.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}
	return agent;
}

/** Send a message to an agent (HTTP). */
chatRoutes.post("/:id/chat", async (c) => {
	const session = await requireUser(c);
	const { message } = await c.req.json<{ message: string }>();
	if (!message) throw new HttpError(400, "message required");
	const agent = await resolveAgent(c);

	// Forward to the agent's Durable Object (pass name+id for auto-init)
	const doId = c.env.AGENT.idFromName(agent.id);
	const stub = c.env.AGENT.get(doId);

	const doRes = await stub.fetch(
		new Request("https://agent/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message,
				channel: "chat",
				userId: session.uid,
				agentId: agent.id,
				agentName: agent.name,
			}),
		}),
	);

	// Track usage
	await c.env.DB.prepare(
		`INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
     VALUES (?1, ?2, ?3, 'chat', '{}', datetime('now'))`,
	)
		.bind(crypto.randomUUID(), agent.id, session.uid)
		.run();

	// A hard DO crash (CPU limit / isolate reset) returns a non-JSON body; parsing it
	// blindly threw a SyntaxError that became an opaque 500. Read text, then parse.
	const raw = await doRes.text();
	let data: unknown;
	try {
		data = raw ? JSON.parse(raw) : {};
	} catch {
		data = { error: raw.slice(0, 500) || `Agent did not return a valid response (${doRes.status})` };
	}
	return c.json(data as Record<string, unknown>, (doRes.ok ? 200 : doRes.status) as ContentfulStatusCode);
});

/**
 * POST /v1/agents/:id/ws-token
 *
 * Mint the short-lived, agent-scoped token the chat WebSocket handshake takes (#317).
 * The client calls this with its ACCOUNT session in an Authorization header — where a
 * 30-day credential belongs — and gets back a token good for one agent's socket for
 * minutes. This route, not `/ws`, is the authorization decision: `resolveAgent` runs
 * the ownership-or-admin gate and `requireUser` the suspension gate.
 */
chatRoutes.post("/:id/ws-token", async (c) => {
	const session = await requireUser(c);
	const agent = await resolveAgent(c);
	// Bind the RESOLVED id, so a token minted via a slug still names one concrete agent.
	const { token, exp } = await signChatToken(agent.id, session.uid, c.env.SESSION_SIGNING_KEY);
	return c.json({ token, expiresAt: new Date(exp * 1000).toISOString() });
});

/** WebSocket upgrade for real-time chat. */
chatRoutes.get("/:id/ws", async (c) => {
	const upgradeHeader = c.req.header("Upgrade");
	if (upgradeHeader !== "websocket") {
		throw new HttpError(426, "Expected WebSocket upgrade");
	}

	// SECURITY: authenticate the upgrade. The browser `WebSocket` constructor takes no
	// headers, so the credential has to ride in the URL — and a URL leaks (history,
	// Referer, proxy/CDN logs, error reporters, screenshots). So accept ONLY the
	// short-lived, agent-scoped token from POST /:id/ws-token; the 30-day account
	// session JWT is REFUSED here (#317), exactly as on the relay's /connect. A leaked
	// WS URL is then worth one agent's chat for minutes, not the whole account for a
	// month. Return plain-HTTP errors — WS clients don't surface JSON error bodies.
	const token = c.req.query("token");
	if (!token) return new Response("Missing token", { status: 401 });
	const chat = await verifyChatToken(token, c.env.SESSION_SIGNING_KEY);
	if (!chat) return new Response("Invalid or expired token", { status: 401 });
	// Verifying by hand skips requireUser's suspension gate, and this is a SPEND path
	// (every turn runs inference on a stored key) — the one surface a moderation lever
	// most needs to reach (#273). A chat token minted BEFORE a suspension stays
	// cryptographically valid until it expires, so the live check has to happen here too.
	if (await isSuspended(c, chat.uid)) return new Response("Account suspended", { status: 403 });

	const id = c.req.param("id");
	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id FROM agents WHERE (id = ?1 OR slug = ?1)",
	)
		.bind(id)
		.first<{ id: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	// The token names its agent; a token for agent A can't open agent B's socket.
	if (agent.id !== chat.agentId) return new Response("Forbidden", { status: 403 });
	// Defensive re-check (the token already encodes the mint-time decision): ownership
	// can change, or admin can be revoked, inside the token's lifetime. `isAdmin` reads
	// users.roles live — the chat token carries no roles[] to trust.
	if (
		agent.owner_id !== chat.uid &&
		!(await isAdmin(c, { uid: chat.uid, roles: [], iat: 0, exp: chat.exp }))
	) {
		return new Response("Forbidden", { status: 403 });
	}

	const doId = c.env.AGENT.idFromName(agent.id);
	const stub = c.env.AGENT.get(doId);

	// Forward the upgrade with the SERVER-verified uid pinned in the URL; the DO
	// binds it to the socket and ignores any client-supplied userId.
	const doUrl = new URL(c.req.url);
	// The credential has done its job at this boundary — don't carry it further.
	doUrl.searchParams.delete("token");
	doUrl.searchParams.set("user_id", chat.uid);
	// The RESOLVED agent id too (`:id` may be a slug). The DO pins it to the socket and uses it
	// when a turn arrives on an un-initialised DO — first-party agents seeded by migration have no
	// initialised template DO, and without this the auto-init fell back to the literal "unknown",
	// which is the Vectorize partition key and the only filter vectorSearch applies.
	doUrl.searchParams.set("agentId", agent.id);
	return stub.fetch(new Request(doUrl.toString(), c.req.raw));
});

/** Get message history. */
chatRoutes.get("/:id/messages", async (c) => {
	const agent = await resolveAgent(c);

	const doId = c.env.AGENT.idFromName(agent.id);
	const stub = c.env.AGENT.get(doId);

	// #428: `before` was dropped here too — the query string was rebuilt with only `limit`, so a
	// creator paging back through a template's transcript got the newest page every time.
	const params = new URLSearchParams({ limit: c.req.query("limit") || "50" });
	const before = c.req.query("before");
	if (before) params.set("before", before);
	const doRes = await stub.fetch(new Request(`https://agent/messages?${params}`));
	const data = await doRes.json();
	return c.json(data as Record<string, unknown>, (doRes.ok ? 200 : doRes.status) as ContentfulStatusCode);
});

/** Get/set agent memory. */
chatRoutes.get("/:id/memory", async (c) => {
	const agent = await resolveAgent(c);

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(new Request("https://agent/memory"));
	return c.json(await doRes.json());
});

chatRoutes.put("/:id/memory", async (c) => {
	const agent = await resolveAgent(c);

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(
		new Request("https://agent/memory", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}),
	);
	return c.json(await doRes.json());
});

/** Tasks CRUD — forwarded to DO. */
chatRoutes.get("/:id/tasks", async (c) => {
	const agent = await resolveAgent(c);

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(new Request("https://agent/tasks"));
	return c.json(await doRes.json());
});

chatRoutes.post("/:id/tasks", async (c) => {
	const agent = await resolveAgent(c);

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(
		new Request("https://agent/tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}),
	);
	return c.json(await doRes.json(), doRes.status as 201);
});

/** Agent DO state (identity, guardrails, etc.) */
chatRoutes.get("/:id/state", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(new Request("https://agent/state"));
	return c.json(await doRes.json());
});

chatRoutes.put("/:id/state", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(
		new Request("https://agent/state", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}),
	);
	return c.json(await doRes.json());
});

/** Knowledge base CRUD — forwarded to DO. */
chatRoutes.get("/:id/knowledge", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(new Request("https://agent/knowledge"));
	return c.json(await doRes.json());
});

chatRoutes.post("/:id/knowledge", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(
		new Request("https://agent/knowledge", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}),
	);
	return c.json(await doRes.json(), doRes.status as 201);
});

chatRoutes.delete("/:id/knowledge/:docId", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const docId = c.req.param("docId");
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(
		new Request(`https://agent/knowledge/${docId}`, { method: "DELETE" }),
	);
	return c.json(await doRes.json());
});

chatRoutes.post("/:id/knowledge/ingest-url", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const doRes = await stub.fetch(
		new Request("https://agent/knowledge/ingest-url", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}),
	);
	return c.json(
		await doRes.json(),
		(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
	);
});
