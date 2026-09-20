import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
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
	const { env, tokenFor, safetyFor: _safetyFor } = ctx;

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
}
