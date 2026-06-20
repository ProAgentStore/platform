import { describe, expect, it } from "vitest";
import { createAuthChallenge, handleOAuthRoute, resolveOAuthToken } from "./oauth-provider.js";

function makeKv(seed: Record<string, string> = {}): KVNamespace {
	const data = new Map(Object.entries(seed));
	return {
		get: async (key: string) => data.get(key) ?? null,
		put: async (key: string, value: string) => {
			data.set(key, value);
		},
		delete: async (key: string) => {
			data.delete(key);
		},
	} as unknown as KVNamespace;
}

const config = (kv = makeKv()) => ({
	issuer: "https://mcp.proagentstore.online",
	authStart: "https://api.freeappstore.online/v1/auth/github/start",
	apiBase: "https://api.proagentstore.online",
	kv,
	sessionSigningKey: "test-key",
});

describe("createAuthChallenge", () => {
	it("returns an MCP OAuth protected-resource challenge", () => {
		const res = createAuthChallenge({
			issuer: "https://mcp.proagentstore.online",
		});

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBe(
			'Bearer resource_metadata="https://mcp.proagentstore.online/.well-known/oauth-protected-resource/mcp"',
		);
	});

	it("can mark invalid bearer tokens", () => {
		const res = createAuthChallenge(
			{ issuer: "https://mcp.proagentstore.online" },
			"invalid_token",
		);

		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error="invalid_token"',
		);
	});
});

describe("handleOAuthRoute", () => {
	it("serves protected resource metadata for the MCP endpoint", async () => {
		const res = await handleOAuthRoute(
			new Request(
				"https://mcp.proagentstore.online/.well-known/oauth-protected-resource/mcp",
			),
			config(),
		);

		expect(res?.status).toBe(200);
		await expect(res?.json()).resolves.toEqual({
			resource: "https://mcp.proagentstore.online/mcp",
			authorization_servers: ["https://mcp.proagentstore.online"],
		});
	});

	it("serves authorization server metadata", async () => {
		const res = await handleOAuthRoute(
			new Request(
				"https://mcp.proagentstore.online/.well-known/oauth-authorization-server",
			),
			config(),
		);

		expect(res?.status).toBe(200);
		const body = (await res?.json()) as Record<string, unknown>;
		expect(body.issuer).toBe("https://mcp.proagentstore.online");
		expect(body.authorization_endpoint).toBe(
			"https://mcp.proagentstore.online/authorize",
		);
		expect(body.registration_endpoint).toBe(
			"https://mcp.proagentstore.online/register",
		);
		expect(body.scopes_supported).toEqual([
			"read",
			"write",
			"runtime",
			"destructive",
		]);
	});

	it("registers dynamic MCP clients", async () => {
		const res = await handleOAuthRoute(
			new Request("https://mcp.proagentstore.online/register", {
				method: "POST",
				body: JSON.stringify({
					redirect_uris: ["http://127.0.0.1:9876/callback"],
					client_name: "Codex",
				}),
			}),
			config(),
		);

		expect(res?.status).toBe(201);
		const body = (await res?.json()) as Record<string, unknown>;
		expect(body.client_id).toBeTruthy();
		expect(body.token_endpoint_auth_method).toBe("none");
	});

	it("shows a browser confirmation page before redirecting to FAS auth", async () => {
		const kv = makeKv({
			"client:client-1": JSON.stringify({
				redirect_uris: ["http://127.0.0.1:9876/callback"],
				client_name: "Codex",
			}),
		});

		const res = await handleOAuthRoute(
			new Request(
				"https://mcp.proagentstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=abc&code_challenge_method=S256",
			),
			config(kv),
		);

		expect(res?.status).toBe(200);
			expect(res?.headers.get("Set-Cookie")).toContain(
				"pags_mcp_oauth_inflight=1",
			);
			if (!res) throw new Error("Expected OAuth response");
			const html = await res.text();
		expect(html).toContain("Connect ProAgentStore MCP");
		expect(html).toContain("Codex wants to use ProAgentStore MCP tools");
		expect(html).toContain("/authorize/continue?nonce=");
	});

	it("redirects to FAS OAuth after the user continues", async () => {
		const kv = makeKv({
			"authreq:nonce-1": JSON.stringify({
				clientId: "client-1",
				redirectUri: "http://127.0.0.1:9876/callback",
				codeChallenge: "abc",
				state: null,
			}),
		});

		const res = await handleOAuthRoute(
			new Request(
				"https://mcp.proagentstore.online/authorize/continue?nonce=nonce-1",
			),
			config(kv),
		);

		expect(res?.status).toBe(302);
		expect(res?.headers.get("Location")).toContain(
			"https://api.freeappstore.online/v1/auth/github/start",
		);
		expect(res?.headers.get("Location")).toContain("app_id=pags-mcp");
		expect(res?.headers.get("Location")).toContain("response_mode=query");
	});

	it("resolves scoped OAuth access tokens", async () => {
		const kv = makeKv({
			"token:access-1": JSON.stringify({
				session: "pags-session",
				scopes: ["read", "runtime"],
			}),
		});

		await expect(resolveOAuthToken("access-1", kv)).resolves.toEqual({
			session: "pags-session",
			scopes: ["read", "runtime"],
		});
	});

	it("keeps compatibility with legacy token values", async () => {
		const kv = makeKv({ "token:legacy": "pags-session" });

		await expect(resolveOAuthToken("legacy", kv)).resolves.toEqual({
			session: "pags-session",
			scopes: ["read", "write", "runtime", "destructive"],
		});
	});
});
