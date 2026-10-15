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

			// A failed or empty upstream reply is a 502 — and NOTHING is stored: an empty assistant turn
			// in history would be read back to the model as something it said.
			let response: string;
			try {
				response = await runCallerWorkersAi(credentials, {
					messages: [
						{ role: "system", content: SYSTEM_PROMPT },
						...messages,
						{ role: "user", content: message },
					],
				});
			} catch (err) {
				if (err instanceof UpstreamAiError) return upstreamFailure(err);
				throw err;
			}
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

/**
 * Workers AI refused the call, or answered with nothing. Carries the upstream HTTP status only —
 * never the upstream body, which can echo the caller's own account details back.
 */
class UpstreamAiError extends Error {
	constructor(readonly upstreamStatus: number, reason: string) {
		super(`Workers AI ${reason} (HTTP ${upstreamStatus})`);
		this.name = "UpstreamAiError";
	}
}

/**
 * Run the model on the CALLER's Workers AI account and return its reply text. Throws
 * `UpstreamAiError` when the call fails or the reply is empty: an upstream failure is never an empty
 * success, so the caller can answer it with a non-2xx status (and the platform's caller can see it).
 */
async function runCallerWorkersAi(
	credentials: { accountId: string; token: string },
	body: unknown,
): Promise<string> {
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
	if (!res.ok) throw new UpstreamAiError(res.status, "refused the call");
	const data = (await res.json().catch(() => ({}))) as { result?: { response?: unknown }; response?: unknown };
	const reply = data.result?.response ?? data.response;
	if (typeof reply !== "string" || !reply.trim()) throw new UpstreamAiError(res.status, "returned an empty reply");
	return reply;
}

/**
 * The answer to an upstream failure: 502 with the upstream status, and one log line (`wrangler tail`
 * / Workers Logs). This template has no platform error log of its own — report from here to your own
 * sink (Sentry, a webhook, a D1 table) if you want these kept.
 */
function upstreamFailure(err: UpstreamAiError): Response {
	console.error(JSON.stringify({ event: "upstream_ai_failed", upstreamStatus: err.upstreamStatus, message: err.message }));
	return new Response(JSON.stringify({ error: "upstream_ai_failed", message: err.message, upstreamStatus: err.upstreamStatus }), {
		status: 502,
		headers: { "Content-Type": "application/json" },
	});
}
