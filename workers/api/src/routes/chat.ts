import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import { verifySession } from "../lib/session.js";
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

	const data = await doRes.json();
	return c.json(data, (doRes.ok ? 200 : doRes.status) as ContentfulStatusCode);
});

/** WebSocket upgrade for real-time chat. */
chatRoutes.get("/:id/ws", async (c) => {
	const upgradeHeader = c.req.header("Upgrade");
	if (upgradeHeader !== "websocket") {
		throw new HttpError(426, "Expected WebSocket upgrade");
	}

	// SECURITY: authenticate the upgrade. WS clients can't reliably send an
	// Authorization header, so the session token comes as ?token= (same as the
	// relay). Without this the DO trusted a client-supplied `userId` and would
	// run inference on ANY user's stored API key. Return plain-HTTP errors — WS
	// clients don't surface JSON error bodies.
	const token = c.req.query("token");
	if (!token) return new Response("Missing token", { status: 401 });
	const session = await verifySession(token, c.env.SESSION_SIGNING_KEY);
	if (!session) return new Response("Invalid or expired token", { status: 401 });

	const id = c.req.param("id");
	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id FROM agents WHERE (id = ?1 OR slug = ?1)",
	)
		.bind(id)
		.first<{ id: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (agent.owner_id !== session.uid && !session.roles.includes("admin")) {
		return new Response("Forbidden", { status: 403 });
	}

	const doId = c.env.AGENT.idFromName(agent.id);
	const stub = c.env.AGENT.get(doId);

	// Forward the upgrade with the SERVER-verified uid pinned in the URL; the DO
	// binds it to the socket and ignores any client-supplied userId.
	const doUrl = new URL(c.req.url);
	doUrl.searchParams.set("user_id", session.uid);
	return stub.fetch(new Request(doUrl.toString(), c.req.raw));
});

/** Get message history. */
chatRoutes.get("/:id/messages", async (c) => {
	const agent = await resolveAgent(c);

	const doId = c.env.AGENT.idFromName(agent.id);
	const stub = c.env.AGENT.get(doId);

	const limit = c.req.query("limit") || "50";
	const doRes = await stub.fetch(
		new Request(`https://agent/messages?limit=${limit}`),
	);
	const data = await doRes.json();
	return c.json(data);
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
