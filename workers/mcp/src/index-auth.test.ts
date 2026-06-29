import { describe, expect, it, vi } from "vitest";

// Capture the options the worker passes to `new OAuthProvider(...)` so we can
// assert the security-critical wiring (which paths require a token, the PKCE
// policy, scopes, and token lifetime) without needing the Workers runtime.
const captured = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
	OAuthProvider: class {
		constructor(options: Record<string, unknown>) {
			captured.options = options;
		}
	},
}));

vi.mock("agents/mcp", () => ({
	// biome-ignore lint/complexity/noStaticOnlyClass: The mock must match the agents/mcp class API.
	McpAgent: class {
		static serve() {
			return {
				fetch: () => new Response("mock mcp transport"),
			};
		}
	},
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
	McpServer: class {
		tool() {
			/* test double */
		}
	},
}));

await import("./index.js");
const { loginHandler } = await import("./oauth-provider.js");

describe("OAuthProvider wiring", () => {
	it("protects only the /mcp API route with the MCP transport handler", () => {
		const options = captured.options;
		expect(options).toBeDefined();
		expect(options?.apiRoute).toBe("/mcp");
		// apiHandler is the MCP transport returned by PagsMcp.serve("/mcp").
		expect(typeof (options?.apiHandler as { fetch?: unknown })?.fetch).toBe(
			"function",
		);
	});

	it("delegates consent + login + landing to the login handler", () => {
		expect(captured.options?.defaultHandler).toBe(loginHandler);
	});

	it("configures the standard OAuth endpoints and DCR", () => {
		const options = captured.options;
		expect(options?.authorizeEndpoint).toBe("/authorize");
		expect(options?.tokenEndpoint).toBe("/token");
		expect(options?.clientRegistrationEndpoint).toBe("/register");
	});

	it("advertises the MCP safety scopes", () => {
		expect(captured.options?.scopesSupported).toEqual([
			"read",
			"write",
			"runtime",
			"destructive",
		]);
	});

	it("enforces OAuth 2.1 S256-only PKCE and the 24h access-token lifetime", () => {
		expect(captured.options?.allowPlainPKCE).toBe(false);
		expect(captured.options?.accessTokenTTL).toBe(86_400);
	});
});
