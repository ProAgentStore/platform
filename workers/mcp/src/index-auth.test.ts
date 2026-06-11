import { describe, expect, it, vi } from "vitest";

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

const { default: worker } = await import("./index.js");

const env = {
	API_BASE: "https://api.proagentstore.online",
	AUTH_START: "https://api.freeappstore.online/v1/auth/github/start",
	OAUTH_KV: {} as KVNamespace,
	SESSION_SIGNING_KEY: "test-key",
};

const ctx = {} as ExecutionContext;

describe("MCP transport auth", () => {
	it("challenges unauthenticated MCP transport requests", async () => {
		const res = await worker.fetch(
			new Request("https://mcp.proagentstore.online/mcp"),
			env,
			ctx,
		);

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBe(
			'Bearer resource_metadata="https://mcp.proagentstore.online/.well-known/oauth-protected-resource/mcp"',
		);
	});

	it("keeps the landing page unauthenticated", async () => {
		const res = await worker.fetch(
			new Request("https://mcp.proagentstore.online/"),
			env,
			ctx,
		);

		expect(res.status).toBe(200);
		await expect(res.text()).resolves.toContain("ProAgentStore MCP Server");
	});

	it("reports the current MCP tool count in health metadata", async () => {
		const res = await worker.fetch(
			new Request("https://mcp.proagentstore.online/health"),
			env,
			ctx,
		);

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			ok: true,
			service: "proagentstore-mcp",
			tools: 26,
		});
	});
});
