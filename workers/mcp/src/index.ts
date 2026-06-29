import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { apiCall, authedCall, authRequired, type McpEnv, jsonText, text } from "./http.js";
import { registerInstanceTools } from "./instance-tools.js";
import { registerStorageTools } from "./storage-tools.js";
import { loginHandler } from "./oauth-provider.js";
import {
	AGENT_ID,
	agentTemplateFiles,
	createRepo,
	deployStatus,
	getRepoFile,
	listRepoFiles,
	ownsAgent,
	putRepoFile,
	repoNameFor,
	triggerDeploy,
	type AgentSummary,
} from "./repo-tools.js";
import {
	audit,
	dryRun,
	listAuditEvents,
	MCP_SCOPES,
	type SafetyContext,
	requireConfirmation,
	requirePermission,
} from "./safety.js";

type Props = {
	authToken?: string;
	mcpScopes?: string[] | null;
	mcpSubject?: string;
};
type Env = McpEnv;

export class PagsMcp extends McpAgent<Env, unknown, Props> {
	server = new McpServer({ name: "ProAgentStore", version: "0.1.0" });
	private userToken: string | null = null;
	private scopes: string[] | null = null;
	private subject: string | undefined;
	private toolsRegistered = false;

	private token(provided?: string): string | null {
		return provided || this.userToken;
	}

	private safety(provided?: string): SafetyContext {
		return {
			env: this.env,
			subject: provided ? undefined : this.subject,
			scopes: provided ? null : this.scopes,
		};
	}

	async init() {
		// Refresh per-request auth from props on every start.
		this.userToken = this.props?.authToken || null;
		this.scopes = this.props?.mcpScopes || null;
		this.subject = this.props?.mcpSubject;

		// McpAgent.onStart() calls init() on every DO start, but `this.server`
		// persists for the life of the instance. Registering tools twice on the
		// same server throws "Tool ... is already registered", which cancels the
		// MCP stream and makes clients hang until they time out. Register once.
		if (this.toolsRegistered) return;
		this.toolsRegistered = true;

		this.server.tool(
			"list_agents",
			"List all published agents on ProAgentStore",
			{},
			async () => {
				const data = (await apiCall("/v1/agents", {}, this.env)) as { agents: unknown[] };
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(data.agents, null, 2),
						},
					],
				};
			},
		);

		this.server.tool(
			"agent_info",
			"Get detailed info about an agent",
			{ agent_id: z.string().describe("Agent ID or slug") },
			async ({ agent_id }) => {
				const data = await apiCall(`/v1/public/agents/${agent_id}`, {}, this.env);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(data, null, 2) },
					],
				};
			},
		);

		this.server.tool(
			"chat_with_agent",
			"Send a message to a published agent (trial mode)",
			{
				agent_id: z.string(),
				message: z.string(),
				session_id: z.string().optional(),
			},
			async ({ agent_id, message, session_id }) => {
				const data = (await apiCall(`/v1/public/agents/${agent_id}/try`, {
					method: "POST",
					body: JSON.stringify({ message, sessionId: session_id }),
				}, this.env)) as {
					message?: { content: string };
					sessionId?: string;
					error?: string;
				};
				return {
					content: [
						{
							type: "text" as const,
							text: `${data.message?.content || data.error || "No response"}\n\nSession: ${data.sessionId || "none"}`,
						},
					],
				};
			},
		);

		this.server.tool(
			"my_agents",
			"List agents owned by the authenticated ProAgentStore creator.",
			{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
			async ({ token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const data = (await authedCall(
					"/v1/agents/my/agents",
					sessionToken,
					{},
					this.env,
				)) as { agents?: AgentSummary[]; error?: string };
				if (data.error) return text(`Error: ${data.error}`);
				const agents = data.agents || [];
				if (agents.length === 0) return text("No owned agents yet.");
				return jsonText(agents);
			},
		);

		this.server.tool(
			"mcp_audit_log",
			"Read recent MCP write, runtime, dry-run, denied, and destructive tool audit events for the authenticated account.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				limit: z.number().int().min(1).max(200).optional(),
			},
			async ({ token, limit }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const denied = await requirePermission(this.safety(token), "read", "mcp_audit_log", { limit });
				if (denied) return denied;
				return jsonText(await listAuditEvents(this.safety(token), limit || 50));
			},
		);

		this.server.tool(
			"get_agent_board_config",
			"Read the authenticated creator's configurable console kanban board for agents.",
			{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
			async ({ token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const data = (await authedCall(
					"/v1/auth/me",
					sessionToken,
					{},
					this.env,
				)) as { boardConfig?: unknown; error?: string };
				if (data.error) return text(`Error: ${data.error}`);
				return jsonText(data.boardConfig || null);
			},
		);

		this.server.tool(
			"update_agent_board_config",
			"Update the authenticated creator's console kanban board. Columns match agent statuses and visibilities in order.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				config: z.object({
					summary: z.string().optional(),
					columns: z.array(z.object({
						id: z.string(),
						title: z.string(),
						color: z.string().optional(),
						empty: z.string().optional(),
						statuses: z.array(z.string()).optional(),
						visibilities: z.array(z.string()).optional(),
						excludeStatuses: z.array(z.string()).optional(),
						excludeVisibilities: z.array(z.string()).optional(),
						catchAll: z.boolean().optional(),
					})).min(1).max(8),
				}),
				dry_run: z.boolean().optional(),
			},
			async ({ token, config, dry_run }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const denied = await requirePermission(this.safety(token), "write", "update_agent_board_config", { config });
				if (denied) return denied;
				if (dry_run) {
					return dryRun(this.safety(token), "update_agent_board_config", "update board config", { config }, { board_config: config });
				}
				const data = (await authedCall(
					"/v1/auth/me",
					sessionToken,
					{ method: "PUT", body: JSON.stringify({ board_config: config }) },
					this.env,
				)) as { success?: boolean; error?: string };
				if (data.success) await audit(this.safety(token), { tool: "update_agent_board_config", action: "completed", input: { config } });
				return data.success
					? text("Updated agent board config.")
					: text(`Error: ${data.error || "update failed"}`);
			},
		);

		registerInstanceTools(
			this.server,
			this.env,
			(provided) => this.token(provided),
			(provided) => this.safety(provided),
		);

		registerStorageTools(
			this.server,
			this.env,
			(provided) => this.token(provided),
			(provided) => this.safety(provided),
		);

		this.server.tool(
			"create_agent",
			"Create a new agent on ProAgentStore",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				slug: AGENT_ID,
				name: z.string(),
				description: z.string().optional(),
				category: z.string().optional(),
				model: z.string().optional(),
				personality: z.string().optional(),
				goal: z.string().optional(),
				dry_run: z.boolean().optional(),
			},
			async ({
				token,
				slug,
				name,
				description,
				category,
				model,
				personality,
				goal,
				dry_run,
			}) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const input = { slug, name, description, category, model, personality, goal };
				const denied = await requirePermission(this.safety(token), "write", "create_agent", input);
				if (denied) return denied;
				if (dry_run) {
					return dryRun(this.safety(token), "create_agent", "create agent", input, {
						endpoint: "/v1/agents",
						method: "POST",
						body: input,
					});
				}
				const data = (await authedCall("/v1/agents", sessionToken, {
					method: "POST",
					body: JSON.stringify({
						slug,
						name,
						description,
						category,
						model,
						personality,
						goal,
					}),
				}, this.env)) as { id?: string; error?: string };
				if (data.id) await audit(this.safety(token), { tool: "create_agent", action: "completed", input, result: { id: data.id } });
				return {
					content: [
						{
							type: "text" as const,
							text: data.id
								? `Created: ${data.id}\nhttps://proagentstore.online/agents/${slug}/`
								: `Error: ${data.error}`,
						},
					],
				};
			},
		);

		this.server.tool(
			"scaffold_agent",
			"Create a ProAgentStore agent and scaffold its GitHub repo from a starter template. Requires PAGS token plus GITHUB_TOKEN configured on the MCP worker.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				slug: AGENT_ID,
				name: z.string(),
				description: z.string(),
				category: z.string().optional(),
				model: z.string().optional(),
				template: z.enum(["worker", "cron", "api"]).optional(),
				personality: z.string().optional(),
				goal: z.string().optional(),
				auto_deploy: z.boolean().optional().describe("Trigger the deploy workflow after scaffolding. Defaults to true."),
				dry_run: z.boolean().optional(),
			},
			async ({
				token,
				slug,
				name,
				description,
				category,
				model,
				template,
				personality,
				goal,
				auto_deploy,
				dry_run,
			}) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const repo = repoNameFor(slug);
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				const selectedTemplate = template || "worker";
				const selectedModel = model || "@cf/meta/llama-3.2-3b-instruct";
				const input = {
					slug,
					name,
					description,
					category,
					model: selectedModel,
					template: selectedTemplate,
					personality,
					goal,
					auto_deploy: auto_deploy !== false,
				};
				const denied = await requirePermission(this.safety(token), "write", "scaffold_agent", input);
				if (denied) return denied;
				if (dry_run) {
					const files = Array.from(agentTemplateFiles({
						slug,
						name,
						description,
						category: category || "general",
						model: selectedModel,
						template: selectedTemplate,
					}).keys());
					return dryRun(this.safety(token), "scaffold_agent", "create agent and scaffold repository", input, {
						agent: { slug, name, description, category, model: selectedModel },
						repo: `https://github.com/${org}/${repo}`,
						files,
						autoDeploy: auto_deploy !== false,
					});
				}
				const created = (await authedCall("/v1/agents", sessionToken, {
					method: "POST",
					body: JSON.stringify({
						slug,
						name,
						description,
						category,
						model: selectedModel,
						personality,
						goal,
					}),
				}, this.env)) as { id?: string; error?: string };
				if (!created.id) return text(`Agent create failed: ${created.error || "unknown error"}`);

				const steps: string[] = [`+ Agent registered: ${created.id}`];
				steps.push(await createRepo(this.env, org, repo, description));
				if (!this.env.GITHUB_TOKEN) {
					steps.push("! Repo scaffold skipped: GITHUB_TOKEN is not configured");
				} else {
					const files = agentTemplateFiles({
						slug,
						name,
						description,
						category: category || "general",
						model: selectedModel,
						template: selectedTemplate,
					});
					for (const [path, content] of files) {
						steps.push(
							await putRepoFile(
								this.env,
								org,
								repo,
								path,
								content,
								`scaffold ${slug} via MCP`,
							),
						);
					}
					if (auto_deploy !== false) {
						steps.push(await triggerDeploy(this.env, org, repo));
					} else {
						steps.push("~ Auto deploy skipped by request");
					}
				}

				await audit(this.safety(token), { tool: "scaffold_agent", action: "completed", input, result: { agentId: created.id, repo } });
				return text(
					[
						`Scaffolded **${name}** (${slug})`,
						`Store: https://proagentstore.online/agents/${slug}/`,
						`Repo: https://github.com/${org}/${repo}`,
						`Worker: https://${slug}.proagentstore.online`,
						"",
						...steps,
					].join("\n"),
				);
			},
		);

		this.server.tool(
			"update_agent",
			"Update an agent's settings",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string(),
				name: z.string().optional(),
				description: z.string().optional(),
				visibility: z.string().optional(),
				model: z.string().optional(),
				dry_run: z.boolean().optional(),
			},
			async ({ token, agent_id, dry_run, ...updates }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const body: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(updates)) {
					if (v) body[k] = v;
				}
				const input = { agent_id, ...body };
				const denied = await requirePermission(this.safety(token), "write", "update_agent", input);
				if (denied) return denied;
				if (dry_run) {
					return dryRun(this.safety(token), "update_agent", "update agent settings", input, {
						endpoint: `/v1/agents/${agent_id}`,
						method: "PUT",
						body,
					});
				}
				const data = (await authedCall(`/v1/agents/${agent_id}`, sessionToken, {
					method: "PUT",
					body: JSON.stringify(body),
				}, this.env)) as { success?: boolean; error?: string };
				if (data.success) await audit(this.safety(token), { tool: "update_agent", action: "completed", input });
				return {
					content: [
						{
							type: "text" as const,
							text: data.success ? "Updated" : `Error: ${data.error}`,
						},
					],
				};
			},
		);

		this.server.tool(
			"list_agent_files",
			"List files in an owned agent's GitHub repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
				path: z.string().optional(),
			},
			async ({ token, agent_id, path }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				return text(await listRepoFiles(this.env, org, repoNameFor(agent_id), path));
			},
		);

		this.server.tool(
			"read_agent_file",
			"Read a file from an owned agent's GitHub repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
				path: z.string().describe("File path relative to repo root"),
			},
			async ({ token, agent_id, path }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				const file = await getRepoFile(this.env, org, repoNameFor(agent_id), path);
				if (file.error) return text(`Error reading ${path}: ${file.error}`);
				return text(file.content || "");
			},
		);

		this.server.tool(
			"write_agent_file",
			"Create or overwrite a file in an owned agent's GitHub repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
				path: z.string().describe("File path relative to repo root"),
				content: z.string().describe("Full file content"),
				message: z.string().optional().describe("Commit message"),
				confirm: z.string().optional().describe('Must be "write_agent_file" to create or overwrite repository content.'),
				dry_run: z.boolean().optional(),
			},
			async ({ token, agent_id, path, content, message, confirm, dry_run }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const input = { agent_id, path, content, message };
				const denied = await requirePermission(this.safety(token), "write", "write_agent_file", input);
				if (denied) return denied;
				if (dry_run) {
					return dryRun(this.safety(token), "write_agent_file", "create or overwrite repository file", input, {
						repo: repoNameFor(agent_id),
						path,
						bytes: new TextEncoder().encode(content).length,
						message,
					});
				}
				const unconfirmed = await requireConfirmation(this.safety(token), "write_agent_file", confirm, "write_agent_file", input);
				if (unconfirmed) return unconfirmed;
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				const result = await putRepoFile(
					this.env,
					org,
					repoNameFor(agent_id),
					path,
					content,
					message,
				);
				await audit(this.safety(token), { tool: "write_agent_file", action: "completed", input: { agent_id, path, message }, result });
				return text(result);
			},
		);

		this.server.tool(
			"batch_write_agent_files",
			"Create or overwrite multiple files in an owned agent's GitHub repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
				files: z.array(
					z.object({
						path: z.string(),
						content: z.string(),
					}),
				),
				message: z.string().optional().describe("Commit message"),
				confirm: z.string().optional().describe('Must be "batch_write_agent_files" to create or overwrite repository content.'),
				dry_run: z.boolean().optional(),
			},
			async ({ token, agent_id, files, message, confirm, dry_run }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const input = {
					agent_id,
					files: files.map((file) => ({
						path: file.path,
						bytes: new TextEncoder().encode(file.content).length,
					})),
					message,
				};
				const denied = await requirePermission(this.safety(token), "write", "batch_write_agent_files", input);
				if (denied) return denied;
				if (dry_run) {
					return dryRun(this.safety(token), "batch_write_agent_files", "create or overwrite repository files", input, {
						repo: repoNameFor(agent_id),
						files: input.files,
						message,
					});
				}
				const unconfirmed = await requireConfirmation(this.safety(token), "batch_write_agent_files", confirm, "batch_write_agent_files", input);
				if (unconfirmed) return unconfirmed;
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				const lines: string[] = [];
				for (const file of files) {
					lines.push(
						await putRepoFile(
							this.env,
							org,
							repoNameFor(agent_id),
							file.path,
							file.content,
							message,
						),
					);
				}
				await audit(this.safety(token), { tool: "batch_write_agent_files", action: "completed", input, result: lines });
				return text(lines.join("\n"));
			},
		);

		this.server.tool(
			"agent_deploy_status",
			"Check the latest GitHub Actions deploy runs for an agent repo.",
			{ agent_id: z.string().describe("Agent ID or slug") },
			async ({ agent_id }) => {
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				return text(await deployStatus(this.env, org, repoNameFor(agent_id)));
			},
		);

		this.server.tool(
			"trigger_agent_deploy",
			"Trigger the GitHub Actions deploy workflow for an owned agent repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
				dry_run: z.boolean().optional(),
			},
			async ({ token, agent_id, dry_run }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const input = { agent_id };
				const denied = await requirePermission(this.safety(token), "runtime", "trigger_agent_deploy", input);
				if (denied) return denied;
				if (dry_run) {
					return dryRun(this.safety(token), "trigger_agent_deploy", "trigger GitHub Actions deploy workflow", input, {
						repo: repoNameFor(agent_id),
						workflow: "deploy.yml",
						ref: "main",
					});
				}
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				const result = await triggerDeploy(this.env, org, repoNameFor(agent_id));
				await audit(this.safety(token), { tool: "trigger_agent_deploy", action: "completed", input, result });
				return text(result);
			},
		);

		this.server.tool(
			"add_knowledge",
			"Add a document to an agent's knowledge base",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string(),
				title: z.string(),
				content: z.string(),
				source: z.string().optional(),
				dry_run: z.boolean().optional(),
			},
			async ({ token, agent_id, title, content, source, dry_run }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const input = { agent_id, title, content, source };
				const denied = await requirePermission(this.safety(token), "write", "add_knowledge", input);
				if (denied) return denied;
				if (dry_run) {
					return dryRun(this.safety(token), "add_knowledge", "add agent knowledge document", input, {
						endpoint: `/v1/agents/${agent_id}/knowledge`,
						title,
						source: source || "paste",
						bytes: new TextEncoder().encode(content).length,
					});
				}
				const data = (await authedCall(
					`/v1/agents/${agent_id}/knowledge`,
					sessionToken,
					{
						method: "POST",
						body: JSON.stringify({ title, content, source: source || "paste" }),
					},
					this.env,
				)) as { id?: string; error?: string };
				if (data.id) await audit(this.safety(token), { tool: "add_knowledge", action: "completed", input: { agent_id, title, source }, result: { id: data.id } });
				return {
					content: [
						{
							type: "text" as const,
							text: data.id ? `Added: ${title}` : `Error: ${data.error}`,
						},
					],
				};
			},
		);

		this.server.tool(
			"list_knowledge",
			"List documents in an agent's knowledge base",
			{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."), agent_id: z.string() },
			async ({ token, agent_id }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const data = (await authedCall(
					`/v1/agents/${agent_id}/knowledge`,
					sessionToken,
					{},
					this.env,
				)) as { documents?: unknown[] };
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(data.documents || [], null, 2),
						},
					],
				};
			},
		);

		this.server.tool(
			"agent_analytics",
			"Get usage analytics for an agent",
			{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."), agent_id: z.string() },
			async ({ token, agent_id }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const data = await authedCall(
					`/v1/agents/${agent_id}/analytics`,
					sessionToken,
					{},
					this.env,
				);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(data, null, 2) },
					],
				};
			},
		);

		// ── Coding session tools: terminal visibility + control ──

		this.server.tool(
			"coding_session_capture",
			"Capture the live terminal output from a coding session (what the CLI is showing right now). Also returns run state (idle/working/offline).",
			{
				instance_id: z.string().describe("Instance ID"),
				session_id: z.string().optional().describe("Session ID. If omitted, uses the first active session."),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, session_id, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, this.env)) as { sessions?: Array<{ id: string; status: string }> };
				const sessions = r.sessions || [];
				const sid = session_id || sessions.find((s) => s.status === "active")?.id;
				if (!sid) return text("No active coding session found.");
				const d = (await authedCall(`/v1/instances/${instance_id}/coding/sessions/${sid}/capture`, sessionToken, {}, this.env)) as { runState?: string; pane?: string };
				return jsonText({ sessionId: sid, runState: d.runState, pane: d.pane });
			},
		);

		this.server.tool(
			"coding_session_message",
			"Send a message/command to the coding CLI running in the terminal. This types into the tmux pane — like typing at the keyboard.",
			{
				instance_id: z.string().describe("Instance ID"),
				session_id: z.string().optional().describe("Session ID. If omitted, uses the first active session."),
				message: z.string().describe("Text to type into the CLI terminal"),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, session_id, message, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, this.env)) as { sessions?: Array<{ id: string; status: string }> };
				const sessions = r.sessions || [];
				const sid = session_id || sessions.find((s) => s.status === "active")?.id;
				if (!sid) return text("No active coding session found.");
				await authedCall(`/v1/instances/${instance_id}/coding/sessions/${sid}/message`, sessionToken, { method: "POST", body: JSON.stringify({ text: message }) }, this.env);
				return text(`Sent to session ${sid}: "${message}"`);
			},
		);

		this.server.tool(
			"coding_session_restart",
			"Restart the coding CLI (kills and relaunches the tmux pane). Use when the CLI is stuck or erroring.",
			{
				instance_id: z.string().describe("Instance ID"),
				session_id: z.string().optional().describe("Session ID. If omitted, uses the first active session."),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, session_id, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, this.env)) as { sessions?: Array<{ id: string; status: string }> };
				const sessions = r.sessions || [];
				const sid = session_id || sessions.find((s) => s.status === "active")?.id;
				if (!sid) return text("No active coding session found.");
				await authedCall(`/v1/instances/${instance_id}/coding/sessions/${sid}/restart`, sessionToken, { method: "POST" }, this.env);
				return text(`Session ${sid} restarted.`);
			},
		);

		this.server.tool(
			"coding_repos_list",
			"List all repos registered in a coding instance, with their status and active sessions.",
			{
				instance_id: z.string().describe("Instance ID"),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const r = (await authedCall(`/v1/instances/${instance_id}/coding/repos`, sessionToken, {}, this.env)) as { repos?: unknown[] };
				return jsonText(r.repos || []);
			},
		);

		this.server.tool(
			"coding_repo_add",
			"Add a repo to a coding instance. Accepts a local path (~/dev/...), GitHub owner/repo, or clone URL.",
			{
				instance_id: z.string().describe("Instance ID"),
				path: z.string().describe("Local path (~/dev/my-repo), owner/repo, or clone URL"),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, path, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const body: Record<string, string> = {};
				if (path.startsWith("~") || path.startsWith("/")) body.localPath = path;
				else if (path.includes("://") || path.includes(".git")) body.cloneUrl = path;
				else if (path.includes("/")) { body.githubRepo = path; body.cloneUrl = `https://github.com/${path}.git`; }
				else body.name = path;
				const r = await authedCall(`/v1/instances/${instance_id}/coding/repos`, sessionToken, { method: "POST", body: JSON.stringify(body) }, this.env);
				return jsonText(r);
			},
		);

		this.server.tool(
			"coding_sessions_list",
			"List all coding sessions (active + ended) for an instance.",
			{
				instance_id: z.string().describe("Instance ID"),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, this.env)) as { sessions?: unknown[] };
				return jsonText(r.sessions || []);
			},
		);

		this.server.tool(
			"coding_session_end",
			"End a coding session completely. Stops the CLI and closes the tmux pane.",
			{
				instance_id: z.string().describe("Instance ID"),
				session_id: z.string().optional().describe("Session ID. If omitted, uses the first active session."),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, session_id, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, this.env)) as { sessions?: Array<{ id: string; status: string }> };
				const sid = session_id || (r.sessions || []).find((s) => s.status === "active")?.id;
				if (!sid) return text("No active coding session found.");
				await authedCall(`/v1/instances/${instance_id}/coding/sessions/${sid}/end`, sessionToken, { method: "POST" }, this.env);
				return text(`Session ${sid} ended.`);
			},
		);

		this.server.tool(
			"coding_session_fresh",
			"End the current session and start a brand new one (clean state, no --resume). Fixes corrupted CLI state.",
			{
				instance_id: z.string().describe("Instance ID"),
				repo_id: z.string().optional().describe("Repo ID. If omitted, uses the repo of the first active session."),
				engine_id: z.string().optional().describe("Engine preset ID (default: claude)"),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, repo_id, engine_id, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const r = (await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, {}, this.env)) as { sessions?: Array<{ id: string; status: string; repoId: string }> };
				const active = (r.sessions || []).find((s) => s.status === "active");
				const repoId = repo_id || active?.repoId;
				if (!repoId) return text("No repo specified and no active session to infer from.");
				if (active) await authedCall(`/v1/instances/${instance_id}/coding/sessions/${active.id}/end`, sessionToken, { method: "POST" }, this.env);
				const d = await authedCall(`/v1/instances/${instance_id}/coding/sessions`, sessionToken, { method: "POST", body: JSON.stringify({ repoId, engineId: engine_id || "claude" }) }, this.env);
				return jsonText(d);
			},
		);

		this.server.tool(
			"coding_overseer",
			"Ask the cross-repo Overseer agent. It sees all repos, their live sessions, and recent terminal output. Can answer questions and drive Claude Code on specific repos.",
			{
				instance_id: z.string().describe("Instance ID"),
				message: z.string().describe("Question or instruction for the Overseer"),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, message, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const d = (await authedCall(`/v1/instances/${instance_id}/coding/overseer`, sessionToken, { method: "POST", body: JSON.stringify({ message }) }, this.env)) as { reply?: string };
				return text(d.reply || "(no response)");
			},
		);

		this.server.tool(
			"coding_diagnostics",
			"Full diagnostics for a coding instance: runner connectivity, tmux sessions, repos, issues. Use to debug why sessions are offline or stuck.",
			{
				instance_id: z.string().describe("Instance ID"),
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			},
			async ({ instance_id, token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return authRequired();
				const d = await authedCall(`/v1/instances/${instance_id}/coding/diagnostics`, sessionToken, {}, this.env);
				return jsonText(d);
			},
		);

		this.server.tool(
			"platform_guide",
			"Get ProAgentStore platform guide",
			{},
			async () => {
				return { content: [{ type: "text" as const, text: PLATFORM_GUIDE }] };
			},
		);

		this.server.tool(
			"sdk_reference",
			"Get ProAgentStore SDK usage examples",
			{},
			async () => {
				return { content: [{ type: "text" as const, text: SDK_REFERENCE }] };
			},
		);
	}
}

const PLATFORM_GUIDE = `# ProAgentStore Platform Guide

Marketplace for server-powered AI agents. Creators build agent templates, clients subscribe and run them on their own data.

## Agent Types: Agents | Workers | Tools
## CLI: pags init <name> --template worker|cron|api, pags check, pags publish
## MCP creator tools: scaffold_agent, list_agent_files, read_agent_file, write_agent_file, batch_write_agent_files, get_agent_board_config, update_agent_board_config, trigger_agent_deploy, agent_deploy_status
## MCP runtime tools: subscribe_agent, my_instances, add_instance_knowledge, chat_with_instance, instance_messages, register_instance_runtime, instance_runtime_status, unregister_instance_runtime, run_instance_task, approve_instance_task, cancel_instance_task, instance_task_events
## Public trial: chat_with_agent calls /v1/public/agents/:id/try and is for previews, not the main user runtime
## URLs: Store proagentstore.online, API api.proagentstore.online, MCP mcp.proagentstore.online/mcp
## Key endpoints: GET /v1/agents, POST /v1/public/agents/:id/try, POST /v1/instances/:id/subscribe, POST /v1/instances/:instanceId/chat`;

const SDK_REFERENCE = `# SDK: import { initPro } from '@proagentstore/sdk'
const agent = initPro({ agentId: '...', token: '...' })
await agent.chat('Hello!')
await agent.memory.set('key', 'type', 'content')
await agent.tasks.create('title', 'description')
# Widget: <script src="https://proagentstore.online/widget.js" data-agent="slug"></script>
# Webhook: POST /v1/public/webhook/INSTANCE_ID/ingest with {title, content}`;

/**
 * Environment as seen by OAuth handlers — the library injects `OAUTH_PROVIDER`
 * (the helper API) into env before invoking the default handler.
 */
type ProviderEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/**
 * The worker entry is the Cloudflare OAuth provider.
 *
 * - `apiRoute: "/mcp"` — requests under /mcp require a valid access token. The
 *   provider validates the token, decrypts the stored grant `props`, sets them on
 *   `ctx.props`, then forwards to the MCP transport (`PagsMcp.serve`). PagsMcp keeps
 *   reading `this.props.authToken` / `mcpScopes` / `mcpSubject` unchanged.
 * - `defaultHandler: loginHandler` — serves /authorize consent + login delegation,
 *   /oauth/callback, /health, and the human-readable root text.
 * - `/token` and `/register` (DCR) plus the `.well-known/*` metadata and the
 *   401 WWW-Authenticate challenge are implemented by the library.
 *
 * Token storage uses the `OAUTH_KV` binding (already configured).
 */
export default new OAuthProvider<ProviderEnv>({
	apiRoute: "/mcp",
	apiHandler: PagsMcp.serve("/mcp") as ExportedHandler<ProviderEnv> & {
		fetch: NonNullable<ExportedHandler<ProviderEnv>["fetch"]>;
	},
	defaultHandler: loginHandler as ExportedHandler<ProviderEnv>,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	scopesSupported: [...MCP_SCOPES],
	// OAuth 2.1: only S256 PKCE, matching the previous hand-rolled server.
	allowPlainPKCE: false,
	// Preserve the previous 24h access-token lifetime.
	accessTokenTTL: 86_400,
});
