/**
 * AGENTNAME — a ProAgentStore agent.
 *
 * This is a Durable Object-based agent with persistent conversation history.
 * AI inference requires caller-owned Cloudflare Workers AI credentials.
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

interface Env {
	AGENT: DurableObjectNamespace;
}

const MODEL = "@cf/meta/llama-3.2-3b-instruct";
const SYSTEM_PROMPT = `You are AGENTNAME, a helpful AI agent.
Customize this prompt to define your agent's personality, knowledge domain, and behavior.`;

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
	c.json({
		agent: "AGENTNAME",
		status: "ok",
		aiBilling: "caller-provided",
		requiredHeaders: ["X-CF-Account-ID", "X-CF-AI-Token"],
	}),
);

app.post("/chat", async (c) => {
	const credentials = callerAiCredentials(c.req.raw);
	if (!credentials) return missingCredentials();

	const { message } = await c.req.json<{ message: string }>();
	if (!message) return c.json({ error: "message required" }, 400);

	const doId = c.env.AGENT.idFromName("main");
	const stub = c.env.AGENT.get(doId);
	const res = await stub.fetch(
		new Request("http://agent/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-CF-Account-ID": credentials.accountId,
				"X-CF-AI-Token": credentials.token,
			},
			body: JSON.stringify({ message }),
		}),
	);
	return new Response(res.body, { status: res.status, headers: res.headers });
});

export default app;

export class AgentDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/chat" && request.method === "POST") {
			const credentials = callerAiCredentials(request);
			if (!credentials) return missingCredentials();

			const { message } = await request.json<{ message: string }>();

			const history = await this.ctx.storage.list<{
				role: string;
				content: string;
			}>({ prefix: "msg:", reverse: true, limit: 30 });
			const messages = [...history.values()].reverse();

			const result = (await runCallerWorkersAi(credentials, {
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					...messages,
					{ role: "user", content: message },
				],
			})) as { result?: { response?: string }; response?: string };

			const response = result.result?.response || result.response || "";
			const ts = new Date().toISOString();
			await this.ctx.storage.put(`msg:${ts}:u`, {
				role: "user",
				content: message,
			});
			await this.ctx.storage.put(`msg:${ts}:a`, {
				role: "assistant",
				content: response,
			});

			return new Response(
				JSON.stringify({ message: { role: "assistant", content: response } }),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		return new Response("Not found", { status: 404 });
	}
}

function callerAiCredentials(
	request: Request,
): { accountId: string; token: string } | null {
	const accountId = request.headers.get("X-CF-Account-ID")?.trim();
	const token = request.headers.get("X-CF-AI-Token")?.trim();
	if (!accountId || !token) return null;
	return { accountId, token };
}

function missingCredentials(): Response {
	return Response.json(
		{
			error: "caller_ai_credentials_required",
			message:
				"Pass your own Cloudflare Workers AI credentials with X-CF-Account-ID and X-CF-AI-Token. This agent will not spend the ProAgentStore Workers AI account.",
		},
		{ status: 402 },
	);
}

async function runCallerWorkersAi(
	credentials: { accountId: string; token: string },
	body: unknown,
): Promise<unknown> {
	const encodedModel = MODEL.split("/").map(encodeURIComponent).join("/");
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/run/${encodedModel}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		return { error: "caller_workers_ai_failed", status: res.status, details: data };
	}
	if (data && typeof data === "object" && "result" in data) {
		return (data as { result: unknown }).result;
	}
	return data;
}
