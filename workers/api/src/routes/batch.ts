import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { blockPublishReason } from "../lib/test-agent-guard.js";
import type { Env } from "../types.js";

export const batchRoutes = new Hono<{ Bindings: Env }>();

/** Bulk update visibility for multiple agents. */
batchRoutes.post("/bulk-visibility", async (c) => {
	const session = await requireUser(c);
	const { agentIds, visibility, allowTestAgent } = await c.req.json<{
		agentIds: string[];
		visibility: "draft" | "published" | "unlisted";
		allowTestAgent?: boolean;
	}>();

	if (!agentIds?.length) throw new HttpError(400, "agentIds required");
	if (!["draft", "published", "unlisted"].includes(visibility)) {
		throw new HttpError(400, "visibility must be draft, published, or unlisted");
	}

	// Verify ownership of all agents
	const placeholders = agentIds.map((_, i) => `?${i + 1}`).join(",");
	const { results } = await c.env.DB.prepare(
		`SELECT id, owner_id, slug, name, description FROM agents WHERE id IN (${placeholders})`,
	).bind(...agentIds).all<{ id: string; owner_id: string; slug: string; name: string; description: string | null }>();

	const notOwned = results.filter(
		(a) => a.owner_id !== session.uid && !session.roles.includes("admin"),
	);
	if (notOwned.length > 0) {
		throw new HttpError(403, `Not authorized for ${notOwned.length} agent(s)`);
	}

	// The smoke-test guard (#65) lived only on `PUT /v1/agents/:id`, so this route was an open
	// second door onto the public catalog — the exact way a fixture gets back in after a cleanup
	// (#64). Checked per agent and refused as a batch: a bulk publish that silently skipped some
	// ids would leave the caller believing all of them shipped.
	if (visibility === "published") {
		const blocked = results
			.map((a) => ({ slug: a.slug, reason: blockPublishReason(a, visibility, allowTestAgent === true) }))
			.filter((r): r is { slug: string; reason: string } => r.reason !== null);
		if (blocked.length > 0) {
			throw new HttpError(400, `Refusing to publish ${blocked.length} agent(s): ${blocked.map((b) => `${b.slug} — ${b.reason}`).join(" ")}`);
		}
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
