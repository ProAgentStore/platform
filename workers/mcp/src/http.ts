const API = "https://api.proagentstore.online";

export type McpEnv = {
	API_BASE?: string;
	AUTH_START?: string;
	GITHUB_ORG?: string;
	GITHUB_TOKEN?: string;
	MCP_READ_ONLY?: string;
	OAUTH_KV?: KVNamespace;
	SESSION_SIGNING_KEY?: string;
};

export type TextResult = { content: { type: "text"; text: string }[] };

export const text = (value: string): TextResult => ({
	content: [{ type: "text" as const, text: value }],
});

export function authRequired(): TextResult {
	return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
}

export function jsonText(value: unknown): TextResult {
	return text(JSON.stringify(value, null, 2));
}

export function apiBase(env?: McpEnv): string {
	return env?.API_BASE || API;
}

export async function apiCall(
	path: string,
	opts?: RequestInit,
	env?: McpEnv,
): Promise<unknown> {
	const res = await fetch(`${apiBase(env)}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", ...opts?.headers },
	});
	const raw = await res.text();
	let json: unknown = {};
	try {
		json = raw ? JSON.parse(raw) : {};
	} catch {
		json = { raw };
	}
	// Never let a non-2xx pass as success — always return a visible error object,
	// whatever the body shape, so a tool can't silently format a failure as a result.
	if (!res.ok) {
		return typeof json === "object" && json !== null
			? { error: `API ${res.status}`, ...json }
			: { error: `API ${res.status}`, detail: json };
	}
	return json;
}

export async function authedCall(
	path: string,
	token: string,
	opts?: RequestInit,
	env?: McpEnv,
): Promise<unknown> {
	return apiCall(path, {
		...opts,
		headers: { Authorization: `Bearer ${token}`, ...opts?.headers },
	}, env);
}
