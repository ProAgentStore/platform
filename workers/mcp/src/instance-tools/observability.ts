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
 * point (`instance_messages` is how you check what you are about to destroy). The feedback
 * writers follow the same rule — `resolve_feedback`, `record_instance_feedback` and
 * `delete_feedback` sit beside `list_feedback`, which is how each is checked.
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
			limit: z.coerce.number().int().min(1).max(100).optional().describe("Messages per page (default 50, max 100). Page with `before` for older ones; the HTTP route allows 2000 for whole-conversation export, MCP stays smaller because the page is spent as model context."),
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
		"delete_instance_message",
		"Permanently delete the conversational turn containing one message from a subscribed instance. This can remove paired user/assistant messages and attached voice audio, but cannot unmix that turn from an existing conversation summary or extracted memory. Read instance_messages first, dry-run to check the id, then confirm. There is no undo.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			message_id: z.string().describe("A message id from instance_messages. The server deletes the whole turn containing it."),
			confirm: z.string().optional().describe('Must be "delete_instance_message" to permanently delete the turn.'),
			dry_run: z.boolean().optional().describe("Describe the deletion without doing it. Does not require confirm."),
		},
		async ({ token, instance_id, message_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, message_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_message", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/messages/${encodeURIComponent(message_id)}`;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_message", "permanently delete one conversation turn", input, {
					endpoint,
					method: "DELETE",
					effect: "The server would delete the full turn containing this message, including any attached voice audio. Existing summaries and extracted memory remain because they cannot be precisely un-mixed.",
					alternative: "Use instance_messages to inspect the turn first; there is no reversible single-turn hide operation.",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_message", confirm, "delete_instance_message", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "DELETE" }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "delete_instance_message", action: "completed", input, result: data });
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
			limit: z.coerce.number().int().min(1).max(500).optional(),
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
		"error_summary",
		"What is RECURRING in the platform error log, rather than what happened last — ask this before list_errors when the question is \"what is wrong with my account\". The write side folds an identical repeat into a counter, but only within a ONE-HOUR bucket, so a warning firing for three days is ~72 separate rows in the flat feed and reads as 72 fresh incidents. This groups them by normalized signature and returns one entry each with `count` (OCCURRENCES, not rows — a row standing for 60 collapsed repeats counts 60), `rows`, `firstSeen` and `lastSeen`. The span between those two is the thing worth acting on: a signature seen 200 times in ten minutes is an incident, and one seen 200 times over four days is something nobody is looking at, and both show the same big number. Always your own errors; the cross-account grouped view is an admin route.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			days: z.coerce.number().int().min(1).max(30).optional().describe("Window to group over. Default 7."),
			source: z.string().optional().describe("Filter by source, e.g. commit-close-watch | coding | keys-proxy."),
			level: z.enum(["error", "warn"]).optional().describe("`error` is a bug; `warn` is recorded but not counted as one. Unfiltered returns both."),
			instance_id: z.string().optional().describe("One agent's failures. The instance rides in the error's free-form context rather than a column, so this is a LOWER BOUND — a collapsed row keeps only two samples and cannot name every agent it covered."),
			limit: z.coerce.number().int().min(1).max(5000).optional().describe("Rows READ, not signatures returned — the width of the window being grouped. Default 2000."),
		},
		async ({ token, days, source, level, limit, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = new URLSearchParams();
			if (days) qs.set("days", String(days));
			if (source) qs.set("source", source);
			if (level) qs.set("level", level);
			if (instance_id) qs.set("instance_id", instance_id);
			if (limit) qs.set("limit", String(limit));
			const data = await authedCall(`/v1/errors/summary${qs.toString() ? `?${qs.toString()}` : ""}`, sessionToken, {}, env);
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
			limit: z.coerce.number().int().min(1).max(1000).optional().describe("How many of the most-recent events to READ BACK (default 200), shown oldest→newest. This selects the window of history, not the size of the reply: the window is then delivered in budgeted pages via `offset`, so raising it does not make one reply bigger."),
			// `z.coerce`, and it is load-bearing rather than defensive. Verified in production the
			// hour this shipped: a host whose cached tool list predates the argument has no type to
			// cast to, so it sends `offset: "63"` as a STRING, and a bare `z.number()` answers
			// `-32602 invalid_type`. That is the worst shape of the failure — page 1 arrives and
			// looks fixed while every page after it hard-errors, so paging LOOKS delivered and the
			// rest of the collection is unreachable. The tool-list cache is exactly what a version
			// bump does not flush on its own. Same remedy `workers/mcp/CLAUDE.md` already records
			// for object-shaped arguments ("models send JSON strings"), applied to the numeric case.
			offset: z.coerce.number().int().min(0).optional().describe("Skip this many events within the window. Pass `page.nextOffset` from the previous reply; omit for the first page."),
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
			limit: z.coerce.number().int().min(1).max(500).optional().describe("Most-recent rows to return (default 100)."),
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

	// ── Filing and deleting feedback (#613) ─────────────────────────────────────
	//
	// The console files a complaint and hard-deletes one; MCP could only read and triage. A caller
	// that watched an agent get something wrong had to send the owner to the console to record it.
	//
	// WHO WROTE IT. `agent_feedback.author` is `user` (the console button) or `agent` (the instance's
	// own `record_feedback`), and the row is valued as evidence of what the OWNER said. A caller here
	// is usually a model acting for the owner, so the tool sends `author: "user"` only under a
	// description that requires the owner's words, and stamps `context.via = "mcp"` on every row it
	// files — so a reader can always tell an MCP-filed complaint from one typed into the console.
	server.tool(
		"record_instance_feedback",
		"Record something the OWNER says one of their agents got wrong (or did well) — the same row the console's feedback button files, read back with list_feedback. `body` must be the owner's complaint in THEIR words (max 4000 chars), not your summary or diagnosis of it: the row is kept as evidence of what the owner said, and its body can never be edited afterwards. Anchor it when you can — `trace_id` (from agent_trace) or `message_id` (from instance_messages) point at the turn it is about, and `target_text` keeps a copy of the reply that outlives the transcript. Every row filed here is marked as filed over MCP. Not a memory (write_instance_memory) and not board work (create_instance_ticket).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("The agent instance the feedback is about, from my_instances."),
			body: z.string().describe("The owner's own words — what went wrong, or what worked."),
			sentiment: z.enum(["bad", "good"]).optional().describe('"bad" (a complaint) or "good". Omit when neither was stated.'),
			surface: z.enum(["chat", "coding", "board", "apply", "other"]).optional().describe('Where it happened. The server defaults to "chat".'),
			trace_id: z.string().optional().describe("The turn's trace id, from agent_trace."),
			message_id: z.string().optional().describe("The message it is about, from instance_messages."),
			session_id: z.string().optional().describe("The coding session it is about, from coding_sessions_list."),
			target_text: z.string().optional().describe("A copy of the reply or output being complained about (max 2000 chars)."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, body, sentiment, surface, trace_id, message_id, session_id, target_text, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, sentiment, surface, trace_id, message_id, session_id };
			const denied = await requirePermission(safetyFor(token), "write", "record_instance_feedback", input);
			if (denied) return denied;
			if (!body.trim()) return text("Error: body is required — the owner's words, not empty.");
			// Only what was supplied: the route defaults an absent `surface` and leaves an absent
			// pointer NULL, and a manufactured one would anchor the row to a turn nobody named.
			const payload: Record<string, unknown> = { instanceId: instance_id, body, author: "user", context: { via: "mcp" } };
			if (sentiment !== undefined) payload.sentiment = sentiment;
			if (surface !== undefined) payload.surface = surface;
			if (trace_id !== undefined) payload.traceId = trace_id;
			if (message_id !== undefined) payload.messageId = message_id;
			if (session_id !== undefined) payload.sessionId = session_id;
			if (target_text !== undefined) payload.targetText = target_text;
			if (dry_run) {
				return dryRun(safetyFor(token), "record_instance_feedback", "file owner feedback about an agent", input, {
					endpoint: "/v1/feedback",
					method: "POST",
					effect: `A feedback row about ${instance_id} would be filed as the owner's words, marked as filed over MCP. Its body cannot be edited afterwards.`,
					fields: Object.keys(payload).filter((k) => k !== "context"),
				});
			}
			const data = await authedCall("/v1/feedback", sessionToken, { method: "POST", body: JSON.stringify(payload) }, env);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(token), { tool: "record_instance_feedback", action: "completed", input, result: { id: (data as { feedback?: { id?: string } }).feedback?.id } });
			}
			return jsonText(data);
		},
	);

	server.tool(
		"delete_feedback",
		"Permanently delete one feedback row — the owner's \"delete my data\" path. Irreversible, and it removes evidence: to take a complaint off the open backlog without destroying it, use resolve_feedback with status \"dismissed\" instead. Dry-run it first to check the id against list_feedback, then pass confirm.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			feedback_id: z.string().describe("The row id from list_feedback."),
			confirm: z.string().optional().describe('Must be "delete_feedback" to delete the row.'),
			dry_run: z.boolean().optional().describe("Describe the deletion without doing it. Does not require confirm."),
		},
		async ({ token, feedback_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { feedback_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_feedback", input);
			if (denied) return denied;
			const endpoint = `/v1/feedback/${encodeURIComponent(feedback_id)}`;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_feedback", "permanently delete a feedback row", input, {
					endpoint,
					method: "DELETE",
					effect: `Feedback ${feedback_id} would be deleted. There is no undo, and the snapshot it holds outlives the transcript and trace — so this may be the only record of what was said.`,
					alternative: 'resolve_feedback with status "dismissed" keeps the row but takes it off the open backlog.',
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_feedback", confirm, "delete_feedback", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "DELETE" }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "delete_feedback", action: "completed", input, result: { ok: true } });
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
			limit: z.coerce.number().int().min(1).max(500).optional().describe("Most-recent runs to return (default 50)."),
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
