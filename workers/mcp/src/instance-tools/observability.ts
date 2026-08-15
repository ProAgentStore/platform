import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import { fitPage } from "../wire-budget.js";
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
		"Read recent messages from one of your private subscribed instances, newest page first. The response carries `nextCursor` and `hasMore`: when `hasMore` is true, call again with `before` set to that `nextCursor` to get the page OLDER than it, and repeat until `hasMore` is false. That is the only way to reach a message beyond the newest page — raising `limit` will not.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			// #566: the route has accepted `before` since #428 and the DO honours it, but this tool
			// built its query string with `limit` alone — so every response advertised `nextCursor`
			// and `hasMore: true` with no argument able to use either, and the whole conversation
			// older than one page was unreachable over MCP. The `list_feedback` → `instance_messages`
			// triage path (#514) dead-ended on exactly that.
			before: z.string().optional().describe("Cursor from a previous call's `nextCursor` — returns the page OLDER than it. An unrecognised cursor is rejected, not silently answered with the newest page."),
			// Deliberately 100 where the HTTP route allows 2000, and NOT raised to match. The route's
			// ceiling exists so the console can export a whole conversation; an MCP response is spent
			// as model context instead, where a 2000-message page is the payload problem #569 is
			// separately shrinking. With `before` in place the ceiling is no longer what limits reach
			// — paging is — so the smaller one costs nothing and bounds what one call can cost.
			limit: z.number().int().min(1).max(100).optional().describe("Messages per page (default 50, max 100). Page with `before` for older ones; the HTTP route allows 2000 for whole-conversation export, MCP stays smaller because the page is spent as model context."),
		},
		async ({ token, instance_id, limit, before }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// The DO's cursor is `msg:<iso>:<id>` — the colons are safe unencoded but the id is not
			// guaranteed to be, so it is encoded rather than interpolated raw.
			const cursor = before ? `&before=${encodeURIComponent(before)}` : "";
			const data = await authedCall(
				`/v1/instances/${instance_id}/messages?limit=${limit || 50}${cursor}`,
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
		"Reconstruct the complete, time-ordered timeline of what an agent instance DID — chat turns (chat.in/tool.call/chat.out), apply steps/handoffs/outcomes (apply.*), and failures, interleaved. This is the primary tool for debugging or improving an agent: see exactly what happened, in order, not just errors. Failures sit in two bands: a tool call that FAILED is level=warn (one row per failed tool, carrying the tool name in `context` and its full refusal text), while level=error means the turn or run could not complete at all. Since level is a floor, level=\"warn\" is the read that shows both — use it, not \"error\", when the question is \"what went wrong\". Filter by trace_id (one run/turn), source (chat|apply|coding|voice), or level. `count` always describes the WHOLE window `limit` selected and is never reduced; `events` is a PAGE of it, so read `page.hasMore` and call again with `offset: page.nextOffset` to continue. A busy instance's default 200-event window measured 163,437 bytes, 2.5x a calling host's 64 KiB limit, so one reply cannot carry them all and never could — narrow with trace_id or source when you know what you are looking for.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("The instance (agent) to trace."),
			trace_id: z.string().optional().describe("Narrow to one run/turn (e.g. an apply taskId or a chat turn id)."),
			source: z.string().optional().describe("Filter by subsystem: chat | apply | coding | voice | tool."),
			// #564: this said "minimum-interest filter" while the query said `level = ?`, so asking for
			// "warn" silently hid every error. It is a floor now; the wording says so explicitly
			// because the two disagreeing for three days is what put this here.
			level: z.enum(["debug", "info", "warn", "error"]).optional().describe("Minimum-interest FLOOR on the ladder debug < info < warn < error — returns that band AND everything above it, so \"warn\" includes the errors."),
			// #614: `limit` selects the WINDOW of history the API reads back; `offset` walks the page
			// within it. Two knobs, deliberately, because they answer different questions — "how far
			// back do I want to look" is not "how much fits in one reply", and collapsing them would
			// silently change what `limit` has always meant (most-recent N events).
			limit: z.number().int().min(1).max(1000).optional().describe("How many of the most-recent events to READ BACK (default 200), shown oldest→newest. This selects the window of history, not the size of the reply: the window is then delivered in budgeted pages via `offset`, so raising it does not make one reply bigger."),
			offset: z.number().int().min(0).optional().describe("Skip this many events within the window. Pass `page.nextOffset` from the previous reply; omit for the first page."),
		},
		async ({ token, instance_id, trace_id, source, level, limit, offset }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = new URLSearchParams();
			if (trace_id) qs.set("trace_id", trace_id);
			if (source) qs.set("source", source);
			if (level) qs.set("level", level);
			if (limit) qs.set("limit", String(limit));
			const data = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/trace${qs.toString() ? `?${qs.toString()}` : ""}`, sessionToken, {}, env);
			// An `{error}` body carries no `events` and passes through untouched rather than being
			// reshaped into a success with an empty timeline — the rule `vector_stats` follows, and
			// for the same reason: an empty trace and an unreadable one are different answers.
			const rec = data as { events?: unknown[] };
			if (!Array.isArray(rec.events)) return jsonText(data);
			const { events, ...head } = rec;
			// `count` (the window's true size) rides in FRONT of the page, so "how much happened"
			// survives a reply that carries a fifth of it — #503's rule that the count must never
			// live in the part that gets cut.
			const fitted = fitPage({ rows: events, offset, build: (rows, page) => ({ ...head, page, events: rows }) });
			return text(fitted.text);
		},
	);

	server.tool(
		"list_feedback",
		"Read what the OWNER said went wrong (#514) — in-session complaints about an agent, each anchored to the turn it is about. Every row carries `trace_id` and `message_id`, so the natural next calls are agent_trace(trace_id=…) for the tool calls of that turn and instance_messages for the surrounding conversation. That sequence, done by hand, is what produced issues #503–#505. Rows also carry a snapshot (target_text, prompt_text) that outlives the transcript and the trace's 14-day retention. Filter by instance_id and status (open|triaged|filed|dismissed).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().optional().describe("Narrow to one agent; omit for everything you have flagged."),
			status: z.enum(["open", "triaged", "filed", "dismissed"]).optional().describe('Triage state; "open" is the unfiled backlog.'),
			limit: z.number().int().min(1).max(500).optional().describe("Most-recent rows to return (default 100)."),
		},
		async ({ token, instance_id, status, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = new URLSearchParams();
			if (instance_id) qs.set("instance_id", instance_id);
			if (status) qs.set("status", status);
			if (limit) qs.set("limit", String(limit));
			const data = await authedCall(`/v1/feedback${qs.toString() ? `?${qs.toString()}` : ""}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"resolve_feedback",
		"Close the loop on one piece of feedback: set its status and record the issue it became. This is what keeps the backlog honest — a complaint filed as a GitHub issue (github_create_issue) is stamped with the URL so it is not filed twice, and one that is still open stays visible. The BODY is never editable: the row records what the owner said at the time, which is the property that makes it evidence.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			feedback_id: z.string().describe("The row id from list_feedback."),
			status: z.enum(["open", "triaged", "filed", "dismissed"]).describe("Where it now sits."),
			issue_url: z.string().optional().describe("The issue it became, when status is \"filed\"."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, feedback_id, status, issue_url, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { feedback_id, status, ...(issue_url ? { issue_url } : {}) };
			const denied = await requirePermission(safetyFor(token), "write", "resolve_feedback", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "resolve_feedback", `set feedback ${feedback_id} to ${status}`, input, {
					endpoint: `/v1/feedback/${feedback_id}`,
					method: "PATCH",
				});
			}
			const data = await authedCall(
				`/v1/feedback/${encodeURIComponent(feedback_id)}`,
				sessionToken,
				{ method: "PATCH", body: JSON.stringify({ status, ...(issue_url !== undefined ? { issue_url } : {}) }) },
				env,
			);
			// Only a SUCCESS is audited as completed — `apiCall` returns `{error}` rather than
			// throwing, so an unchecked audit here would record a filing that never happened (#325).
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "resolve_feedback", action: "completed", input, result: data });
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
