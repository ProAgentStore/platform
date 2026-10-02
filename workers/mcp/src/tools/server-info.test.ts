import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_VERSION } from "../server-version.js";
import { SURFACE_LOCK } from "../surface-lock.js";
import { MCP_TOOL_COUNT } from "../tool-count.js";
import { installRegistrationPipeline, type RegistrationTarget } from "../registration.js";
import { annotationsFor } from "../tool-metadata.js";
import { registerServerInfoTool, serverInfo } from "./server-info.js";

afterEach(() => vi.unstubAllGlobals());

describe("mcp_server_info", () => {
	it("reports platform schema and protocol metadata even without a process global", () => {
		vi.stubGlobal("process", undefined);
		expect(serverInfo()).toEqual({
			server_name: "ProAgentStore",
			server_version: MCP_SERVER_VERSION,
			mcp_protocol_version: LATEST_PROTOCOL_VERSION,
			tool_count: MCP_TOOL_COUNT,
			build_commit: "unknown",
			schema_revision: SURFACE_LOCK[MCP_SERVER_VERSION],
			deployed_at: "unknown",
		});
		expect(serverInfo().schema_revision).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("prefers the explicit build commit and reports deployment timestamp", () => {
		vi.stubGlobal("process", { env: { GIT_COMMIT_SHA: "git-sha", CF_PAGES_COMMIT_SHA: "pages-sha", DEPLOY_TIMESTAMP: "2026-10-03T00:00:00Z" } });
		expect(serverInfo().build_commit).toBe("git-sha");
		expect(serverInfo().deployed_at).toBe("2026-10-03T00:00:00Z");
	});

	it("uses Worker bindings before process metadata", () => {
		vi.stubGlobal("process", { env: { GIT_COMMIT_SHA: "process-sha" } });
		expect(serverInfo({ GIT_COMMIT_SHA: "worker-sha", DEPLOY_TIMESTAMP: "worker-time" })).toMatchObject({ build_commit: "worker-sha", deployed_at: "worker-time" });
	});

	it("falls back to Pages commit or unknown for absent/empty build variables", () => {
		vi.stubGlobal("process", { env: { GIT_COMMIT_SHA: "", CF_PAGES_COMMIT_SHA: "pages-sha" } });
		expect(serverInfo().build_commit).toBe("pages-sha");
		vi.stubGlobal("process", { env: {} });
		expect(serverInfo().build_commit).toBe("unknown");
		expect(serverInfo().deployed_at).toBe("unknown");
	});

	it("is discoverable with empty inputs and read-only annotations through the registration pipeline", async () => {
		const server = new McpServer({ name: "test", version: "1" });
		installRegistrationPipeline(server as unknown as RegistrationTarget, {
			gate: async () => null,
			metadata: (name) => ({ annotations: annotationsFor(name) }),
		});
		const env = { GIT_COMMIT_SHA: "registered-worker-sha", DEPLOY_TIMESTAMP: "worker-time" };
		registerServerInfoTool(server, env);
		const client = new Client({ name: "test", version: "1" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
			const { tools } = await client.listTools();
			expect(tools).toHaveLength(1);
			expect(tools[0].name).toBe("mcp_server_info");
			expect(tools[0].inputSchema.properties).toEqual({});
			expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
			const result = await client.callTool({ name: "mcp_server_info", arguments: {} });
			expect(result.structuredContent).toBeUndefined();
			expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(serverInfo(env));
		} finally {
			await client.close();
			await server.close();
		}
	});
});
