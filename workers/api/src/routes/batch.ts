import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import type { Env } from "../types.js";

export const batchRoutes = new Hono<{ Bindings: Env }>();

/** Bulk update visibility for multiple agents. */
batchRoutes.post("/bulk-visibility", async (c) => {
	const session = await requireUser(c);
	const { agentIds, visibility } = await c.req.json<{
		agentIds: string[];
		visibility: "draft" | "published" | "unlisted";
	}>();

	if (!agentIds?.length) throw new HttpError(400, "agentIds required");
	if (!["draft", "published", "unlisted"].includes(visibility)) {
		throw new HttpError(400, "visibility must be draft, published, or unlisted");
	}

	// Verify ownership of all agents
	const placeholders = agentIds.map((_, i) => `?${i + 1}`).join(",");
	const { results } = await c.env.DB.prepare(
		`SELECT id, owner_id FROM agents WHERE id IN (${placeholders})`,
	).bind(...agentIds).all<{ id: string; owner_id: string }>();

	const notOwned = results.filter(
		(a) => a.owner_id !== session.uid && !session.roles.includes("admin"),
	);
	if (notOwned.length > 0) {
		throw new HttpError(403, `Not authorized for ${notOwned.length} agent(s)`);
	}

	// Batch update
	const stmts = agentIds.map((id) =>
		c.env.DB.prepare(
			"UPDATE agents SET visibility = ?1, updated_at = datetime('now') WHERE id = ?2",
		).bind(visibility, id),
	);
	await c.env.DB.batch(stmts);

	return c.json({ success: true, updated: agentIds.length, visibility });
});

/** Bulk delete agents. */
batchRoutes.post("/bulk-delete", async (c) => {
	const session = await requireUser(c);
	const { agentIds } = await c.req.json<{ agentIds: string[] }>();

	if (!agentIds?.length) throw new HttpError(400, "agentIds required");

	const placeholders = agentIds.map((_, i) => `?${i + 1}`).join(",");
	const { results } = await c.env.DB.prepare(
		`SELECT id, owner_id FROM agents WHERE id IN (${placeholders})`,
	).bind(...agentIds).all<{ id: string; owner_id: string }>();

	const notOwned = results.filter(
		(a) => a.owner_id !== session.uid && !session.roles.includes("admin"),
	);
	if (notOwned.length > 0) {
		throw new HttpError(403, `Not authorized for ${notOwned.length} agent(s)`);
	}

	const stmts = agentIds.flatMap((id) => [
		c.env.DB.prepare("DELETE FROM agent_executions WHERE agent_id = ?1").bind(id),
		c.env.DB.prepare("DELETE FROM usage WHERE agent_id = ?1").bind(id),
		c.env.DB.prepare("DELETE FROM agent_versions WHERE agent_id = ?1").bind(id),
		c.env.DB.prepare("DELETE FROM agents WHERE id = ?1").bind(id),
	]);
	await c.env.DB.batch(stmts);

	return c.json({ success: true, deleted: agentIds.length });
});
