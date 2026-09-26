/**
 * An agent TYPE's tool contract (#771) — what the `/mcp/t/<agentSlug>` MCP session registers.
 *
 * `GET /v1/instances/:id/tools` answers for ONE instance: the template's declared set, narrowed by
 * that instance's owner (switched-off tools, connector write consent, permission-unlocked tools). This
 * answers the part every instance of the type shares — the DECLARED set — in the same row shape, from
 * the same `resolveToolPolicy`, with no instance's choices applied. A call still goes to one instance
 * (`POST /v1/instances/:id/tools/:name`), which applies them.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { projectToolListing, resolveToolPolicy } from "../lib/instance-tool-policy.js";
import type { Env } from "../types.js";

export const agentTypeToolRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/agents/:slug/tools — the type's declared tools, `?allowed=true` / `?schemas=true` as on the
 * instance listing. Readable for a published agent, one the caller owns, or one they have an instance
 * of (a subscriber keeps its contract after the agent is unpublished). No instance is named or needed.
 */
agentTypeToolRoutes.get("/:slug/tools", async (c) => {
	const session = await requireUser(c);
	const agent = await c.env.DB.prepare(
		`SELECT a.id AS id, a.slug AS slug, a.category AS category, a.config AS config FROM agents a
		 WHERE (a.slug = ?1 OR a.id = ?1)
		   AND (a.visibility = 'published' OR a.owner_id = ?2 OR EXISTS (SELECT 1 FROM agent_instances i WHERE i.agent_id = a.id AND i.user_id = ?2))
		 LIMIT 1`,
	)
		.bind(c.req.param("slug"), session.uid)
		.first<{ id: string; slug: string; category: string | null; config: string | null }>();
	if (!agent) throw new HttpError(404, "Agent type not found");
	return c.json({
		agent: { id: agent.id, slug: agent.slug },
		tools: projectToolListing(resolveToolPolicy(agentCapabilities(agent)), {
			allowedOnly: c.req.query("allowed") === "true",
			schemas: c.req.query("schemas") === "true",
		}),
	});
});

/**
 * Why an instance cannot serve a call made on agent type `expected`'s session (#771), or null when it
 * can. Without it a type session would run a same-named tool on an instance of a DIFFERENT type — one
 * the caller owns, but not what the session they connected to promised.
 */
export async function agentTypeMismatch(env: Env, agentId: string, expected: string): Promise<string | null> {
	if (agentId === expected) return null;
	const row = await env.DB.prepare("SELECT slug FROM agents WHERE id = ?1").bind(agentId).first<{ slug: string | null }>();
	if (row?.slug === expected) return null;
	const actual = row?.slug ?? "another agent type";
	return `This instance is ${actual}, not ${expected} — a /mcp/t/${expected} session runs only ${expected} instances. Use ${row?.slug ? `/mcp/t/${row.slug}` : "/mcp"} for it.`;
}
