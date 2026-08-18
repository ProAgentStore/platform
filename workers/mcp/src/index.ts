import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { buildAgentListing } from "./agent-listing.js";
import { apiCall, authedCall, authRequired, INVALID_JSON, type McpEnv, jsonResult, jsonText, parseJsonArg, text } from "./http.js";
import { registerCodingSessionTools } from "./coding-tools.js";
import { registerInstanceTools } from "./instance-tools/index.js";
import { registerStorageTools } from "./storage-tools.js";
import { loginHandler } from "./oauth-provider.js";
import { installRegistrationPipeline, type RegistrationTarget } from "./registration.js";
import { PLATFORM_GUIDE } from "./platform-guide.js";
import { MCP_SERVER_VERSION } from "./server-version.js";
import { newTokenSubjectCache, tokenSubjectResolver } from "./audit-subject.js";
import { annotationsFor, outputSchemaFor, SERVER_INSTRUCTIONS } from "./tool-metadata.js";
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
import { suspensionBlock } from "./suspension.js";

type Props = {
	authToken?: string;
	mcpScopes?: string[] | null;
	mcpSubject?: string;
};
type Env = McpEnv;

export class PagsMcp extends McpAgent<Env, unknown, Props> {
	server = new McpServer({ name: "ProAgentStore", version: MCP_SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
	private userToken: string | null = null;
	private scopes: string[] | null = null;
	private subject: string | undefined;
	private toolsRegistered = false;

	private token(provided?: string): string | null {
		return provided || this.userToken;
	}

	/** Survives across `safety()` calls, which is where the memo has to live: one tool call
	 *  builds a context more than once, and each one audits (#702). */
	private tokenSubjectCache = newTokenSubjectCache();

	private safety(provided?: string): SafetyContext {
		return {
			env: this.env,
			subject: provided ? undefined : this.subject,
			scopes: provided ? null : this.scopes,
			// A per-call `token` is an IDENTITY, not an anonymiser: it resolves to an audit
			// subject so a scripted mutation stops being invisible (#702). `scopes` stays null
			// (→ DEFAULT_SCOPES) — this is a coverage fix, not an authorization change.
			...(provided
				? { resolveSubject: tokenSubjectResolver(this.env.SESSION_SIGNING_KEY, provided, this.tokenSubjectCache) }
				: {}),
		};
	}

	/**
	 * Route EVERY registration through the shared pipeline (`registration.ts`), once,
	 * before any registration happens: it carries the operator-suspension gate (#273) and
	 * the tool metadata this server publishes (#561).
	 */
	private installRegistrationPipeline(): void {
		installRegistrationPipeline(this.server as unknown as RegistrationTarget, {
			gate: (name, provided) => suspensionBlock(this.env, this.token(provided), name),
			metadata: (name) => {
				const annotations = annotationsFor(name);
				const outputSchema = outputSchemaFor(name);
				return {
					...(annotations ? { annotations } : {}),
					...(outputSchema ? { outputSchema } : {}),
				};
			},
		});
	}

	/**
	 * The console-surface groups (apply / coding / repo …) across the connected
	 * user's subscribed agents. Agent-specific tools are gated to these, so a user
	 * only sees tools for the agents they actually have (a Repo Chat user never
	 * sees apply_to_job). Empty when unauthenticated → only core tools show.
	 */
	private async userGroups(): Promise<Set<string>> {
		const groups = new Set<string>();
		if (!this.userToken) return groups;
		try {
			const data = (await authedCall("/v1/instances/my/instances", this.userToken, {}, this.env)) as
				| Array<{ capabilities?: { surfaces?: string[] } }>
				| { instances?: Array<{ capabilities?: { surfaces?: string[] } }> };
			const list = Array.isArray(data) ? data : (data.instances ?? []);
			for (const inst of list) for (const s of inst.capabilities?.surfaces ?? []) groups.add(s);
		} catch {
			/* unauthenticated or transient error → no agent-specific tools this connection */
		}
		return groups;
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

		// Must precede every registration below — it wraps the registrar itself.
		this.installRegistrationPipeline();

		// Which agent-specific tool groups this user gets — scoped to their agents.
		const groups = await this.userGroups();

		this.server.tool(
			"list_agents",
			"List all published agents on ProAgentStore",
			{},
			async () => {
				const data = (await apiCall("/v1/agents", {}, this.env)) as { agents: unknown[] };
				// `{agents: […]}` rather than the bare array it used to answer with: this tool
				// declares an outputSchema, and `structuredContent` must be an object (#561).
				// The text block carries the same JSON, as the spec asks.
				return jsonResult({ agents: data.agents ?? [] });
			},
		);

		this.server.tool(
			"agent_info",
			"Get detailed info about an agent",
			{ agent_id: z.string().describe("Agent ID or slug") },
			async ({ agent_id }) => {
				const data = await apiCall(`/v1/public/agents/${agent_id}`, {}, this.env);
				// Hand-rolled `JSON.stringify(data, null, 2)` until #586 — a copy of the old
				// `jsonText` default that would have survived changing that default. `jsonText`
				// is the one serialiser, and it is compact.
				return jsonText(data);
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
			"List agents owned by the authenticated ProAgentStore creator. `total` and `roster` name EVERY owned agent and are never shortened, so answer \"how many agents do I have\" and \"which ones\" from those. `agents` is a PAGE carrying each agent's full record — including `config`, which is 61% of this response's bytes and is not readable through any other tool (agent_info reads the PUBLIC record, which omits config and does not exist for a draft). Read `page.hasMore` and call again with `offset: page.nextOffset` for the rest.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				offset: z.number().int().min(0).optional().describe("Skip this many agents' full records. Pass `page.nextOffset` from the previous reply; omit for the first page. The roster is complete on every page regardless."),
				limit: z.number().int().min(1).optional().describe("Cap the full records returned. The reply is budgeted to fit a host's wire limit regardless, so a large limit is silently reduced rather than refused — `page.count` says what you got."),
			},
			async ({ token, offset, limit }) => {
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
				// 41 agents were 66,013 bytes over a 64 KiB host limit; `config` was 60.9% of it and
				// has no other reader, so the collection is paged rather than the field dropped.
				// See `agent-listing.ts` for the attribution and the capability check behind that.
				return text(buildAgentListing({ agents, offset, limit }).text);
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
			groups,
		);

		registerStorageTools(
			this.server,
			this.env,
			(provided) => this.token(provided),
			(provided) => this.safety(provided),
		);

		this.server.tool(
			"create_agent",
			"Create a new agent on ProAgentStore. `capabilities` and `settings_schema` declare what the agent IS — surfaces, runtime, workflow, its tools[] allowlist and its subscriber settings — so a fully-formed agent is one call. Without them you get a plain chat agent that then needs update_agent.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				slug: AGENT_ID,
				name: z.string(),
				description: z.string().optional(),
				category: z.string().optional(),
				model: z.string().optional(),
				personality: z.string().optional(),
				goal: z.string().optional(),
				capabilities: z
					.union([z.record(z.unknown()), z.string()])
					.optional()
					.describe(
						"Declarative capabilities, validated server-side: surfaces[], runtime (browser|coding|null), workflow, tools[] allowlist (e.g. delegate_goal/list_subordinates for a supervisor, or the coding runtime for a repo agent). Object, or a JSON string of the same.",
					),
				settings_schema: z
					.union([z.array(z.unknown()), z.string()])
					.optional()
					.describe("Typed per-subscriber settings (select/text/number/toggle, max 12). Array, or a JSON string of the same."),
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
				capabilities,
				settings_schema,
				dry_run,
			}) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				// A JSON string is accepted (see parseJsonArg), a malformed one refused: undefined
				// capabilities is silently the plain chat agent this tool's description promises
				// you avoid, created and reported as `Created: <id>`.
				const caps = parseJsonArg(capabilities);
				if (caps === INVALID_JSON) return text("Error: capabilities must be a JSON object or valid JSON string.");
				const schema = parseJsonArg(settings_schema);
				if (schema === INVALID_JSON) return text("Error: settings_schema must be a JSON array or valid JSON string.");
				const input = { slug, name, description, category, model, personality, goal, capabilities: caps, settingsSchema: schema };
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
						// Undefined keys are dropped by JSON.stringify, so an omitted field stays
						// omitted rather than blanking a server-side default.
						capabilities: caps,
						settingsSchema: schema,
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
			"Update an agent's settings. `capabilities` declares the agent's power fields as data (#141): surfaces, runtime (browser|coding|null), workflow, and the tools[] allowlist (e.g. browser_navigate/browser_snapshot/browser_act to make it a browser agent). Patch-merged + validated server-side.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string(),
				name: z.string().optional(),
				description: z.string().optional(),
				visibility: z.string().optional(),
				model: z.string().optional(),
				capabilities: z
					.union([
						z.object({
							surfaces: z.array(z.string()).optional(),
							runtime: z.enum(["browser", "coding"]).nullable().optional(),
							// CANONICAL SOURCE: `workers/api/src/lib/agent-workflows.ts` `AGENT_WORKFLOWS`.
							// A transport-side mirror (the API re-validates), kept honest by the drift
							// test in `agent-workflows.test.ts` — this list carried INSURANCE_QUOTES,
							// which no `[[workflows]]` binding backs, for as long as three others did.
							workflow: z.enum(["JOB_APPLY", "CODING_SESSION", "BROWSER_TASK"]).nullable().optional(),
							tools: z.array(z.string()).optional(),
						}),
						// Some MCP clients stringify nested object args — accept a JSON string too
						// (parsed below). The API route re-validates it, so this is just transport.
						z.string(),
					])
					.optional()
					.describe("Declarative capabilities (surfaces/runtime/workflow/tools); only the keys you send change. Object, or a JSON string of the same."),
				dry_run: z.boolean().optional(),
			},
			async ({ token, agent_id, dry_run, ...updates }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const body: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(updates)) {
					if (v) body[k] = v;
				}
				// Coerce a stringified capabilities object (MCP-client quirk) back to an object;
				// the API's sanitizeDeclaredCapabilities validates it regardless.
				const caps = parseJsonArg(body.capabilities);
				if (caps === INVALID_JSON) return text("Error: capabilities must be a JSON object or valid JSON string.");
				if (caps !== undefined) body.capabilities = caps;
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
			"list_agent_repo_files",
			"List files in an owned agent's GitHub repo. (For an agent's uploaded DO files, use list_agent_files.)",
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
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
			},
			async ({ token, agent_id }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const input = { agent_id };
				const denied = await requirePermission(this.safety(token), "read", "agent_deploy_status", input);
				if (denied) return denied;
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
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
				return jsonText(data.documents || []);
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
				return jsonText(data);
			},
		);

		// ── Coding session tools: opening, watching and driving the CLI on the user's machine ──
		// Only for users who have a coding agent (e.g. Coder). Their registrations live in
		// coding-tools.ts — index.ts was one line under its size ratchet when #696 added the
		// eleventh, and the ratchet asks for a split rather than a raise.
		if (groups.has("coding")) {
			registerCodingSessionTools(this.server, this.env, (provided) => this.token(provided), (provided) => this.safety(provided));
		}

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
