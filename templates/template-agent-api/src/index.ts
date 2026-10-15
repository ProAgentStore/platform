/**
 * AGENTNAME — a stateless ProAgentStore API tool.
 *
 * Receives input, processes it with caller-owned Workers AI credentials, and
 * returns the result. No state, no memory, no conversation.
 */
import { Hono } from "hono";

type Env = Record<string, never>;

const MODEL = "@cf/meta/llama-3.2-3b-instruct";
const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
	c.json({
		agent: "AGENTNAME",
		type: "api",
		status: "ok",
		aiBilling: "caller-provided",
		requiredHeaders: ["X-CF-Account-ID", "X-CF-AI-Token"],
	}),
);

app.post("/run", async (c) => {
	const credentials = callerAiCredentials(c.req.raw);
	if (!credentials) {
		return c.json(
			{
				error: "caller_ai_credentials_required",
				message:
					"Pass your own Cloudflare Workers AI credentials with X-CF-Account-ID and X-CF-AI-Token. This agent will not spend the ProAgentStore Workers AI account.",
			},
			402,
		);
	}

	const { input } = await c.req.json<{ input: string }>();
	if (!input) return c.json({ error: "input required" }, 400);

	try {
		const result = await runCallerWorkersAi(credentials, {
			messages: [
				{
					role: "system",
					content: "You are a helpful tool. Process the input and return a result.",
				},
				{ role: "user", content: input },
			],
		});
		return c.json({ result });
	} catch (err) {
		if (err instanceof UpstreamAiError) return upstreamFailure(err);
		throw err;
	}
});

function callerAiCredentials(
	request: Request,
): { accountId: string; token: string } | null {
	const accountId = request.headers.get("X-CF-Account-ID")?.trim();
	const token = request.headers.get("X-CF-AI-Token")?.trim();
	if (!accountId || !token) return null;
	return { accountId, token };
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

export default app;
