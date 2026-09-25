import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * An agent TEMPLATE read as its owner — the creator side of AgentDetail (#613).
 *
 * ── The gap this closes is a WRONG answer, not only a missing one
 *
 * `agent_info` looks like "read an agent" and calls `/v1/public/agents/{id}`: the PUBLISHED
 * projection. So over MCP, before this, a creator's own **draft did not exist** — `agent_info`
 * 404s it, exactly as it does for a stranger — and on a published agent the fields that say what
 * the thing IS rather than how it is advertised (`visibility`, `status`, `cron_schedule`,
 * `owner_id`, the declared capabilities, the template's own state and memory) were unreachable.
 * A caller could `create_agent` and `update_agent` and never read back what it had made.
 *
 * `my_agent` is the same row through `/v1/agents/{id}` WITH the owner's bearer, which is the
 * route the console's AgentDetail uses. The two tools point at each other, because the failure
 * mode is picking the wrong one and believing the answer.
 *
 * ── TEMPLATE, not instance — the distinction every tool here has to carry
 *
 * An agent template is what a creator authors and publishes. An INSTANCE is the private copy a
 * subscriber gets, with its own DO, its own documents and its own conversation. They have
 * parallel routes and parallel tools (`get_instance_state`, `get_instance_memory`,
 * `instance_messages`), and the stores are completely separate: the template's memory is seed
 * material copied at subscribe time, and editing it does not reach anyone's running instance.
 *
 * So every description below opens by naming which side it reads, the same discipline
 * `agent-tasks.ts` follows for the two task stores. Reading the template when you meant the
 * instance answers confidently about the wrong data, which is the expensive version of this
 * mistake.
 *
 * ── All six are ungated reads, and the routes are owner-scoped server-side
 *
 * `/capabilities`, `/export`, `/memory`, `/messages` and `/state` all refuse a non-owner (403 via
 * `resolveAgent` or an explicit `owner_id` check; `chat.ts`'s own comment records why). `/{id}`
 * is the one with OPTIONAL auth — it must still answer an anonymous caller with the published
 * view — so it degrades to the public projection rather than refusing. That is stated in
 * `my_agent`'s description, because a tool named `my_agent` returning somebody else's published
 * row is a surprise worth removing.
 */
export function registerAgentAuthoringTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	/** Every route here takes the agent's id OR its slug; the phrasing is identical so it reads once. */
	const agentIdArg = z
		.string()
		.describe("Agent ID or slug from my_agents. This is the TEMPLATE you authored, not an instance_id from my_instances.");

	server.tool(
		"my_agent",
		"Read one of YOUR OWN agent templates in full, as its owner — including a DRAFT, which agent_info cannot see at all. agent_info serves the public catalogue projection (`/v1/public/agents`), so it 404s an unpublished agent and omits `visibility`, `status`, `cron_schedule` and `owner_id` even on a published one; this is the same row the console's agent editor loads. Use it to read back what create_agent or update_agent actually stored. If you are NOT the owner this degrades to the same published view agent_info gives (and 404s if that agent is not published), so a row here without `owner_id` means it is not yours.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: agentIdArg,
		},
		async ({ token, agent_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall(`/v1/agents/${encodeURIComponent(agent_id)}`, sessionToken, {}, env));
		},
	);

	server.tool(
		"get_agent_capabilities",
		"What an agent TEMPLATE declares it can do: `surfaces` (which console tabs its subscribers get), `runtime`, `workflow`, the declared `tools` allowlist, and any `customSurfaces`. Also returns `workflowOptions` — the workflow values this platform actually runs, annotated for THIS agent, so a stored value the platform has since dropped comes back visible instead of silently reading as none — and `customSurfacesEnabled`, the deployment gate. Read this before update_agent: capabilities decide what an instance's console renders and which tools its runtime is allowed, so a claim here that the code cannot honour is the usual cause of 'my agent has no such tab'. Owner only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: agentIdArg,
		},
		async ({ token, agent_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall(`/v1/agents/${encodeURIComponent(agent_id)}/capabilities`, sessionToken, {}, env));
		},
	);

	server.tool(
		"get_agent_state",
		"The TEMPLATE's own Durable Object state — identity, personality, goal, guardrails, welcome message. This is the SEED a new subscriber's instance is copied from, not any running instance's state: for that use get_instance_state, and note that editing the template does not reach instances that already exist. Owner only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: agentIdArg,
		},
		async ({ token, agent_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall(`/v1/agents/${encodeURIComponent(agent_id)}/state`, sessionToken, {}, env));
		},
	);

	server.tool(
		"get_agent_memory",
		"The TEMPLATE's seed memory — the entries a new instance is created holding. NOT a subscriber's memory: get_instance_memory reads that, and the two stores never sync, so a fact written here appears only in instances subscribed AFTER it. Each entry carries its `type` (identity, knowledge, preference, skill, context) and `source`. Owner only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: agentIdArg,
		},
		async ({ token, agent_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall(`/v1/agents/${encodeURIComponent(agent_id)}/memory`, sessionToken, {}, env));
		},
	);

	server.tool(
		"agent_messages",
		"The TEMPLATE's own conversation — the creator's test chat against their draft, which is what chat_with_agent writes to. NOT a subscriber's conversation: instance_messages reads that. Newest first, `limit` per page (default 50); page backwards by passing the oldest id you received as `before`. Owner only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: agentIdArg,
			limit: z.coerce.number().optional().describe("How many messages to return (default 50)."),
			before: z.string().optional().describe("Message id to page BACKWARDS from — pass the oldest id from the previous page. Omit for the newest."),
		},
		async ({ token, agent_id, limit, before }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// Built rather than interpolated: `before` is an opaque id and omitting the key entirely
			// is what the route reads as "newest page" (#428 — a rebuilt query string that dropped
			// `before` gave a creator the newest page every time they paged back).
			const qs = new URLSearchParams();
			if (limit !== undefined) qs.set("limit", String(limit));
			if (before) qs.set("before", before);
			const suffix = qs.toString() ? `?${qs}` : "";
			return jsonText(await authedCall(`/v1/agents/${encodeURIComponent(agent_id)}/messages${suffix}`, sessionToken, {}, env));
		},
	);

	server.tool(
		"export_agent",
		"A complete JSON backup of an agent TEMPLATE: its catalogue fields, its DO state, and EVERY knowledge document and memory entry it holds. This is the restore-shaped blob (`exportVersion`, `exportedAt`), so it is deliberately not paged or trimmed — a truncated backup is one that cannot be restored. It can therefore be large: to read one part, use get_agent_state, get_agent_memory or list_knowledge instead, and reach for this when you want the whole thing. Reads only; it changes nothing and is not a snapshot the platform stores anywhere. Owner only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: agentIdArg,
		},
		async ({ token, agent_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall(`/v1/agents/${encodeURIComponent(agent_id)}/export`, sessionToken, {}, env));
		},
	);

	// The write half deliberately lives beside the reads it changes. A template is copied when an
	// instance is subscribed, not live-linked, so every description names the template and every
	// mutation is previewable before it can alter another person's future starting point.
	const templateIdArg = z.string().describe("Opaque template agent ID from my_agents. Copy the id exactly; these write routes require an ID, not an instance_id or a public catalogue slug.");
	const tokenArg = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");
	const confirmArg = (value: string, action: string) => z.string().optional().describe(`Exact confirmation required to ${action}: "${value}". Omit on dry_run.`);
	const dryRunArg = z.boolean().optional().describe("Preview this change without sending it to the API. Does not require confirm.");

	server.tool(
		"delete_agent",
		"Permanently delete one of YOUR OWN agent TEMPLATES. This also removes the creator's own instances of it, but refuses if another subscriber has an instance — it never deletes another person's workspace. There is no restore path: use export_agent first if you may need the template, its state, knowledge or memory again.",
		{ token: tokenArg, agent_id: templateIdArg, confirm: confirmArg("delete_agent", "delete this template"), dry_run: dryRunArg },
		async ({ token, agent_id, confirm, dry_run: preview }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_agent", input);
			if (denied) return denied;
			const endpoint = `/v1/agents/${encodeURIComponent(agent_id)}`;
			if (preview) return dryRun(safetyFor(token), "delete_agent", "permanently delete an agent template", input, { endpoint, method: "DELETE", effect: "The template and the caller's own instances of it would be deleted. The API refuses if any other subscriber has an instance.", alternative: "export_agent first to retain a complete JSON backup." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_agent", confirm, "delete_agent", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "DELETE" }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "delete_agent", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_agent_knowledge",
		"Permanently remove one knowledge document from an agent TEMPLATE. This changes what new subscribers can receive; it does not edit existing instances. Read the template's list_knowledge and export_agent before deleting — neither the document nor its text has an undo path.",
		{ token: tokenArg, agent_id: templateIdArg, document_id: z.string().describe("Knowledge document ID from list_knowledge for this template."), confirm: confirmArg("delete_agent_knowledge", "delete this document"), dry_run: dryRunArg },
		async ({ token, agent_id, document_id, confirm, dry_run: preview }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id, document_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_agent_knowledge", input);
			if (denied) return denied;
			const endpoint = `/v1/agents/${encodeURIComponent(agent_id)}/knowledge/${encodeURIComponent(document_id)}`;
			if (preview) return dryRun(safetyFor(token), "delete_agent_knowledge", "delete a template knowledge document", input, { endpoint, method: "DELETE", effect: "The selected template document would be removed permanently; existing instances keep their separate knowledge stores.", alternative: "export_agent first to retain the document in a backup." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_agent_knowledge", confirm, "delete_agent_knowledge", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "DELETE" }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "delete_agent_knowledge", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"set_agent_capabilities",
		"Replace the supplied declared capabilities of an agent TEMPLATE: surfaces, runtime, workflow, tool allowlist and/or custom surfaces. These decide what future subscribers can see and what their runtime is allowed to do; read get_agent_capabilities first. Omitted fields are preserved by the API, including custom surfaces when custom_surfaces is omitted.",
		{
			token: tokenArg,
			agent_id: templateIdArg,
			surfaces: z.array(z.string()).optional().describe("Console surfaces to declare. Omit to preserve them."),
			runtime: z.enum(["browser", "coding"]).nullable().optional().describe("Template runtime, or null to clear it. Omit to preserve it."),
			workflow: z.string().nullable().optional().describe("Workflow name, or null to clear it. Omit to preserve it."),
			tools: z.array(z.string()).optional().describe("Allowed runtime tool names. Omit to preserve them."),
			custom_surfaces: z.array(z.record(z.string(), z.unknown())).optional().describe("Custom console-surface entries, mapped to the API's customSurfaces field. Omit to preserve them."),
			confirm: confirmArg("set_agent_capabilities", "save these template capabilities"),
			dry_run: dryRunArg,
		},
		async ({ token, agent_id, surfaces, runtime, workflow, tools, custom_surfaces, confirm, dry_run: preview }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const body = { ...(surfaces !== undefined ? { surfaces } : {}), ...(runtime !== undefined ? { runtime } : {}), ...(workflow !== undefined ? { workflow } : {}), ...(tools !== undefined ? { tools } : {}), ...(custom_surfaces !== undefined ? { customSurfaces: custom_surfaces } : {}) };
			const input = { agent_id, ...body };
			const denied = await requirePermission(safetyFor(token), "destructive", "set_agent_capabilities", input);
			if (denied) return denied;
			const endpoint = `/v1/agents/${encodeURIComponent(agent_id)}/capabilities`;
			if (preview) return dryRun(safetyFor(token), "set_agent_capabilities", "save declared template capabilities", input, { endpoint, method: "PUT", fields: Object.keys(body), effect: "Only the supplied capability fields would change; omitted fields remain as stored." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "set_agent_capabilities", confirm, "set_agent_capabilities", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_agent_capabilities", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"set_agent_state",
		"Replace the supplied Durable Object state of an agent TEMPLATE — identity, personality, goal, guardrails and welcome message. This changes the seed copied to future subscribers, not a running instance; read get_agent_state first and create_agent_version before a substantial rewrite.",
		{ token: tokenArg, agent_id: templateIdArg, state: z.record(z.string(), z.unknown()).describe("Complete template state object to send to the template state route."), confirm: confirmArg("set_agent_state", "save this template state"), dry_run: dryRunArg },
		async ({ token, agent_id, state, confirm, dry_run: preview }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id, state };
			const denied = await requirePermission(safetyFor(token), "destructive", "set_agent_state", input);
			if (denied) return denied;
			const endpoint = `/v1/agents/${encodeURIComponent(agent_id)}/state`;
			if (preview) return dryRun(safetyFor(token), "set_agent_state", "save template Durable Object state", input, { endpoint, method: "PUT", stateKeys: Object.keys(state), effect: "The supplied state would become the template's seed. Existing subscriber instances are not changed." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "set_agent_state", confirm, "set_agent_state", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify(state) }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_agent_state", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"chat_with_my_agent",
		"Send a test message to one of YOUR OWN agent TEMPLATES. This is the creator conversation returned by agent_messages, not chat_with_instance's private subscriber conversation. It runs the template and records a usage/chat turn, so preview first and confirm the real call.",
		{ token: tokenArg, agent_id: templateIdArg, message: z.string().min(1).describe("Message to send to the template test conversation."), confirm: confirmArg("chat_with_my_agent", "send this template chat message"), dry_run: dryRunArg },
		async ({ token, agent_id, message, confirm, dry_run: preview }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id, message };
			const denied = await requirePermission(safetyFor(token), "destructive", "chat_with_my_agent", input);
			if (denied) return denied;
			const endpoint = `/v1/agents/${encodeURIComponent(agent_id)}/chat`;
			if (preview) return dryRun(safetyFor(token), "chat_with_my_agent", "run a template test-chat turn", input, { endpoint, method: "POST", messageBytes: new TextEncoder().encode(message).length, effect: "The template would receive this message and create a test-chat/usage turn." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "chat_with_my_agent", confirm, "chat_with_my_agent", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ message }) }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "chat_with_my_agent", action: "completed", input: { agent_id, messageBytes: new TextEncoder().encode(message).length }, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"create_agent_version",
		"Save the current state of one of YOUR OWN agent TEMPLATES as an immutable version snapshot. This does not change the live template; it creates a rollback point. Preview shows the exact route, then confirm to write the version.",
		{ token: tokenArg, agent_id: templateIdArg, description: z.string().optional().describe("Optional human description for this snapshot."), confirm: confirmArg("create_agent_version", "create this template version"), dry_run: dryRunArg },
		async ({ token, agent_id, description, confirm, dry_run: preview }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id, description };
			const denied = await requirePermission(safetyFor(token), "destructive", "create_agent_version", input);
			if (denied) return denied;
			const endpoint = `/v1/agents/${encodeURIComponent(agent_id)}/versions`;
			if (preview) return dryRun(safetyFor(token), "create_agent_version", "save a template version snapshot", input, { endpoint, method: "POST", effect: "A new immutable snapshot of the current template state would be created; the live template is unchanged." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "create_agent_version", confirm, "create_agent_version", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ ...(description !== undefined ? { description } : {}) }) }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "create_agent_version", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"rollback_agent_version",
		"Replace an agent TEMPLATE's live state with one saved version. This overwrites the current template seed and cannot restore unsaved changes; create_agent_version first if the current state matters. Existing subscriber instances remain separate and are not rewritten.",
		{ token: tokenArg, agent_id: templateIdArg, version_id: z.string().describe("Version ID from the template's version history."), confirm: confirmArg("rollback_agent_version", "roll this template back"), dry_run: dryRunArg },
		async ({ token, agent_id, version_id, confirm, dry_run: preview }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id, version_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "rollback_agent_version", input);
			if (denied) return denied;
			const endpoint = `/v1/agents/${encodeURIComponent(agent_id)}/versions/${encodeURIComponent(version_id)}/rollback`;
			if (preview) return dryRun(safetyFor(token), "rollback_agent_version", "replace live template state with a saved version", input, { endpoint, method: "POST", effect: "The selected version's state would replace the live template state. Unsaved current state would be lost.", alternative: "create_agent_version first to retain the current state." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "rollback_agent_version", confirm, "rollback_agent_version", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "POST" }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "rollback_agent_version", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"plan_agent_builder",
		"Turn a natural-language request into the deterministic agent-builder plan the creator UI uses: proposed template fields, runtime, connectors, warnings and the action it would take. Planning changes nothing; inspect this result before execute_agent_builder_plan.",
		{ token: tokenArg, prompt: z.string().min(1).describe("Describe the agent to plan."), },
		async ({ token, prompt }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall("/v1/agent-builder/plan", sessionToken, { method: "POST", body: JSON.stringify({ prompt }) }, env));
		},
	);

	server.tool(
		"execute_agent_builder_plan",
		"Execute a reviewed agent-builder plan to create or scaffold a new agent template. This can create durable platform state and, for a scaffold plan, repository material; preview first and pass the exact confirmation only when the plan is the one you intend to create.",
		{ token: tokenArg, plan: z.record(z.string(), z.unknown()).describe("The complete plan returned by plan_agent_builder, copied without altering its structure."), confirm: confirmArg("execute_agent_builder_plan", "execute this agent-builder plan"), dry_run: dryRunArg },
		async ({ token, plan, confirm, dry_run: preview }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { plan };
			const denied = await requirePermission(safetyFor(token), "destructive", "execute_agent_builder_plan", input);
			if (denied) return denied;
			if (preview) return dryRun(safetyFor(token), "execute_agent_builder_plan", "create or scaffold a template from an agent-builder plan", input, { endpoint: "/v1/agent-builder/execute", method: "POST", action: (plan as { action?: unknown }).action, slug: ((plan as { agent?: { slug?: unknown } }).agent?.slug), effect: "The plan would create a new draft template and may scaffold repository material." });
			const unconfirmed = await requireConfirmation(safetyFor(token), "execute_agent_builder_plan", confirm, "execute_agent_builder_plan", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall("/v1/agent-builder/execute", sessionToken, { method: "POST", body: JSON.stringify({ plan }) }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "execute_agent_builder_plan", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
