/**
 * ProAgentStore MCP Server — manage agents from Claude, Cursor, VS Code.
 * 10 tools matching FAGS MCP for platform consistency.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const API = "https://api.proagentstore.online";
type Env = Record<string, unknown>;
type Props = Record<string, unknown>;

async function apiCall(path: string, opts?: RequestInit): Promise<unknown> {
	const res = await fetch(`${API}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", ...opts?.headers },
	});
	return res.json();
}

async function authedCall(
	path: string,
	token: string,
	opts?: RequestInit,
): Promise<unknown> {
	return apiCall(path, {
		...opts,
		headers: { Authorization: `Bearer ${token}`, ...opts?.headers },
	});
}

export class PagsMcp extends McpAgent<Env, unknown, Props> {
	server = new McpServer({ name: "ProAgentStore", version: "0.1.0" });

	async init() {
		this.server.tool(
			"list_agents",
			"List all published agents on ProAgentStore",
			{},
			async () => {
				const data = (await apiCall("/v1/agents")) as { agents: unknown[] };
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
				const data = await apiCall(`/v1/public/agents/${agent_id}`);
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
				})) as {
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
			"create_agent",
			"Create a new agent on ProAgentStore",
			{
				token: z.string(),
				slug: z.string(),
				name: z.string(),
				description: z.string().optional(),
				category: z.string().optional(),
				model: z.string().optional(),
				personality: z.string().optional(),
				goal: z.string().optional(),
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
			}) => {
				const data = (await authedCall("/v1/agents", token, {
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
				})) as { id?: string; error?: string };
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
			"update_agent",
			"Update an agent's settings",
			{
				token: z.string(),
				agent_id: z.string(),
				name: z.string().optional(),
				description: z.string().optional(),
				visibility: z.string().optional(),
				model: z.string().optional(),
			},
			async ({ token, agent_id, ...updates }) => {
				const body: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(updates)) {
					if (v) body[k] = v;
				}
				const data = (await authedCall(`/v1/agents/${agent_id}`, token, {
					method: "PUT",
					body: JSON.stringify(body),
				})) as { success?: boolean; error?: string };
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
			"add_knowledge",
			"Add a document to an agent's knowledge base",
			{
				token: z.string(),
				agent_id: z.string(),
				title: z.string(),
				content: z.string(),
				source: z.string().optional(),
			},
			async ({ token, agent_id, title, content, source }) => {
				const data = (await authedCall(
					`/v1/agents/${agent_id}/knowledge`,
					token,
					{
						method: "POST",
						body: JSON.stringify({ title, content, source: source || "paste" }),
					},
				)) as { id?: string; error?: string };
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
			{ token: z.string(), agent_id: z.string() },
			async ({ token, agent_id }) => {
				const data = (await authedCall(
					`/v1/agents/${agent_id}/knowledge`,
					token,
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
			{ token: z.string(), agent_id: z.string() },
			async ({ token, agent_id }) => {
				const data = await authedCall(
					`/v1/agents/${agent_id}/analytics`,
					token,
				);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(data, null, 2) },
					],
				};
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
## URLs: Store proagentstore.online, API api.proagentstore.online, MCP mcp.proagentstore.online/mcp
## Key endpoints: GET /v1/agents, POST /v1/public/agents/:id/try, POST /v1/instances/:id/subscribe`;

const SDK_REFERENCE = `# SDK: import { initPro } from '@proagentstore/sdk'
const agent = initPro({ agentId: '...', token: '...' })
await agent.chat('Hello!')
await agent.memory.set('key', 'type', 'content')
await agent.tasks.create('title', 'description')
# Widget: <script src="https://proagentstore.online/widget.js" data-agent="slug"></script>
# Webhook: POST /v1/public/webhook/INSTANCE_ID/ingest with {title, content}`;

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
			return PagsMcp.serveSSE("/mcp").fetch(request, env, ctx);
		}
		if (url.pathname === "/health") {
			return new Response(
				JSON.stringify({ ok: true, service: "proagentstore-mcp", tools: 10 }),
				{ headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response(
			"ProAgentStore MCP Server\n\nConnect: npx mcp-remote https://mcp.proagentstore.online/mcp",
			{ headers: { "Content-Type": "text/plain" } },
		);
	},
};
