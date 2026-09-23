import { Hono } from "hono";
import { getRegistryTool, runRegistryTool } from "../lib/tool-registry.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { logEvent } from "../lib/events.js";
import {
	bindWebsiteBuilderFwsSession,
	claimWebsiteBuilderSiteCreation,
	confirmWebsiteBuilderNoindex,
	getWebsiteBuilderJob,
	markWebsiteBuilderJob,
	recordWebsiteBuilderJobCall,
	websiteBuilderTokenActive,
	websiteBuilderTokenHash,
	websiteBuilderToolAllowed,
	websiteBuilderToolInputAllowed,
	type WebsiteBuilderJob,
} from "../lib/website-builder-jobs.js";
import type { Env } from "../types.js";

/**
 * Job-scoped FWS broker. This is intentionally not an owner-authenticated generic
 * tool route: the subscription CLI gets a short-lived job secret, not a PAGS OAuth
 * session, and therefore cannot escape the draft-only allowlist by changing prompts.
 */
export const websiteBuilderBrokerRoutes = new Hono<{ Bindings: Env }>();

function fwsSessionId(content: string): string | null {
	try {
		const envelope = JSON.parse(content) as { data?: unknown };
		const data = envelope?.data;
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		const value = (data as Record<string, unknown>).session_id;
		return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 256 ? value.trim() : null;
	} catch {
		return null;
	}
}

/** The connector's success only says the MCP envelope arrived. FWS can report an in-band error. */
function fwsResultOk(content: string): boolean {
	try {
		const envelope = JSON.parse(content) as { data?: unknown };
		const data = envelope?.data;
		return !(data && typeof data === "object" && !Array.isArray(data) && typeof (data as Record<string, unknown>).error === "string");
	} catch {
		return true;
	}
}

/** Text metadata survives PAGS's generic MCP transport; image blocks currently do not. */
function fwsCaptureMetadata(content: string): Record<string, unknown> {
	try {
		const data = (JSON.parse(content) as { data?: unknown }).data;
		if (!data || typeof data !== "object" || Array.isArray(data)) return {};
		const source = data as Record<string, unknown>;
		const fields = ["preview_url", "viewport", "width", "height", "mime_type"] as const;
		return Object.fromEntries(fields.filter((key) => typeof source[key] === "string" || typeof source[key] === "number").map((key) => [key, source[key]]));
	} catch {
		return {};
	}
}

/** Force every session-scoped FWS call onto the one session PAGS observed create_site mint. */
function boundArgs(job: WebsiteBuilderJob, tool: string, supplied: Record<string, unknown>): { args?: Record<string, unknown>; error?: string } {
	if (tool === "list_templates") {
		if ("session_id" in supplied) return { error: "list_templates is not session-scoped; do not provide session_id." };
		return { args: supplied };
	}
	if (tool === "create_site") {
		if (job.fwsSessionId || job.createStartedAt) return { error: "create_site has already been claimed for this job; PAGS permits exactly one FWS draft session." };
		if ("session_id" in supplied) return { error: "create_site mints the session; it may not receive a session_id." };
		return { args: supplied };
	}
	if (!job.fwsSessionId) return { error: "Call create_site first. PAGS has not bound an FWS draft session for this job." };
	if ("session_id" in supplied && supplied.session_id !== job.fwsSessionId) return { error: "The supplied session_id does not match this Website Builder job's FWS draft session." };
	return { args: { ...supplied, session_id: job.fwsSessionId } };
}

websiteBuilderBrokerRoutes.post("/:jobId/call", async (c) => {
	const jobId = c.req.param("jobId");
	const token = c.req.header("X-Pags-Website-Builder-Token") || "";
	const job = await getWebsiteBuilderJob(c.env, jobId);
	if (!job || job.status !== "running" || !token || !websiteBuilderTokenActive(job) || (await websiteBuilderTokenHash(token)) !== job.tokenHash) {
		return c.json({ error: "Website Builder job is not authorised." }, 401);
	}
	const body: { tool?: unknown; args?: unknown } = await c.req.json<{ tool?: unknown; args?: unknown }>().catch(() => ({}));
	if (!websiteBuilderToolAllowed(body.tool)) {
		return c.json({ error: "This Website Builder job may only call draft-building FWS tools; deploy, publish, push_update and delete are never available." }, 403);
	}
	const suppliedArgs = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
	if (!websiteBuilderToolInputAllowed(body.tool, suppliedArgs)) return c.json({ error: "Website Builder may set metadata only with noindex:true; draft protection cannot be removed." }, 403);
	const bound = boundArgs(job, body.tool, suppliedArgs);
	if (!bound.args) return c.json({ error: bound.error }, 403);
	if (job.fwsSessionId && !job.noindexConfirmed && body.tool !== "set_meta") {
		return c.json({ error: "PAGS requires a successful set_meta({ noindex: true }) on the bound FWS session before any other session operation." }, 403);
	}
	if (body.tool === "create_site" && !(await claimWebsiteBuilderSiteCreation(c.env, jobId))) {
		return c.json({ error: "create_site has already been claimed for this Website Builder job." }, 409);
	}
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
	}, { url: job.mcpUrl, tool: body.tool, args: bound.args });
	const createdSession = body.tool === "create_site" && result.success ? fwsSessionId(result.content) : null;
	let success = result.success && fwsResultOk(result.content);
	let content = result.content;
	if (body.tool === "create_site") {
		if (!createdSession || !(await bindWebsiteBuilderFwsSession(c.env, jobId, createdSession))) {
			success = false;
			content = `${result.content}\nPAGS refused this create_site result because it did not provide one bindable FWS session id.`;
		}
	}
	if (body.tool === "set_meta" && success) await confirmWebsiteBuilderNoindex(c.env, jobId);
	const sessionId = createdSession ?? job.fwsSessionId;
	await recordWebsiteBuilderJobCall(c.env, {
		jobId, tool: body.tool, args: bound.args, result: content, success,
		metadata: {
			source: "pags.website_builder_broker", endpoint: job.mcpUrl, session_id: sessionId, brokered_at: new Date().toISOString(),
			...fwsCaptureMetadata(result.content),
		},
	});
	// A successful remote create without a machine-verifiable session id leaves an
	// unreachable draft. Revoke immediately rather than letting a retry mint another.
	if (body.tool === "create_site" && !success) await markWebsiteBuilderJob(c.env, jobId, "failed", { error: "FWS create_site did not return a bindable draft session." });
	await logEvent(c.env, {
		source: "website-builder", event: "website_builder.fws_call", level: success ? "info" : "warn",
		message: `${String(body.tool)} ${success ? "completed" : "refused"}`,
		userId: job.userId, instanceId: job.instanceId, context: { jobId, tool: body.tool, sessionId },
	}).catch(() => undefined);
	return c.json({ ok: success, content }, success ? 200 : 409);
});
