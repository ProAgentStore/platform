import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { jsonText, type McpEnv } from "../http.js";
import { MCP_SERVER_VERSION } from "../server-version.js";
import { SURFACE_LOCK } from "../surface-lock.js";
import { MCP_TOOL_COUNT } from "../tool-count.js";

/** Build variables are optional: Workers without process support still report the wire version. */
export function serverInfo(bindings: Pick<McpEnv, "GIT_COMMIT_SHA" | "CF_PAGES_COMMIT_SHA" | "DEPLOY_TIMESTAMP"> = {}) {
	const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
	const env = { ...runtime.process?.env, ...bindings };
	return {
		server_name: "ProAgentStore",
		server_version: MCP_SERVER_VERSION,
		mcp_protocol_version: LATEST_PROTOCOL_VERSION,
		tool_count: MCP_TOOL_COUNT,
		build_commit: env.GIT_COMMIT_SHA || env.CF_PAGES_COMMIT_SHA || "unknown",
		schema_revision: SURFACE_LOCK[MCP_SERVER_VERSION],
		deployed_at: env.DEPLOY_TIMESTAMP || "unknown",
	};
}

export function registerServerInfoTool(server: McpServer, env: McpEnv = {}): void {
	server.tool(
		"mcp_server_info",
		"Read this MCP server's identity, version, latest supported protocol version, optional build metadata, and deterministic platform tool-schema revision. tool_count and schema_revision describe the full platform catalog, not this connection's subscription or pinned subset. No account or network lookup.",
		{},
		async () => jsonText(serverInfo(env)),
	);
}
