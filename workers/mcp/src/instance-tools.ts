import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, type McpEnv, jsonText, text } from "./http.js";
import {
	audit,
	dryRun,
	requireConfirmation,
	requirePermission,
	type SafetyContext,
} from "./safety.js";

type TokenResolver = (provided?: string) => string | null;
type SafetyResolver = (provided?: string) => SafetyContext;

interface InstanceSummary {
	id: string;
	agent_id: string;
	status: string;
	slug?: string;
	name?: string;
	description?: string;
	category?: string;
}

async function findInstanceForAgent(
	env: McpEnv,
	token: string,
	agentId: string,
): Promise<InstanceSummary | null> {
	const data = (await authedCall(
		"/v1/instances/my/instances",
		token,
		{},
		env,
	)) as { instances?: InstanceSummary[]; error?: string };
	if (data.error) return null;
	return (data.instances || []).find(
		(i) => i.agent_id === agentId || i.slug === agentId || i.id === agentId,
	) || null;
}

export function registerInstanceTools(
	server: McpServer,
	env: McpEnv,
	tokenFor: TokenResolver,
	safetyFor: SafetyResolver,
	/** The console-surface groups the connected user's subscribed agents expose —
	 *  agent-specific tools are gated to these so a user only sees tools for the
	 *  agents they actually have (e.g. a Repo Chat user never sees apply_to_job). */
	groups: Set<string>,
): void {
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
			if (!data.error) await audit(safetyFor(token), { tool: "chat_with_instance", action: "completed", input: { instance_id, messageBytes: new TextEncoder().encode(message).length } });
			return text(data.message?.content || data.error || "No response");
		},
	);

	server.tool(
		"register_instance_runtime",
		"Register a local or managed FAGS browser runtime for one of your private instances. Use this before run_instance_task for browser-capable agents.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			endpoint_url: z.string().describe("HTTPS tunnel URL for the FAGS runtime, or localhost URL for development."),
			runner_token: z.string().optional().describe("Bearer token configured on the FAGS runtime."),
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
			if (!data.error) await audit(safetyFor(token), { tool: "register_instance_runtime", action: "completed", input: { ...input, runner_token: runner_token ? "[provided]" : undefined }, result: data.runtime });
			return data.error
				? text(`Error: ${data.error}`)
				: text(`Runtime registered for ${instance_id}.\n${JSON.stringify(data.runtime, null, 2)}`);
		},
	);

	server.tool(
		"instance_runtime_status",
		"Check the registered local or managed FAGS runtime for one of your private instances.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			probe: z.boolean().optional().describe("When true, PAGS calls the FAGS runtime /health and /capabilities endpoints."),
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
		"Create a task on the registered local or managed FAGS runtime for a private instance. The PAGS brain stays in control; FAGS executes browser capabilities.",
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
				return dryRun(safetyFor(token), "run_instance_task", "create FAGS runtime task", toolInput, {
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

	// ── Apply-agent tools — only for users who have a job-application agent ──
	if (groups.has("apply")) {
	server.tool(
		"upload_resume",
		"Upload/replace the candidate's résumé for a private apply-agent instance (from a public URL or a base64 PDF), OR — with NO url/content_base64 — re-parse the résumé already on file. Either way it's parsed with the user's BYOK Claude to pre-fill their structured Profile + seed the knowledge base (PDF only); the result is reported via a notification.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("The apply-agent instance ID (from my_instances)."),
			url: z.string().url().optional().describe("Public URL to the résumé PDF to fetch and upload."),
			content_base64: z.string().optional().describe("The résumé PDF as base64 (alternative to url)."),
			filename: z.string().optional().describe("File name, default resume.pdf."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, url, content_base64, filename, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const name = (filename || "resume.pdf").replace(/[^\w.\- ]/g, "_").slice(0, 120);
			const input = { instance_id, source: content_base64 ? "base64" : url ? "url" : "none", filename: name };
			const denied = await requirePermission(safetyFor(token), "write", "upload_resume", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "upload_resume", "upload a résumé to the apply agent", input, {
					endpoint: `/v1/instances/${instance_id}/apply-resume?name=${encodeURIComponent(name)}`,
					method: "PUT",
				});
			}
			const MAX_RESUME = 8 * 1024 * 1024;
			let bytes: ArrayBuffer;
			if (content_base64) {
				let bin: string;
				try {
					bin = atob(content_base64.replace(/^data:[^,]*,/, ""));
				} catch {
					return text("Error: content_base64 is not valid base64.");
				}
				if (bin.length > MAX_RESUME) return text("Error: résumé too large (max 8MB).");
				const arr = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
				bytes = arr.buffer;
			} else if (url) {
				// Only http(s), and only accept an actual PDF back — a fetched HTML error page
				// must not get stored and labeled application/pdf.
				if (!/^https?:\/\//i.test(url)) return text("Error: url must be an http(s) URL.");
				const r = await fetch(url);
				if (!r.ok) return text(`Error fetching résumé from URL: HTTP ${r.status}`);
				const ct = r.headers.get("content-type") || "";
				if (ct && !/application\/pdf|application\/octet-stream|binary/i.test(ct)) return text(`Error: URL did not return a PDF (content-type: ${ct}).`);
				bytes = await r.arrayBuffer();
				if (bytes.byteLength > MAX_RESUME) return text("Error: résumé too large (max 8MB).");
			} else {
				// No source given → re-parse the résumé already on file.
				const res = (await authedCall(`/v1/instances/${instance_id}/apply-resume/parse`, sessionToken, { method: "POST" }, env)) as { error?: string };
				if (!res.error) await audit(safetyFor(token), { tool: "upload_resume", action: "completed", input: { ...input, mode: "reparse" } });
				return jsonText(res);
			}
			const res = (await authedCall(
				`/v1/instances/${instance_id}/apply-resume?name=${encodeURIComponent(name)}`,
				sessionToken,
				{ method: "PUT", headers: { "Content-Type": "application/pdf" }, body: bytes },
				env,
			)) as { error?: string };
			if (!res.error) await audit(safetyFor(token), { tool: "upload_resume", action: "completed", input });
			return jsonText(res);
		},
	);

	server.tool(
		"apply_to_job",
		"Launch the LLM-driven job application for a private apply-agent instance: the PAGS agent drives the user's local browser to fill (and, only if submit=true, SUBMIT) the application at the given job URL. The résumé comes from the instance's stored résumé and candidate details from the user's Profile. If the agent needs a value it can't truthfully invent (e.g. work authorization), it pauses with a needs_input ticket for the USER to answer in the console, then continues. Default is a safe test run that stops at the Submit button without clicking it.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("The apply-agent instance ID (from my_instances)."),
			url: z.string().describe("The job posting / application URL to apply to."),
			submit: z.boolean().optional().describe("false (default) = fill everything and stop at the Submit button WITHOUT clicking it (safe test). true = actually SUBMIT the application to the employer."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, url, submit, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const realSubmit = submit === true;
			const toolInput = { instance_id, url, submit: realSubmit };
			// A real submission is an outward, hard-to-undo action → destructive scope;
			// a test run (fill-only) is just runtime.
			const denied = await requirePermission(safetyFor(token), realSubmit ? "destructive" : "runtime", "apply_to_job", toolInput);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "apply_to_job", realSubmit ? "SUBMIT a job application to the employer" : "test-fill a job application (stops before submit)", toolInput, {
					endpoint: `/v1/instances/${instance_id}/apply`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/apply`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ url, dryRun: !realSubmit }) },
				env,
			);
			await audit(safetyFor(token), { tool: "apply_to_job", action: "completed", input: toolInput, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_profile",
		"Read the authenticated user's structured candidate Profile — name, contact, city/state/country, LinkedIn/website, work authorization, salary expectation, job preferences, and any custom answers the apply agent has saved from needs_input tickets. This is what the job-application agent fills forms from.",
		{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/profile", sessionToken, {}, env);
			return jsonText(data);
		},
	);
	} // ── end apply-agent tools ──

	server.tool(
		"approve_instance_task",
		"Approve a FAGS runtime task waiting for human approval.",
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
				return dryRun(safetyFor(token), "approve_instance_task", "approve FAGS runtime task", input, {
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
		"Cancel a task on the registered local or managed FAGS runtime for a private instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string(),
			confirm: z.string().optional().describe('Must be "cancel_instance_task" to cancel a FAGS runtime task.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, task_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, task_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "cancel_instance_task", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "cancel_instance_task", "cancel FAGS runtime task", input, {
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
		"Read recent events from a private instance's registered FAGS runtime.",
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
			// the flat items by column for a readable answer.
			const data = await authedCall(`/v1/instances/${instance_id}/board`, sessionToken, {}, env).catch(() => ({}));
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

	// ── Repo-chat tools — only for users who have a repo-chat agent ──
	if (groups.has("repo")) {
	server.tool(
		"ingest_repo",
		"Index a GitHub repository into a read-only repo-chat instance (the 'repo-chat' agent). Pulls the whole repo into the instance's vector store so you can ask how the code works. An instance can hold MANY repos — call again with a different URL to add another; call with the same URL to re-index that one. Public repos work as-is; private repos need GitHub connected.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			repo_url: z.string().describe("GitHub repo URL or owner/repo, e.g. https://github.com/sindresorhus/slugify"),
			branch: z.string().optional().describe("Optional branch (defaults to the repo's default branch)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, repo_url, branch, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_url, branch };
			const denied = await requirePermission(safetyFor(token), "write", "ingest_repo", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "ingest_repo", "index a GitHub repository into a repo-chat instance", input, {
					endpoint: `/v1/instances/${instance_id}/ingest-repo`,
					repo_url,
					branch,
				});
			}
			const data = (await authedCall(
				`/v1/instances/${instance_id}/ingest-repo`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ repoUrl: repo_url, branch }) },
				env,
			)) as { status?: string; repo?: string; error?: string };
			if (data.status) await audit(safetyFor(token), { tool: "ingest_repo", action: "completed", input: { instance_id, repo_url, branch }, result: { status: data.status } });
			return text(
				data.status
					? `Indexing started for ${data.repo || repo_url} (status: ${data.status}). Poll ingest_repo_status until it reads "done".`
					: `Error: ${data.error}`,
			);
		},
	);

	server.tool(
		"ingest_repo_status",
		"List the repositories indexed on a repo-chat instance and each one's progress (status: fetching | indexing | summarizing | done | error, with files indexed).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/ingest-repo/status`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"remove_repo",
		"Remove one indexed repository from a repo-chat instance (by repo_url or owner/repo), or all of them if neither is given. Deletes its vectors and overview.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			repo_url: z.string().optional().describe("Repo URL or owner/repo to remove. Omit to remove ALL repos."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, repo_url, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, repo_url };
			const denied = await requirePermission(safetyFor(token), "write", "remove_repo", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "remove_repo", repo_url ? "remove one indexed repository" : "remove ALL indexed repositories", input, {
					endpoint: `/v1/instances/${instance_id}/ingest-repo/clear`,
					repo_url: repo_url || "(all)",
				});
			}
			await authedCall(
				`/v1/instances/${instance_id}/ingest-repo/clear`,
				sessionToken,
				{ method: "POST", body: JSON.stringify(repo_url ? { repoUrl: repo_url } : {}) },
				env,
			);
			await audit(safetyFor(token), { tool: "remove_repo", action: "completed", input });
			return text(repo_url ? `Removed ${repo_url}.` : "Removed all repositories.");
		},
	);
	} // ── end repo-chat tools ──

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

	// Coding-only: hits /coding/diagnostics, so gate it to coding-surface agents (the same
	// endpoint coding_diagnostics gates). Otherwise a Repo-Chat/apply-only user sees a
	// coding tool that can't apply to their agent — the exact leak the registry closes.
	if (groups.has("coding")) {
		server.tool(
			"system_status",
			"Full diagnostics for a coding instance: runner connectivity, node name, tmux sessions, repos, issues. Use this to understand why sessions are offline or to check the runner's machine.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				instance_id: z.string().describe("Instance ID or slug"),
			},
			async ({ token, instance_id }) => {
				const sessionToken = tokenFor(token);
				if (!sessionToken) return authRequired();
				const inst = await findInstanceForAgent(env, sessionToken, instance_id);
				const id = inst?.id || instance_id;
				const data = await authedCall(
					`/v1/instances/${id}/coding/diagnostics`,
					sessionToken,
					{},
					env,
				);
				return jsonText(data);
			},
		);
	}

	// ── Agent Loop tools ──

	// Track active loops per instance (in-memory, lives for the MCP DO lifespan)
	const activeLoops = new Map<string, { objective: string; iteration: number; maxIterations: number; running: boolean }>();

	server.tool(
		"coding_loop_start",
		"Start an autonomous agent loop on an instance. Sends the objective as the first message, then iteratively asks the loop-decide endpoint to continue, stop, or escalate.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			objective: z.string().describe("What the agent should accomplish"),
			max_iterations: z.number().int().min(1).max(50).optional().describe("Maximum loop iterations (default 10)"),
		},
		async ({ token, instance_id, objective, max_iterations }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const inst = await findInstanceForAgent(env, sessionToken, instance_id);
			const id = inst?.id || instance_id;
			const maxIter = max_iterations ?? 10;
			// An autonomous loop drives chat + engine for up to 50 iterations —
			// runtime-scoped, gated by MCP_READ_ONLY, and audited (was ungated).
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_loop_start", { instance_id: id, max_iterations: maxIter });
			if (denied) return denied;
			await audit(safetyFor(token), { tool: "coding_loop_start", action: "completed", input: { instance_id: id, objectiveBytes: new TextEncoder().encode(objective).length, maxIterations: maxIter } });

			// Send the objective as the first message
			const chatRes = (await authedCall(
				`/v1/instances/${id}/chat`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ message: objective }) },
				env,
			)) as { message?: { content: string }; error?: string };
			if (chatRes.error) return text(`Error starting loop: ${chatRes.error}`);

			const state = { objective, iteration: 1, maxIterations: maxIter, running: true };
			activeLoops.set(id, state);

			// Run the loop
			const results: string[] = [`Iteration 0: sent objective\nAgent: ${chatRes.message?.content?.slice(0, 200) || "(no response)"}`];

			while (state.running && state.iteration < state.maxIterations) {
				const decision = (await authedCall(
					`/v1/instances/${id}/loop-decide`,
					sessionToken,
					{
						method: "POST",
						body: JSON.stringify({
							objective: state.objective,
							messages: [{ role: "user", content: objective }, { role: "assistant", content: chatRes.message?.content || "" }],
							iteration: state.iteration,
							maxIterations: state.maxIterations,
						}),
					},
					env,
				)) as { decision: string; nextInstruction?: string; reason?: string };

				if (decision.decision === "done") {
					results.push(`Done: ${decision.reason || "Objective met."}`);
					state.running = false;
					break;
				}
				if (decision.decision !== "continue" || !decision.nextInstruction) {
					results.push(`${decision.decision}: ${decision.reason || "Stopped."}`);
					state.running = false;
					break;
				}

				// Send the next instruction
				const nextRes = (await authedCall(
					`/v1/instances/${id}/chat`,
					sessionToken,
					{ method: "POST", body: JSON.stringify({ message: decision.nextInstruction }) },
					env,
				)) as { message?: { content: string }; error?: string };

				results.push(`Iteration ${state.iteration}: ${decision.nextInstruction.slice(0, 100)}\nAgent: ${nextRes.message?.content?.slice(0, 200) || nextRes.error || "(no response)"}`);
				state.iteration++;
			}

			activeLoops.delete(id);
			return text(results.join("\n\n---\n\n"));
		},
	);

	server.tool(
		"coding_loop_status",
		"Check the status of a running agent loop on an instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const inst = await findInstanceForAgent(env, sessionToken, instance_id);
			const id = inst?.id || instance_id;
			const state = activeLoops.get(id);
			if (!state) return text("No active loop for this instance.");
			return jsonText({ running: state.running, objective: state.objective, iteration: state.iteration, maxIterations: state.maxIterations });
		},
	);

	server.tool(
		"coding_loop_stop",
		"Stop a running agent loop on an instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const inst = await findInstanceForAgent(env, sessionToken, instance_id);
			const id = inst?.id || instance_id;
			const state = activeLoops.get(id);
			if (!state) return text("No active loop to stop.");
			state.running = false;
			activeLoops.delete(id);
			return text(`Loop stopped at iteration ${state.iteration}/${state.maxIterations}.`);
		},
	);
}

interface BoardColumn { id: string; title: string; statuses?: string[]; catchAll?: boolean }
interface BoardItem { jobKey: string; title: string; subtitle?: string; description?: string; status: string; runStatus?: string; userStatus?: string | null; url?: string; attempts?: unknown[]; latestTaskId?: string }

function columnFor(cols: BoardColumn[], status: string): string | null {
	for (const c of cols) if (c.statuses?.includes(status)) return c.id;
	const catchAll = cols.find((c) => c.catchAll);
	return catchAll ? catchAll.id : null;
}

/**
 * Group the API's flat board items (already ONE card per job, with effective
 * status + attempts + human overrides) into the agent's configured columns for a
 * readable answer. The API (lib/board.ts) owns the board shape; this just buckets.
 */
function groupBoard(data: unknown): unknown {
	const cols = (isRec(data) && Array.isArray(data.columns) ? data.columns : []) as BoardColumn[];
	const items = (isRec(data) && Array.isArray(data.items) ? data.items : []) as BoardItem[];
	const board: Record<string, unknown[]> = {};
	const other: unknown[] = [];
	for (const it of items) {
		const card = {
			jobKey: it.jobKey,
			label: it.subtitle ? `${it.title} (${it.subtitle})` : it.title,
			status: it.status,
			runStatus: it.runStatus,
			moved: it.userStatus ? true : undefined,
			attempts: Array.isArray(it.attempts) ? it.attempts.length : undefined,
			detail: it.description,
			url: it.url,
			latestTaskId: it.latestTaskId,
		};
		const colId = columnFor(cols, String(it.status ?? ""));
		if (!colId) { other.push(card); continue; }
		const title = cols.find((c) => c.id === colId)?.title ?? colId;
		(board[title] ||= []).push(card);
	}
	if (other.length) board.Other = other;
	return {
		columns: cols.map((c) => c.title),
		board,
		jobCount: items.length,
		note: "One card per job (retries of the same job collapse into one; `attempts` = run count). `moved:true` means a human set the status. Failed = the run couldn't finish; Blocked = the agent stopped needing you.",
	};
}

function isRec(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}
