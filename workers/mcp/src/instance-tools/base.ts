import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import { type InstanceToolsCtx, findInstanceForAgent, groupBoard, type InstanceSummary, isRec, normalizeTriggerConfig, triggerConfigSchema } from "./shared.js";

/** The always-on instance tools (connectors, lifecycle, chat, knowledge, triggers, board,
 *  settings, memory, translation, files, account) — surface-independent. */
export function registerBaseTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	// Connector/registry tools (issue #87): list + invoke over MCP so external clients
	// get the same connector capabilities (e.g. GitHub) as the agent runtime. One
	// definition in the API registry → surfaced here via a thin proxy.
	server.tool(
		"list_instance_tools",
		"Audit exactly what one of your instances may do. Returns EVERY registry tool with this instance's verdict: `allowed` (may it run), `scope` (read/write), `disabled` (you switched it off) and `reason` (ok | not_declared | disabled_by_owner), plus input schemas. Pass allowed_only:true for just the runnable set. Use this to verify an agent is read-only before trusting it with sensitive data — a tool absent from the allowed set cannot be invoked, by chat or by call_instance_tool.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			allowed_only: z.boolean().optional().describe("Return only the tools this instance may actually run."),
		},
		async ({ token, instance_id, allowed_only }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = allowed_only ? "?allowed=true" : "";
			const data = await authedCall(`/v1/instances/${instance_id}/tools${qs}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);
	server.tool(
		"set_instance_tool",
		"Switch one tool on or off for one of your instances — the owner's veto over what their own copy may do. A tool switched off is removed from the agent's chat AND refused by call_instance_tool, so this is a real capability change, not a UI preference. You can only toggle tools the agent declares; everything else is already refused.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			tool: z.string().describe("Tool name, e.g. repo_read_file (see list_instance_tools)."),
			enabled: z.boolean().describe("true to allow the tool, false to switch it off."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, tool, enabled, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// Gated as a write: this changes what an agent is permitted to do, so a read-only
			// MCP session must not be able to widen an agent's reach.
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_tool", { tool, enabled });
			if (denied) return denied;
			if (dry_run) return text(`Dry run: would set ${tool} to ${enabled ? "enabled" : "disabled"} on ${instance_id}.`);
			const data = await authedCall(
				`/v1/instances/${instance_id}/tools/${encodeURIComponent(tool)}`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ enabled }) },
				env,
			);
			await audit(safetyFor(token), { tool: "set_instance_tool", action: "completed", input: { instance_id, tool, enabled } });
			return jsonText(data);
		},
	);
	server.tool(
		"call_instance_tool",
		"Invoke a connector tool (e.g. github_workflow_runs, github_list_issues) on one of your instances. `input` is the tool's argument object — see list_instance_tools for schemas.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			tool: z.string().describe("Tool name, e.g. github_list_issues"),
			input: z.record(z.any()).optional().describe("The tool's input arguments object"),
		},
		async ({ token, instance_id, tool, input }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// Gated as a write: this is a generic invoker that will include write connector
			// tools later; MCP_READ_ONLY mode should block it. Reads still work via the agent.
			const denied = await requirePermission(safetyFor(token), "write", "call_instance_tool", { tool });
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${instance_id}/tools/${encodeURIComponent(tool)}`,
				sessionToken,
				{ method: "POST", body: JSON.stringify(input || {}) },
				env,
			);
			return jsonText(data);
		},
	);
	server.tool(
		"subscribe_agent",
		"Subscribe to a published agent and create your own private runnable instance. Use this before chat_with_instance for real user runs.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: z.string().describe("Published agent ID or slug"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, agent_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id };
			const denied = await requirePermission(safetyFor(token), "write", "subscribe_agent", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "subscribe_agent", "subscribe to published agent", input, {
					endpoint: `/v1/instances/${agent_id}/subscribe`,
					method: "POST",
				});
			}
			const data = (await authedCall(
				`/v1/instances/${agent_id}/subscribe`,
				sessionToken,
				{ method: "POST" },
				env,
			)) as { instanceId?: string; agentId?: string; status?: string; error?: string };
			if (data.instanceId) {
				await audit(safetyFor(token), { tool: "subscribe_agent", action: "completed", input, result: data });
				return text(
					`Subscribed.\nInstance: ${data.instanceId}\nAgent: ${data.agentId}\nStatus: ${data.status}`,
				);
			}
			if (data.error?.includes("Already subscribed")) {
				const existing = await findInstanceForAgent(env, sessionToken, agent_id);
				if (existing) {
					return text(
						`Already subscribed.\nInstance: ${existing.id}\nAgent: ${existing.agent_id}\nStatus: ${existing.status}`,
					);
				}
			}
			return text(`Error: ${data.error || "subscribe failed"}`);
		},
	);

	server.tool(
		"my_instances",
		"List your subscribed runnable agent instances. These are the correct targets for real agent chats.",
		{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = (await authedCall(
				"/v1/instances/my/instances",
				sessionToken,
				{},
				env,
			)) as { instances?: InstanceSummary[]; error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			const instances = data.instances || [];
			if (instances.length === 0) return text("No subscribed instances yet. Use subscribe_agent with a published agent first.");
			return jsonText(instances);
		},
	);

	server.tool(
		"chat_with_instance",
		"Chat with your private subscribed instance of an agent. This is the real runtime path with user-owned state and credentials.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from subscribe_agent or my_instances"),
			message: z.string(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, message, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, message };
			const denied = await requirePermission(safetyFor(token), "runtime", "chat_with_instance", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "chat_with_instance", "send private instance chat message", input, {
					endpoint: `/v1/instances/${instance_id}/chat`,
					method: "POST",
					messageBytes: new TextEncoder().encode(message).length,
				});
			}
			const data = (await authedCall(
				`/v1/instances/${instance_id}/chat`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ message }) },
				env,
			)) as {
				message?: { content?: string };
				error?: string;
			};
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "chat_with_instance", action: "completed", input: { instance_id, messageBytes: new TextEncoder().encode(message).length } });
			return text(data.message?.content || data.error || "No response");
		},
	);

	server.tool(
		"register_instance_runtime",
		"Register a local or managed ProAgentStore browser runtime for one of your private instances. Use this before run_instance_task for browser-capable agents.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			endpoint_url: z.string().describe("HTTPS tunnel URL for the browser runtime, or localhost URL for development."),
			runner_token: z.string().optional().describe("Bearer token configured on the browser runtime."),
			placement: z.enum(["local", "managed"]).optional(),
			capabilities: z.array(z.string()).optional(),
			runner_version: z.string().optional(),
			dry_run: z.boolean().optional(),
		},
		async ({
			token,
			instance_id,
			endpoint_url,
			runner_token,
			placement,
			capabilities,
			runner_version,
			dry_run,
		}) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = {
				instance_id,
				endpoint_url,
				runner_token,
				placement: placement || "local",
				capabilities: capabilities || [],
				runner_version: runner_version || "",
			};
			const denied = await requirePermission(safetyFor(token), "runtime", "register_instance_runtime", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "register_instance_runtime", "register instance runtime endpoint", input, {
					endpoint: `/v1/instances/${instance_id}/runtime`,
					method: "POST",
					body: { ...input, runner_token: runner_token ? "[provided]" : undefined },
				});
			}
			const data = (await authedCall(
				`/v1/instances/${instance_id}/runtime`,
				sessionToken,
				{
					method: "POST",
					body: JSON.stringify({
						endpointUrl: endpoint_url,
						token: runner_token,
						placement: placement || "local",
						capabilities: capabilities || [],
						runnerVersion: runner_version || "",
					}),
				},
				env,
			)) as { runtime?: unknown; error?: string };
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "register_instance_runtime", action: "completed", input: { ...input, runner_token: runner_token ? "[provided]" : undefined }, result: data.runtime });
			return data.error
				? text(`Error: ${data.error}`)
				: text(`Runtime registered for ${instance_id}.\n${JSON.stringify(data.runtime, null, 2)}`);
		},
	);

	server.tool(
		"instance_runtime_status",
		"Check the registered local or managed browser runtime for one of your private instances.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			probe: z.boolean().optional().describe("When true, PAGS calls the browser runtime /health and /capabilities endpoints."),
		},
		async ({ token, instance_id, probe }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const path = probe
				? `/v1/instances/${instance_id}/runtime/status`
				: `/v1/instances/${instance_id}/runtime`;
			const data = await authedCall(path, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"unregister_instance_runtime",
		"Remove the registered runtime endpoint for one of your private instances.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			confirm: z.string().optional().describe('Must be "unregister_instance_runtime" to remove a runtime endpoint.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "unregister_instance_runtime", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "unregister_instance_runtime", "remove instance runtime endpoint", input, {
					endpoint: `/v1/instances/${instance_id}/runtime`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "unregister_instance_runtime", confirm, "unregister_instance_runtime", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(
				`/v1/instances/${instance_id}/runtime`,
				sessionToken,
				{ method: "DELETE" },
				env,
			)) as { success?: boolean; error?: string };
			if (data.success) await audit(safetyFor(token), { tool: "unregister_instance_runtime", action: "completed", input });
			return text(data.success ? "Runtime unregistered." : `Error: ${data.error || "unregister failed"}`);
		},
	);

	server.tool(
		"run_instance_task",
		"Create a task on the registered local or managed browser runtime for a private instance. The PAGS brain stays in control; FAGS executes browser capabilities.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			type: z.string().describe("Runner task type, e.g. echo or browser.open."),
			input: z.record(z.unknown()).optional(),
			requires_approval: z.boolean().optional(),
			approval_prompt: z.string().optional(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, type, input, requires_approval, approval_prompt, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const toolInput = { instance_id, type, input: input || {}, requires_approval, approval_prompt };
			const denied = await requirePermission(safetyFor(token), "runtime", "run_instance_task", toolInput);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "run_instance_task", "create browser runtime task", toolInput, {
					endpoint: `/v1/instances/${instance_id}/tasks`,
					method: "POST",
					type,
					requiresApproval: requires_approval,
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks`,
				sessionToken,
				{
					method: "POST",
					body: JSON.stringify({
						type,
						input: input || {},
						requiresApproval: requires_approval,
						approvalPrompt: approval_prompt,
					}),
				},
				env,
			);
			await audit(safetyFor(token), { tool: "run_instance_task", action: "completed", input: toolInput, result: data });
			return jsonText(data);
		},
	);


	server.tool(
		"approve_instance_task",
		"Approve a browser runtime task waiting for human approval.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, task_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "runtime", "approve_instance_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "approve_instance_task", "approve browser runtime task", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/${task_id}/approve`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/approve`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			await audit(safetyFor(token), { tool: "approve_instance_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"cancel_instance_task",
		"Cancel a task on the registered local or managed browser runtime for a private instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string(),
			confirm: z.string().optional().describe('Must be "cancel_instance_task" to cancel a browser runtime task.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, task_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "cancel_instance_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "cancel_instance_task", "cancel browser runtime task", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/${task_id}/cancel`,
					method: "POST",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "cancel_instance_task", confirm, "cancel_instance_task", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			await audit(safetyFor(token), { tool: "cancel_instance_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"instance_task_events",
		"Read recent events from a private instance's registered browser runtime.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			limit: z.number().int().min(1).max(500).optional(),
		},
		async ({ token, instance_id, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/task-events?limit=${limit || 100}`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"instance_board",
		"Read a private instance's live kanban board — the agent's single work board. Cards are ONE per job (retries of the same job collapse into one card) grouped into the agent's configured columns (e.g. Waiting / Applying / Needs you / Failed / Blocked / Submitted). This is the same board shown in the console; use it to answer \"what's in <column>\" or \"why didn't <job> apply\".",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// The API (lib/board.ts) is the single source of the board shape — one card
			// per job, configured columns, human status overrides. Fetch it and group
			// the flat items by column for a readable answer. Surface a real failure
			// instead of returning an empty board (which reads as "no jobs").
			let data: unknown;
			try {
				data = await authedCall(`/v1/instances/${instance_id}/board`, sessionToken, {}, env);
			} catch (e) {
				return jsonText({ error: `board unavailable: ${e instanceof Error ? e.message : String(e)}` });
			}
			if (isRec(data) && data.error) return jsonText({ error: data.error });
			return jsonText(groupBoard(data));
		},
	);

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
		"add_instance_knowledge",
		"Add user-specific knowledge to your private subscribed instance. This does not alter the creator's template agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			title: z.string(),
			content: z.string(),
			source: z.string().optional(),
			source_url: z.string().optional(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, title, content, source, source_url, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, title, content, source, source_url };
			const denied = await requirePermission(safetyFor(token), "write", "add_instance_knowledge", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "add_instance_knowledge", "add private instance knowledge document", input, {
					endpoint: `/v1/instances/${instance_id}/knowledge`,
					title,
					source: source || "mcp",
					bytes: new TextEncoder().encode(content).length,
				});
			}
			const data = (await authedCall(
				`/v1/instances/${instance_id}/knowledge`,
				sessionToken,
				{
					method: "POST",
					body: JSON.stringify({
						title,
						content,
						source: source || "mcp",
						sourceUrl: source_url,
					}),
				},
				env,
			)) as { id?: string; error?: string };
			if (data.id) await audit(safetyFor(token), { tool: "add_instance_knowledge", action: "completed", input: { instance_id, title, source, source_url }, result: { id: data.id } });
			return text(data.id ? `Added to instance: ${title}` : `Error: ${data.error}`);
		},
	);


	server.tool(
		"list_instance_knowledge",
		"List user-specific knowledge documents in your private subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/knowledge`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"list_instance_files",
		"List files uploaded to a private subscribed instance (PDFs, documents — the console's Knowledge → Files tab). Shows name, size, mime type, and extraction status (extracted files are vectorized and searchable via search_instance_knowledge).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/files`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"search_instance_knowledge",
		"Semantic (vector) search across a private instance's knowledge base — résumé summary, uploaded docs, indexed repo code, etc. Returns the most relevant chunks by similarity. This validates what's actually retrievable from the instance's vector store.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			query: z.string().describe("Natural-language search query."),
			top_k: z.number().int().min(1).max(20).optional().describe("Number of results (default 5)."),
		},
		async ({ token, instance_id, query, top_k }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/search`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ query, top_k: top_k || 5 }) },
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"delete_instance_knowledge",
		"Delete a knowledge document from your private subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			document_id: z.string(),
			confirm: z.string().optional().describe('Must be "delete_instance_knowledge" to delete a knowledge document.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, document_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, document_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_knowledge", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_knowledge", "delete private instance knowledge document", input, {
					endpoint: `/v1/instances/${instance_id}/knowledge/${document_id}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_knowledge", confirm, "delete_instance_knowledge", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/knowledge/${document_id}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			await audit(safetyFor(token), { tool: "delete_instance_knowledge", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"cancel_instance",
		"Cancel your subscription and deactivate one private subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			confirm: z.string().optional().describe('Must be "cancel_instance" to cancel a private instance subscription.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "cancel_instance", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "cancel_instance", "cancel private instance subscription", input, {
					endpoint: `/v1/instances/${instance_id}/cancel`,
					method: "POST",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "cancel_instance", confirm, "cancel_instance", input);
			if (unconfirmed) return unconfirmed;
			const data = (await authedCall(
				`/v1/instances/${instance_id}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			)) as { success?: boolean; error?: string };
			if (data.success) await audit(safetyFor(token), { tool: "cancel_instance", action: "completed", input });
			return text(data.success ? "Canceled" : `Error: ${data.error}`);
		},
	);

	// ── Instance memory ────────────────────────────────────────────────────────

	server.tool(
		"get_instance_memory",
		"Read a subscribed instance's memory entries (identity, knowledge, preference, skill, context — the console's Knowledge → Memory tab).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/memory`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"write_instance_memory",
		"Create or update a memory entry on a subscribed instance. Read get_instance_memory first to reuse an existing key instead of creating a near-duplicate.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			key: z.string().describe("Memory key (reuse an existing key to update it)"),
			type: z.enum(["identity", "knowledge", "preference", "skill", "context"]),
			content: z.string(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, key, type, content, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, key, type };
			const denied = await requirePermission(safetyFor(token), "write", "write_instance_memory", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "write_instance_memory", "write instance memory entry", input, {
					endpoint: `/v1/instances/${instance_id}/memory`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/memory`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ key, type, content, source: "user" }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "write_instance_memory", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_instance_memory",
		"Delete one memory entry (by key) from a subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			key: z.string().describe("Memory key to delete"),
			confirm: z.string().optional().describe('Must be "delete_instance_memory" to delete a memory entry.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, key, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, key };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_memory", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_memory", "delete instance memory entry", input, {
					endpoint: `/v1/instances/${instance_id}/memory/${encodeURIComponent(key)}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_memory", confirm, "delete_instance_memory", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/memory/${encodeURIComponent(key)}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			await audit(safetyFor(token), { tool: "delete_instance_memory", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	// ── Instance settings / config ─────────────────────────────────────────────

	server.tool(
		"get_instance_settings",
		"Read a subscribed instance's typed agent settings (values + the agent's declared settings schema, e.g. Language Buddy's target language).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/settings`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_settings",
		"Update a subscribed instance's typed agent settings (patch — only sent fields change; a voiceLanguage field also syncs the voice STT/TTS language).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			settings: z.record(z.unknown()).describe("Field id → new value, per the agent's settings schema"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, settings, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, fields: Object.keys(settings) };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_settings", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_settings", "update instance agent settings", input, {
					endpoint: `/v1/instances/${instance_id}/settings`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/settings`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ settings }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_settings", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_instance_triggers",
		"List webhook, cron, and connector-sync triggers configured on a subscribed private instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_instance_triggers", { instance_id });
			if (denied) return denied;
			const data = await authedCall(
				`/v1/triggers?instanceId=${encodeURIComponent(instance_id)}`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"create_instance_trigger",
		"Create a webhook, cron, or connector-sync trigger on a subscribed private instance. Use sync_connector with config.provider and config.grant_id for Google Drive or Zoho WorkDrive folder syncs.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			name: z.string().describe("Human-readable trigger name."),
			type: z.enum(["webhook", "cron"]).describe("Webhook exposes a capability URL; cron runs on a schedule."),
			action: z.enum(["create_task", "add_knowledge", "log_event", "sync_connector", "run_pipeline", "insert_record", "run_browse"]),
			schedule: z.string().optional().describe("Required for cron. Examples: @daily, @hourly, every 15 minutes, 0 8 * * *"),
			config: triggerConfigSchema,
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, name, type, action, schedule, config, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const body = {
				instanceId: instance_id,
				name,
				type,
				action,
				schedule,
				config: normalizeTriggerConfig(config),
			};
			const input = { instance_id, name, type, action, schedule, config: body.config };
			const denied = await requirePermission(safetyFor(token), "write", "create_instance_trigger", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "create_instance_trigger", "create instance trigger", input, {
					endpoint: "/v1/triggers",
					method: "POST",
					body,
				});
			}
			const data = await authedCall(
				"/v1/triggers",
				sessionToken,
				{ method: "POST", body: JSON.stringify(body) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_instance_trigger", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"run_instance_trigger",
		"Manually run one configured instance trigger now. This can create tasks, add knowledge, or sync a granted connector folder.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			trigger_id: z.string(),
			payload: z.record(z.unknown()).optional().describe("Optional payload for create_task/add_knowledge/log_event webhook-style triggers."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, trigger_id, payload, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { trigger_id, payloadKeys: Object.keys(payload || {}) };
			const denied = await requirePermission(safetyFor(token), "runtime", "run_instance_trigger", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "run_instance_trigger", "run instance trigger now", input, {
					endpoint: `/v1/triggers/${trigger_id}/run`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/triggers/${trigger_id}/run`,
				sessionToken,
				{ method: "POST", body: JSON.stringify(payload || { manual: true }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "run_instance_trigger", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_instance_trigger_events",
		"Read recent event history for one configured instance trigger, including received/running/succeeded/failed entries.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			trigger_id: z.string(),
			limit: z.number().int().min(1).max(200).optional(),
		},
		async ({ token, trigger_id, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_instance_trigger_events", { trigger_id, limit });
			if (denied) return denied;
			const qs = limit ? `?limit=${limit}` : "";
			const data = await authedCall(`/v1/triggers/${trigger_id}/events${qs}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"delete_instance_trigger",
		"Delete a configured instance trigger. This removes its event history and connector sync ledger.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			trigger_id: z.string(),
			confirm: z.string().optional().describe('Must be "delete_instance_trigger" to delete a trigger.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, trigger_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { trigger_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_trigger", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_trigger", "delete instance trigger", input, {
					endpoint: `/v1/triggers/${trigger_id}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_trigger", confirm, "delete_instance_trigger", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/triggers/${trigger_id}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			await audit(safetyFor(token), { tool: "delete_instance_trigger", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"rename_instance",
		"Set (or clear) a subscribed instance's display name — how it appears in the console when you run several instances of the same agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			name: z.string().optional().describe("New display name (max 60 chars). Omit or empty to reset to the agent's name."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, name, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, name: name ?? "" };
			const denied = await requirePermission(safetyFor(token), "write", "rename_instance", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "rename_instance", "rename instance", input, {
					endpoint: `/v1/instances/${instance_id}/name`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/name`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ name: name ?? "" }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "rename_instance", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_instructions",
		"Read a subscribed instance's Special Instructions (the subscriber's free-text rules injected at the top of the agent's prompt — console Knowledge → Rules & Tips).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/instructions`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_instructions",
		"Replace a subscribed instance's Special Instructions (max 4000 chars; these override the agent's defaults).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			instructions: z.string().describe("The full new rules text (replaces the old text; empty string clears)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, instructions, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, bytes: instructions.length };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_instructions", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_instructions", "replace instance special instructions", input, {
					endpoint: `/v1/instances/${instance_id}/instructions`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/instructions`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ instructions }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_instructions", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_model",
		"Change a subscribed instance's chat model — the programmatic path to move an instance off a model stuck from a pre-fix subscribe (#151). An instance copies its model at subscribe and never re-reads the template, so a pre-fix instance can be frozen on a non-tool-capable model (it then confabulates instead of querying its collections). Recommended tool-capable Cloudflare models: @cf/meta/llama-4-scout-17b-16e-instruct (default), @cf/meta/llama-3.3-70b-instruct-fp8-fast, @cf/mistralai/mistral-small-3.1-24b-instruct, @cf/qwen/qwen2.5-coder-32b-instruct. BYOK Anthropic (e.g. claude-sonnet-4-6) is tool-capable and used when the owner has an Anthropic key.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			model: z.string().describe('The model id to set, e.g. "@cf/meta/llama-4-scout-17b-16e-instruct" or "claude-sonnet-4-6".'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, model, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const m = String(model || "").trim();
			if (!m) return jsonText({ error: "A non-empty `model` id is required." });
			const input = { instance_id, model: m };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_model", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_model", `set instance model to ${m}`, input, {
					endpoint: `/v1/instances/${instance_id}/state`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/state`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ model: m }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_model", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_translation_config",
		"Read a subscribed instance's translation display config (translation under messages, transliteration/pinyin, word-tap pronunciation, font size).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/translation`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_translation_config",
		"Update a subscribed instance's translation display config. Only sent fields change.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			enabled: z.boolean().optional().describe("Show a translation under every message"),
			target: z.string().optional().describe("Translation target language name (e.g. English)"),
			transliterate: z.boolean().optional().describe("Word-by-word interlinear transliteration (e.g. pinyin for Chinese)"),
			word_tap: z.boolean().optional().describe("Tap a word to hear it pronounced"),
			font_size: z.string().optional().describe("Interlinear text size: small | medium | large"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, enabled, target, transliterate, word_tap, font_size, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const patch: Record<string, unknown> = {};
			if (enabled !== undefined) patch.enabled = enabled;
			if (target !== undefined) patch.target = target;
			if (transliterate !== undefined) patch.transliterate = transliterate;
			if (word_tap !== undefined) patch.wordTap = word_tap;
			if (font_size !== undefined) patch.fontSize = font_size;
			const input = { instance_id, ...patch };
			const denied = await requirePermission(safetyFor(token), "write", "set_translation_config", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_translation_config", "update instance translation config", input, {
					endpoint: `/v1/instances/${instance_id}/translation`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/translation`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify(patch) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_translation_config", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_state",
		"Read a subscribed instance's DO state (identity, guardrails, permissions). Read-only — permission toggles stay in the console.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/state`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"vector_stats",
		"What's in a subscribed instance's vector store, grouped by source (files, KB docs, repo files, conversation summaries) with chunk counts — the console's Knowledge → Index panel. Use search_instance_knowledge to test retrieval.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/vectors`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	// ── Instance activity / files / messages ───────────────────────────────────

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
		"delete_instance_file",
		"Delete an uploaded file from a subscribed instance (Knowledge → Files). Removes the R2 object, its metadata, and its vectors.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			file_id: z.string(),
			confirm: z.string().optional().describe('Must be "delete_instance_file" to delete a file.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, file_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, file_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_file", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_file", "delete instance file", input, {
					endpoint: `/v1/instances/${instance_id}/files/${encodeURIComponent(file_id)}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_file", confirm, "delete_instance_file", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/files/${encodeURIComponent(file_id)}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			await audit(safetyFor(token), { tool: "delete_instance_file", action: "completed", input, result: data });
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

	// ── Board + tasks ──────────────────────────────────────────────────────────

	server.tool(
		"set_board_item_status",
		"Move a board card to a different column (or reset it to automation by omitting status). Get valid statuses from instance_board / get_agent_board_config.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			job_key: z.string().describe("The card's jobKey from instance_board"),
			status: z.string().optional().describe("Target column/status id. Omit or empty to hand the card back to automation."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, job_key, status, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, job_key, status: status ?? "" };
			const denied = await requirePermission(safetyFor(token), "write", "set_board_item_status", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_board_item_status", "move board card", input, {
					endpoint: `/v1/instances/${instance_id}/board/status`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/board/status`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ jobKey: job_key, status: status ?? "" }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_board_item_status", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_board_config",
		"Read a private instance's board configuration: its columns, the preferred view (kanban | list), whether the columns are a per-instance override or the agent's own, and the agent's default columns. Pair with set_instance_board_config to customize the board.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/board-config`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_board_config",
		"Customize a private instance's board: replace its columns and/or set the default view (kanban | list). Columns are ordered; each card lands in the first column whose `statuses` include its status, else the column marked `catchAll`. Pass columns:[] (or omit and set view only) to keep columns; the console UI, MCP, and the agent itself all write through here. This is a per-instance override — it does not change the agent template.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			columns: z
				.array(
					z.object({
						id: z.string().describe("Stable column id (also a movable status target)."),
						title: z.string().describe("Column header shown to the user."),
						color: z.string().optional().describe("Hex dot color, e.g. #22c55e."),
						statuses: z.array(z.string()).optional().describe("Task statuses that live in this column."),
						catchAll: z.boolean().optional().describe("Set on ONE column to hold any unmatched status."),
					}),
				)
				.optional()
				.describe("Full ordered column list (replaces the current override). Empty array or null resets to the agent's columns."),
			view: z.enum(["kanban", "list"]).optional().describe("Default view for the console board."),
			reset: z.boolean().optional().describe("Set true to drop the per-instance column override (fall back to the agent's columns)."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, columns, view, reset, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const payload: Record<string, unknown> = {};
			if (reset) payload.columns = null;
			else if (columns !== undefined) payload.columns = columns;
			if (view) payload.view = view;
			const input = { instance_id, columns: reset ? null : columns, view };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_board_config", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_board_config", "customize instance board", input, {
					endpoint: `/v1/instances/${instance_id}/board-config`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/board-config`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify(payload) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_board_config", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"hint_instance_task",
		"Attach a hint to a runtime task (guidance the agent reads on its next step, e.g. answering a blocked task's question).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string(),
			hint: z.string().describe("The guidance text (max 2000 chars)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, task_id, hint, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "write", "hint_instance_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "hint_instance_task", "attach hint to runtime task", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/${task_id}/hint`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/hint`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ hint }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "hint_instance_task", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"clear_finished_tasks",
		"Clear all finished (done/failed/cancelled) runtime tasks from a subscribed instance's board.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "write", "clear_finished_tasks", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "clear_finished_tasks", "clear finished runtime tasks", input, {
					endpoint: `/v1/instances/${instance_id}/tasks/clear-finished`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/clear-finished`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({}) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "clear_finished_tasks", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	// ── Creator: agent settings schema ─────────────────────────────────────────

	server.tool(
		"get_agent_settings_schema",
		"Read an agent's declared typed settings schema (creator view — the fields subscribers see in Settings → Agent settings).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: z.string(),
		},
		async ({ token, agent_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/agents/${agent_id}/settings-schema`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_agent_settings_schema",
		"Replace an agent's typed settings schema (owner only). Fields: {id, label, type: select|text|number|toggle, options?, default?, description?, voiceLanguage?, prompt?}. Max 12 fields.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: z.string(),
			settings_schema: z.array(z.record(z.unknown())).describe("The full schema array (replaces the old one; [] clears)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, agent_id, settings_schema, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id, fields: settings_schema.length };
			const denied = await requirePermission(safetyFor(token), "write", "set_agent_settings_schema", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_agent_settings_schema", "replace agent settings schema", input, {
					endpoint: `/v1/agents/${agent_id}/settings-schema`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/agents/${agent_id}/settings-schema`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ settingsSchema: settings_schema }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_agent_settings_schema", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	// ── Account-level reads ────────────────────────────────────────────────────

	server.tool(
		"billing_status",
		"Read your billing/plan status (free vs Pro, whether the paywall is enforced, whether a billing account exists). Upgrades happen in the console (browser redirect).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/billing/status", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"usage_summary",
		"Token usage + ESTIMATED cost across all your agents, broken down by agent, model, and activity (chat/apply/coding/voice/…), over a time range. Cost is a BYOK estimate from list prices, not a bill; history starts when tracking was enabled.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			range: z.enum(["7d", "30d", "90d", "all"]).optional().describe("Time window (default 30d)."),
		},
		async ({ token, range }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const q = range ? `?range=${encodeURIComponent(range)}` : "";
			const data = await authedCall(`/v1/usage${q}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"keys_status",
		"Which AI providers have a BYOK key stored for your account (names only — values are never exposed). Useful when chat says BYOK is required.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/keys/status", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"email_status",
		"Gmail connection status for the email-access tool (configured? connected?). Connect/disconnect happens in the console.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/email/status", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"update_profile",
		"Update your structured candidate Profile / Job Preferences (string fields only; used by the apply pipeline). Read get_profile first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			fields: z.record(z.string()).describe("Field name → value (e.g. full_name, phone, city; empty string clears a field)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, fields, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { fields: Object.keys(fields) };
			const denied = await requirePermission(safetyFor(token), "write", "update_profile", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "update_profile", "update candidate profile fields", input, {
					endpoint: "/v1/profile",
					method: "PUT",
				});
			}
			const data = await authedCall(
				"/v1/profile",
				sessionToken,
				{ method: "PUT", body: JSON.stringify(fields) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "update_profile", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	// ── Supervision (#183) + the pump (#182): wiring agents together ──────────────
	// These existed only as HTTP routes, which meant assembling a multi-agent system —
	// the whole point of the supervision work — required curl or a SQL migration. An
	// agent platform whose composition step is not self-serve is not a platform.

	server.tool(
		"list_supervision",
		"List the agents a supervisor instance oversees (its direct reports). Supervision is how one agent delegates goals to others.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string(),
		},
		async ({ token, supervisor_instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_supervision", { supervisor_instance_id });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision`, sessionToken, {}, env));
		},
	);

	server.tool(
		"create_supervision",
		"Put one agent in charge of another: the supervisor may then delegate goals to the subordinate. Rejected if it would create a supervision loop, exceed the depth or fan-out limits, or give the subordinate a second supervisor.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string().describe("The instance that will delegate."),
			subordinate_instance_id: z.string().describe("The instance that will receive goals."),
		},
		async ({ token, supervisor_instance_id, subordinate_instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { supervisor_instance_id, subordinate_instance_id };
			const denied = await requirePermission(safetyFor(token), "write", "create_supervision", input);
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ subordinateInstanceId: subordinate_instance_id }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_supervision", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_supervision",
		"Remove a supervision link so the supervisor can no longer delegate to that agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			supervisor_instance_id: z.string(),
			supervision_id: z.string().describe("Link id from list_supervision."),
		},
		async ({ token, supervisor_instance_id, supervision_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { supervisor_instance_id, supervision_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_supervision", input);
			if (denied) return denied;
			return jsonText(await authedCall(
				`/v1/instances/${encodeURIComponent(supervisor_instance_id)}/supervision/${encodeURIComponent(supervision_id)}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			));
		},
	);

	server.tool(
		"list_connections",
		"List the agent-to-agent event connections leaving an instance — how a fact it emits (e.g. lead.created) is routed to another agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "list_connections", { instance_id });
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/connections`, sessionToken, {}, env));
		},
	);

	server.tool(
		"create_connection",
		"Route an event one agent emits to another agent — the 'pump'. Choreography, not supervision: the source announces a FACT and does not know who consumes it. Use supervision instead when one agent must direct another and own the result.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Source instance — the one that emits the event."),
			event_type: z.string().describe("The emitted fact, e.g. lead.created or site.live."),
			target_instance_id: z.string().describe("Instance that receives the payload."),
			action: z.string().describe("What the target does: run_pipeline | insert_record | create_task | add_knowledge."),
			config: z.record(z.unknown()).optional().describe("Action config (pipeline name, collection, filter, params)."),
		},
		async ({ token, instance_id, event_type, target_instance_id, action, config }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, event_type, target_instance_id, action };
			const denied = await requirePermission(safetyFor(token), "write", "create_connection", input);
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/connections`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ eventType: event_type, targetInstanceId: target_instance_id, action, config: config ?? {} }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_connection", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"start_instance_loop",
		"Give an agent an objective and let it work autonomously on the server. Durable: it survives you closing the browser, and its spend is bounded by a budget. Returns a run id — poll it with check_instance_loop.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			objective: z.string().describe("The outcome you want, in plain language."),
			max_iterations: z.number().optional().describe("Cap on steps (default 10, max 50)."),
		},
		async ({ token, instance_id, objective, max_iterations }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, objective, max_iterations };
			const denied = await requirePermission(safetyFor(token), "write", "start_instance_loop", input);
			if (denied) return denied;
			const data = await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/loop`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ objective, maxIterations: max_iterations }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "start_instance_loop", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"check_instance_loop",
		"Check an autonomous run: status, how many steps it has taken, and why it stopped. Omit run_id to list recent runs for the instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			run_id: z.string().optional(),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "check_instance_loop", { instance_id, run_id });
			if (denied) return denied;
			const path = run_id
				? `/v1/instances/${encodeURIComponent(instance_id)}/loop/${encodeURIComponent(run_id)}`
				: `/v1/instances/${encodeURIComponent(instance_id)}/loop`;
			return jsonText(await authedCall(path, sessionToken, {}, env));
		},
	);

	server.tool(
		"stop_instance_loop",
		"Ask an autonomous run to stop. Cooperative: the step in flight finishes and settles its spend rather than being killed mid-way.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			run_id: z.string(),
		},
		async ({ token, instance_id, run_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "stop_instance_loop", { instance_id, run_id });
			if (denied) return denied;
			return jsonText(await authedCall(
				`/v1/instances/${encodeURIComponent(instance_id)}/loop/${encodeURIComponent(run_id)}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			));
		},
	);
}
