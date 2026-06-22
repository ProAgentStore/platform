/**
 * Storage routes — proxy to AgentDO for collections, files, vector search,
 * activity log, summaries, and user context.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import type { Env } from "../types.js";

export const storageRoutes = new Hono<{ Bindings: Env }>();
export const instanceStorageRoutes = new Hono<{ Bindings: Env }>();

async function resolveAgent(c: { req: { param(k: string): string }; env: Env }) {
	const id = c.req.param("id");
	const agent = await c.env.DB.prepare(
		"SELECT id FROM agents WHERE (id = ?1 OR slug = ?1)",
	)
		.bind(id)
		.first<{ id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	return agent;
}

async function resolveOwnedInstance(
	c: { req: { param(k: string): string }; env: Env },
	session: { uid: string },
) {
	const id = c.req.param("id");
	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(id, session.uid)
		.first<{ id: string }>();
	if (!instance) throw new HttpError(404, "Instance not found");
	return instance;
}

function getStub(c: { env: Env }, agentId: string) {
	return c.env.AGENT.get(c.env.AGENT.idFromName(agentId));
}

async function proxyDO(
	c: { env: Env },
	agentId: string,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const stub = getStub(c, agentId);
	const doRes = await stub.fetch(new Request(`https://agent${path}`, init));
	const data = await doRes.json();
	return Response.json(data, { status: doRes.status as ContentfulStatusCode });
}

// ── Collection initialization ────────────────────────────────────────────────

storageRoutes.post("/:id/init-collections", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	return proxyDO(c, agent.id, "/init-collections", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

// ── Collections ─────────────────────────────────────────────────────────────

storageRoutes.get("/:id/collections", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	return proxyDO(c, agent.id, "/collections");
});

storageRoutes.post("/:id/collections", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	return proxyDO(c, agent.id, "/collections", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

storageRoutes.get("/:id/collections/:name", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const name = c.req.param("name");
	return proxyDO(c, agent.id, `/collections/${encodeURIComponent(name)}`);
});

storageRoutes.delete("/:id/collections/:name", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const name = c.req.param("name");
	return proxyDO(c, agent.id, `/collections/${encodeURIComponent(name)}`, {
		method: "DELETE",
	});
});

storageRoutes.get("/:id/collections/:name/records", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const name = c.req.param("name");
	const query = new URL(c.req.url).search;
	return proxyDO(c, agent.id, `/collections/${encodeURIComponent(name)}/records${query}`);
});

storageRoutes.post("/:id/collections/:name/records", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const name = c.req.param("name");
	return proxyDO(c, agent.id, `/collections/${encodeURIComponent(name)}/records`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

storageRoutes.get("/:id/collections/:name/records/:recordId", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const name = c.req.param("name");
	const recordId = c.req.param("recordId");
	return proxyDO(c, agent.id, `/collections/${encodeURIComponent(name)}/records/${encodeURIComponent(recordId)}`);
});

storageRoutes.put("/:id/collections/:name/records/:recordId", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const name = c.req.param("name");
	const recordId = c.req.param("recordId");
	return proxyDO(c, agent.id, `/collections/${encodeURIComponent(name)}/records/${encodeURIComponent(recordId)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

storageRoutes.delete("/:id/collections/:name/records/:recordId", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const name = c.req.param("name");
	const recordId = c.req.param("recordId");
	return proxyDO(c, agent.id, `/collections/${encodeURIComponent(name)}/records/${encodeURIComponent(recordId)}`, {
		method: "DELETE",
	});
});

// ── Files ───────────────────────────────────────────────────────────────────

storageRoutes.get("/:id/files", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const query = new URL(c.req.url).search;
	return proxyDO(c, agent.id, `/files${query}`);
});

storageRoutes.post("/:id/files", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	return proxyDO(c, agent.id, "/files", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

storageRoutes.get("/:id/files/:fileId", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const fileId = c.req.param("fileId");
	// For file downloads, proxy the raw response (not JSON)
	const stub = getStub(c, agent.id);
	return stub.fetch(new Request(`https://agent/files/${encodeURIComponent(fileId)}`));
});

storageRoutes.delete("/:id/files/:fileId", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const fileId = c.req.param("fileId");
	return proxyDO(c, agent.id, `/files/${encodeURIComponent(fileId)}`, {
		method: "DELETE",
	});
});

// ── Vector Search ───────────────────────────────────────────────────────────

storageRoutes.post("/:id/search", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	return proxyDO(c, agent.id, "/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

// ── Activity Log ────────────────────────────────────────────────────────────

storageRoutes.get("/:id/activity", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const query = new URL(c.req.url).search;
	return proxyDO(c, agent.id, `/activity${query}`);
});

// ── Summaries ───────────────────────────────────────────────────────────────

storageRoutes.get("/:id/summaries", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const query = new URL(c.req.url).search;
	return proxyDO(c, agent.id, `/summaries${query}`);
});

storageRoutes.post("/:id/summarize", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	return proxyDO(c, agent.id, "/summarize", { method: "POST" });
});

// ── User Context ────────────────────────────────────────────────────────────

storageRoutes.get("/:id/users/:userId/context", async (c) => {
	await requireUser(c);
	const agent = await resolveAgent(c);
	const userId = c.req.param("userId");
	return proxyDO(c, agent.id, `/users/${encodeURIComponent(userId)}/context`);
});

// ── Instance Storage Routes ─────────────────────────────────────────────────
// Same endpoints but scoped to user-owned instances (different D1 table)

instanceStorageRoutes.post("/:id/init-collections", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/init-collections", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

instanceStorageRoutes.get("/:id/collections", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/collections");
});

instanceStorageRoutes.get("/:id/collections/:name/records", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	const name = c.req.param("name");
	const query = new URL(c.req.url).search;
	return proxyDO(c, instance.id, `/collections/${encodeURIComponent(name)}/records${query}`);
});

instanceStorageRoutes.post("/:id/collections/:name/records", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	const name = c.req.param("name");
	return proxyDO(c, instance.id, `/collections/${encodeURIComponent(name)}/records`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

instanceStorageRoutes.get("/:id/collections/:name/records/:recordId", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	const name = c.req.param("name");
	const recordId = c.req.param("recordId");
	return proxyDO(c, instance.id, `/collections/${encodeURIComponent(name)}/records/${encodeURIComponent(recordId)}`);
});

instanceStorageRoutes.put("/:id/collections/:name/records/:recordId", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	const name = c.req.param("name");
	const recordId = c.req.param("recordId");
	return proxyDO(c, instance.id, `/collections/${encodeURIComponent(name)}/records/${encodeURIComponent(recordId)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

instanceStorageRoutes.delete("/:id/collections/:name/records/:recordId", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	const name = c.req.param("name");
	const recordId = c.req.param("recordId");
	return proxyDO(c, instance.id, `/collections/${encodeURIComponent(name)}/records/${encodeURIComponent(recordId)}`, {
		method: "DELETE",
	});
});

instanceStorageRoutes.delete("/:id/collections/:name", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	const name = c.req.param("name");
	return proxyDO(c, instance.id, `/collections/${encodeURIComponent(name)}`, {
		method: "DELETE",
	});
});

instanceStorageRoutes.get("/:id/files", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	const query = new URL(c.req.url).search;
	return proxyDO(c, instance.id, `/files${query}`);
});

instanceStorageRoutes.post("/:id/files", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/files", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

instanceStorageRoutes.post("/:id/search", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

instanceStorageRoutes.get("/:id/activity", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	const query = new URL(c.req.url).search;
	return proxyDO(c, instance.id, `/activity${query}`);
});

// Instance memory, state, and knowledge — these are on chatRoutes for agents
// but instances need their own routes since the agent table lookup fails

instanceStorageRoutes.get("/:id/memory", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/memory");
});

instanceStorageRoutes.put("/:id/memory", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/memory", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

instanceStorageRoutes.get("/:id/state", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/state");
});

instanceStorageRoutes.put("/:id/state", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/state", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});

instanceStorageRoutes.get("/:id/knowledge", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/knowledge");
});

instanceStorageRoutes.post("/:id/knowledge", async (c) => {
	const session = await requireUser(c);
	const instance = await resolveOwnedInstance(c, session);
	return proxyDO(c, instance.id, "/knowledge", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(await c.req.json()),
	});
});
