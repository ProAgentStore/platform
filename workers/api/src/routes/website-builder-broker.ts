import { Hono } from "hono";
import { getRegistryTool, runRegistryTool } from "../lib/tool-registry.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { logEvent } from "../lib/events.js";
import { getWebsiteBuilderJob, recordWebsiteBuilderJobCall, websiteBuilderTokenHash, websiteBuilderToolAllowed, websiteBuilderToolInputAllowed } from "../lib/website-builder-jobs.js";
import type { Env } from "../types.js";

/**
 * Job-scoped FWS broker. This is intentionally not an owner-authenticated generic
 * tool route: the subscription CLI gets a short-lived job secret, not a PAGS OAuth
 * session, and therefore cannot escape the draft-only allowlist by changing prompts.
 */
export const websiteBuilderBrokerRoutes = new Hono<{ Bindings: Env }>();

websiteBuilderBrokerRoutes.post("/:jobId/call", async (c) => {
	const jobId = c.req.param("jobId");
	const token = c.req.header("X-Pags-Website-Builder-Token") || "";
	const job = await getWebsiteBuilderJob(c.env, jobId);
	if (!job || job.status !== "running" || !token || (await websiteBuilderTokenHash(token)) !== job.tokenHash) {
		return c.json({ error: "Website Builder job is not authorised." }, 401);
	}
	const body: { tool?: unknown; args?: unknown } = await c.req.json<{ tool?: unknown; args?: unknown }>().catch(() => ({}));
	if (!websiteBuilderToolAllowed(body.tool)) {
		return c.json({ error: "This Website Builder job may only call draft-building FWS tools; deploy, publish, push_update and delete are never available." }, 403);
	}
	const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
	if (!websiteBuilderToolInputAllowed(body.tool, args)) return c.json({ error: "Website Builder may set metadata only with noindex:true; draft protection cannot be removed." }, 403);
	// Re-resolve the instance declaration on EVERY call. A grant or mcp_call_tool
	// toggle revoked while a local CLI is mid-turn must take effect immediately.
	const caps = await capabilitiesForInstance(c.env, job.instanceId, job.userId);
	if (!caps) return c.json({ error: "The Website Builder instance is no longer available." }, 404);
	if (caps.tools && !caps.tools.includes("mcp_call_tool")) {
		return c.json({ error: "This agent no longer permits outbound MCP calls." }, 403);
	}
	const def = getRegistryTool("mcp_call_tool");
	if (!def) return c.json({ error: "MCP connector is unavailable." }, 503);
	const result = await runRegistryTool("mcp_call_tool", {
		env: c.env, instanceId: job.instanceId, userId: job.userId, declaredTools: caps.tools,
	}, { url: job.mcpUrl, tool: body.tool, args });
	await recordWebsiteBuilderJobCall(c.env, { jobId, tool: body.tool, args, result: result.content, success: result.success });
	await logEvent(c.env, {
		source: "website-builder", event: "website_builder.fws_call", level: result.success ? "info" : "warn",
		message: `${String(body.tool)} ${result.success ? "completed" : "refused"}`,
		userId: job.userId, instanceId: job.instanceId, context: { jobId, tool: body.tool },
	}).catch(() => undefined);
	return c.json({ ok: result.success, content: result.content }, result.success ? 200 : 409);
});
