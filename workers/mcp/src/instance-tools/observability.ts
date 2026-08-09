import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Read-only windows onto what an instance DID — its messages, its activity log, the
 * platform error log, the unified trace, and pipeline runs.
 *
 * Everything here is a read except `clear_instance_messages`, which is grouped with the
 * messages it clears rather than with the other destructive tools: the pairing is the
 * point (`instance_messages` is how you check what you are about to destroy).
 */
export function registerObservabilityTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"instance_messages",
		"Read recent messages from one of your private subscribed instances.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			limit: z.number().int().min(1).max(100).optional(),
		},
		async ({ token, instance_id, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/messages?limit=${limit || 50}`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"clear_instance_messages",
		"Clear a subscribed instance's chat history (all messages; voice recordings are deleted too). This cannot be undone.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			confirm: z.string().optional().describe('Must be "clear_instance_messages" to clear the chat history.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "clear_instance_messages", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "clear_instance_messages", "clear ALL instance chat messages", input, {
					endpoint: `/v1/instances/${instance_id}/messages`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "clear_instance_messages", confirm, "clear_instance_messages", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/messages`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			await audit(safetyFor(token), { tool: "clear_instance_messages", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"instance_activity",
		"Read a subscribed instance's activity log (chat, tool calls, file uploads, record mutations — append-only).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/activity`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"list_errors",
		"Read the platform error log — persisted failures (key-proxy, sign-in, apply/coding, and workflow crashes) that would otherwise be invisible. Yours by default; scope \"all\" returns everyone's (admin only). Filter by source and limit.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			scope: z.enum(["me", "all"]).optional().describe('"all" = every user\'s errors (admin only); default your own.'),
			source: z.string().optional().describe("Filter by source, e.g. keys-proxy | auth | job-apply | coding."),
			limit: z.number().int().min(1).max(500).optional(),
		},
		async ({ token, scope, source, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = new URLSearchParams();
			if (scope === "all") qs.set("scope", "all");
			if (source) qs.set("source", source);
			if (limit) qs.set("limit", String(limit));
			const data = await authedCall(`/v1/errors${qs.toString() ? `?${qs.toString()}` : ""}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"agent_trace",
		"Reconstruct the complete, time-ordered timeline of what an agent instance DID — chat turns (chat.in/tool.call/chat.out), apply steps/handoffs/outcomes (apply.*), and failures (level=error), interleaved. This is the primary tool for debugging or improving an agent: see exactly what happened, in order, not just errors. Filter by trace_id (one run/turn), source (chat|apply|coding|voice), or level; limit caps recent events.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("The instance (agent) to trace."),
			trace_id: z.string().optional().describe("Narrow to one run/turn (e.g. an apply taskId or a chat turn id)."),
			source: z.string().optional().describe("Filter by subsystem: chat | apply | coding | voice | tool."),
			level: z.enum(["debug", "info", "warn", "error"]).optional().describe("Minimum-interest filter — e.g. \"error\" for just failures."),
			limit: z.number().int().min(1).max(1000).optional().describe("Most-recent events to return (default 200), shown oldest→newest."),
		},
		async ({ token, instance_id, trace_id, source, level, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = new URLSearchParams();
			if (trace_id) qs.set("trace_id", trace_id);
			if (source) qs.set("source", source);
			if (level) qs.set("level", level);
			if (limit) qs.set("limit", String(limit));
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/trace${qs.toString() ? `?${qs.toString()}` : ""}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"list_pipeline_runs",
		"List an instance's declarative-pipeline runs (issue #98) — for each run: which pipeline, when it started/finished, its status, and its counts (seen/added/skipped/errors). This is the run-level observability surface; for the per-output-record audit trail (what the pipeline saw + decided for each record), read the sink collection's records — each carries an `audit` field. Filter by pipeline name; limit caps rows (most recent first).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("The instance (agent) whose pipeline runs to list."),
			pipeline: z.string().optional().describe("Narrow to one pipeline's run history."),
			limit: z.number().int().min(1).max(500).optional().describe("Most-recent runs to return (default 50)."),
		},
		async ({ token, instance_id, pipeline, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = new URLSearchParams();
			if (pipeline) qs.set("pipeline", pipeline);
			if (limit) qs.set("limit", String(limit));
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/pipeline-runs${qs.toString() ? `?${qs.toString()}` : ""}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_pipeline",
		"Read back the stored definition of a named declarative pipeline on this instance (issue #464). Returns the full pipeline JSON (steps, sink, etc.) exactly as stored, plus `valid` and `error` so you can tell whether the live copy will run successfully. 404 when the name is not present. Use this before running or re-PUTting a pipeline — re-PUTting without reading first destroys any divergence from the reference definition.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("The instance whose pipeline definition to read."),
			pipeline: z.string().describe("The pipeline name (key under config.pipelines, e.g. 'lead_finder')."),
		},
		async ({ token, instance_id, pipeline }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/pipelines/${encodeURIComponent(pipeline)}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);
}
