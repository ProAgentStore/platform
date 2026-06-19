import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, type McpEnv, jsonText, text } from "./http.js";

type TokenResolver = (provided?: string) => string | null;

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
): void {
	server.tool(
		"subscribe_agent",
		"Subscribe to a published agent and create your own private runnable instance. Use this before chat_with_instance for real user runs.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: z.string().describe("Published agent ID or slug"),
		},
		async ({ token, agent_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = (await authedCall(
				`/v1/instances/${agent_id}/subscribe`,
				sessionToken,
				{ method: "POST" },
				env,
			)) as { instanceId?: string; agentId?: string; status?: string; error?: string };
			if (data.instanceId) {
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
		},
		async ({ token, instance_id, message }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = (await authedCall(
				`/v1/instances/${instance_id}/chat`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ message }) },
				env,
			)) as {
				message?: { content?: string };
				error?: string;
			};
			return text(data.message?.content || data.error || "No response");
		},
	);

	server.tool(
		"register_instance_runtime",
		"Register a local or managed browser runner for one of your private instances. Use this before run_instance_task for browser-capable agents.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			endpoint_url: z.string().describe("HTTPS tunnel URL for the runner, or localhost URL for development."),
			runner_token: z.string().optional().describe("Bearer token configured on the runner."),
			placement: z.enum(["local", "managed"]).optional(),
			capabilities: z.array(z.string()).optional(),
			runner_version: z.string().optional(),
		},
		async ({
			token,
			instance_id,
			endpoint_url,
			runner_token,
			placement,
			capabilities,
			runner_version,
		}) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
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
			return data.error
				? text(`Error: ${data.error}`)
				: text(`Runtime registered for ${instance_id}.\n${JSON.stringify(data.runtime, null, 2)}`);
		},
	);

	server.tool(
		"instance_runtime_status",
		"Check the registered local or managed runtime for one of your private instances.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			probe: z.boolean().optional().describe("When true, PAGS calls the runner /health and /capabilities endpoints."),
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
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = (await authedCall(
				`/v1/instances/${instance_id}/runtime`,
				sessionToken,
				{ method: "DELETE" },
				env,
			)) as { success?: boolean; error?: string };
			return text(data.success ? "Runtime unregistered." : `Error: ${data.error || "unregister failed"}`);
		},
	);

	server.tool(
		"run_instance_task",
		"Create a task on the registered local or managed runner for a private instance. The PAGS brain stays in control; the runner executes local capabilities.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			type: z.string().describe("Runner task type, e.g. echo or browser.open."),
			input: z.record(z.unknown()).optional(),
			requires_approval: z.boolean().optional(),
			approval_prompt: z.string().optional(),
		},
		async ({ token, instance_id, type, input, requires_approval, approval_prompt }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
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
			return jsonText(data);
		},
	);

	server.tool(
		"approve_instance_task",
		"Approve a runner task waiting for human approval.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string(),
		},
		async ({ token, instance_id, task_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/approve`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"cancel_instance_task",
		"Cancel a task on the registered local or managed runner for a private instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			task_id: z.string(),
		},
		async ({ token, instance_id, task_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/tasks/${task_id}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"instance_task_events",
		"Read recent events from a private instance's registered runner.",
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
		"add_instance_knowledge",
		"Add user-specific knowledge to your private subscribed instance. This does not alter the creator's template agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			title: z.string(),
			content: z.string(),
			source: z.string().optional(),
			source_url: z.string().optional(),
		},
		async ({ token, instance_id, title, content, source, source_url }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
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
		"delete_instance_knowledge",
		"Delete a knowledge document from your private subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			document_id: z.string(),
		},
		async ({ token, instance_id, document_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/knowledge/${document_id}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"cancel_instance",
		"Cancel your subscription and deactivate one private subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = (await authedCall(
				`/v1/instances/${instance_id}/cancel`,
				sessionToken,
				{ method: "POST" },
				env,
			)) as { success?: boolean; error?: string };
			return text(data.success ? "Canceled" : `Error: ${data.error}`);
		},
	);
}
