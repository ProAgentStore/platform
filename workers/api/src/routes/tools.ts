import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import { getRegistryTool, registryTools, runRegistryTool } from "../lib/tool-registry.js";
import type { Env } from "../types.js";

/**
 * Generic connector/registry tool surface (issue #87). The SAME tools the agent
 * runtime dispatches (agent-think → runRegistryTool) are callable directly here and,
 * via a thin MCP proxy, over MCP — so a connector tool is defined once and usable
 * everywhere. Owner-scoped; tools run with the owner's own connector auth.
 */
export const toolRoutes = new Hono<{ Bindings: Env }>();

/** GET /v1/instances/:id/tools — connector tools callable on this instance + schemas. */
toolRoutes.get("/:id/tools", async (c) => {
	const session = await requireUser(c);
	await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const tools = registryTools().map((t) => ({
		name: t.name,
		connector: t.connector,
		scope: t.scope,
		description: t.description,
		parameters: t.parameters,
	}));
	return c.json({ tools });
});

/** POST /v1/instances/:id/tools/:name — invoke a connector tool (body = its input args). */
toolRoutes.post("/:id/tools/:name", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const name = c.req.param("name");
	if (!getRegistryTool(name)) throw new HttpError(404, `Unknown tool: ${name}`);
	const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await runRegistryTool(name, { env: c.env, userId: session.uid, instanceId }, input);
	return c.json(result);
});
