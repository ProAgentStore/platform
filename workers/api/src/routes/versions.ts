import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import type { Env } from "../types.js";

export const versionRoutes = new Hono<{ Bindings: Env }>();

/** Save current agent state as a version snapshot. */
versionRoutes.post("/:id/versions", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id FROM agents WHERE id = ?1 OR slug = ?1",
	).bind(id).first<{ id: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (agent.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	const { description } = await c.req.json<{ description?: string }>().catch(() => ({ description: "" }));

	// Get current DO state
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	const stateRes = await stub.fetch(new Request("https://agent/state"));
	if (!stateRes.ok) throw new HttpError(400, "Agent not initialized");
	const state = await stateRes.json();

	// Get next version number
	const latest = await c.env.DB.prepare(
		"SELECT MAX(version_num) as num FROM agent_versions WHERE agent_id = ?1",
	).bind(agent.id).first<{ num: number | null }>();
	const versionNum = (latest?.num || 0) + 1;

	const versionId = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO agent_versions (id, agent_id, version_num, state_snapshot, description, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
	).bind(versionId, agent.id, versionNum, JSON.stringify(state), description || `Version ${versionNum}`).run();

	return c.json({ id: versionId, version: versionNum }, 201);
});

/** List versions for an agent. */
versionRoutes.get("/:id/versions", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id FROM agents WHERE id = ?1 OR slug = ?1",
	).bind(id).first<{ id: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (agent.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	const { results } = await c.env.DB.prepare(
		"SELECT id, version_num, description, created_at FROM agent_versions WHERE agent_id = ?1 ORDER BY version_num DESC",
	).bind(agent.id).all();

	return c.json({ versions: results });
});

/** Rollback to a specific version. */
versionRoutes.post("/:id/versions/:versionId/rollback", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const versionId = c.req.param("versionId");

	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id FROM agents WHERE id = ?1 OR slug = ?1",
	).bind(id).first<{ id: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (agent.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	const version = await c.env.DB.prepare(
		"SELECT state_snapshot FROM agent_versions WHERE id = ?1 AND agent_id = ?2",
	).bind(versionId, agent.id).first<{ state_snapshot: string }>();
	if (!version) throw new HttpError(404, "Version not found");

	const state = JSON.parse(version.state_snapshot);

	// Apply the snapshot to the DO
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id));
	await stub.fetch(new Request("https://agent/state", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(state),
	}));

	return c.json({ success: true, rolledBackTo: versionId });
});
