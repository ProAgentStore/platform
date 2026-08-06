import { apiBase, type McpEnv, text, type TextResult } from "./http.js";

/**
 * Operator suspension, enforced on the MCP surface (#273).
 *
 * `users.suspended` (#34) is enforced on the API in `requireUser`, and MOST MCP tools
 * inherit that for free because they proxy to the API with the user's own session JWT.
 * The exception was the tool family that talks to GitHub directly with the worker's own
 * `GITHUB_TOKEN` (scaffold / repo files / deploy): those never touch the API, so a
 * suspended account could still drive them. `agent_deploy_status` did not even take a
 * token. The rest were covered only ACCIDENTALLY — via the `ownsAgent()` call that
 * happens to hit `/v1/agents/my/agents` first — which is not a gate, it is a
 * coincidence that the next tool is free to break.
 *
 * So the check is asked ONCE per tool call, from the registration wrapper in index.ts,
 * rather than written into each handler: a per-handler line is exactly how this hole
 * appeared, and it would reappear with the next tool added.
 *
 * The answer comes from `GET /v1/auth/me` rather than a local rule: "suspended" then
 * has exactly one definition, on the API, and this worker needs no D1 binding and no
 * new endpoint. It is deliberately NOT cached — a TTL is precisely what stops a kill
 * switch from killing anything, and the API's own `isSuspended` made the same call.
 *
 * FAILS OPEN, matching that gate: a network blip or an API 5xx must not take the whole
 * MCP surface down. Only an explicit 403 blocks, because on `/v1/auth/me` a 403 can
 * only come from the suspension check (an invalid token is 401, an unknown user 404).
 */
export async function suspensionBlock(
	env: McpEnv,
	token: string | null,
	tool: string,
): Promise<TextResult | null> {
	// No identity on the call (public tools like agent_info on an unauthenticated
	// connection) → there is no account to suspend, so there is nothing to gate.
	if (!token) return null;
	let status: number;
	try {
		const res = await fetch(`${apiBase(env)}/v1/auth/me`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		status = res.status;
	} catch {
		return null; // unreachable API → fail open
	}
	if (status !== 403) return null;
	return text(
		`Error: ${tool} is unavailable — this ProAgentStore account is suspended. Contact support if you believe this is a mistake.`,
	);
}
