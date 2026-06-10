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

	const result = (await runCallerWorkersAi(credentials, {
		messages: [
			{
				role: "system",
				content: "You are a helpful tool. Process the input and return a result.",
			},
			{ role: "user", content: input },
		],
	})) as { result?: { response?: string }; response?: string };

	return c.json({ result: result.result?.response || result.response || "" });
});

function callerAiCredentials(
	request: Request,
): { accountId: string; token: string } | null {
	const accountId = request.headers.get("X-CF-Account-ID")?.trim();
	const token = request.headers.get("X-CF-AI-Token")?.trim();
	if (!accountId || !token) return null;
	return { accountId, token };
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

export default app;
