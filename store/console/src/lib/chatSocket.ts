import { API, api } from "@proagentstore/sdk/client";

/**
 * Opening an agent's chat WebSocket, the only way the console is allowed to (#317).
 *
 * The browser `WebSocket` constructor takes no headers, so the credential has to ride
 * in the URL — and a URL is the least private part of a request: it lands in browser
 * history, in `Referer` on the next navigation, in proxy and CDN access logs, and in
 * anything that screenshots or shares a link. The account session must therefore never
 * be the thing that goes there. It stays in the `Authorization` header of the mint call
 * below; only a token good for THIS agent, for minutes, reaches the URL.
 *
 * The mint happens per connect, not once per page: a laptop that slept for an hour
 * reconnects with a fresh token rather than a stale one, and a suspension or a
 * transferred agent takes effect at the next reconnect instead of never.
 */

/** Build the `wss://` upgrade URL. Pure — the token is supplied, never read from storage. */
export function chatSocketUrl(apiBase: string, agentId: string, token: string): string {
	const url = new URL(`${apiBase.replace(/\/$/, "")}/v1/agents/${encodeURIComponent(agentId)}/ws`);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	url.searchParams.set("token", token);
	return url.toString();
}

/** Mint a fresh, agent-scoped chat token and open the socket with it. */
export async function openAgentChatSocket(agentId: string): Promise<WebSocket> {
	const { token } = await api<{ token: string; expiresAt: string }>(
		`/v1/agents/${encodeURIComponent(agentId)}/ws-token`,
		{ method: "POST" },
	);
	return new WebSocket(chatSocketUrl(API, agentId, token));
}
