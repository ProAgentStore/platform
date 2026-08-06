// Instance-scoped MCP tools — split by group out of the old 2029-LOC monolith (#135). This
// thin index just builds the shared ctx and registers each group; behaviour is identical (same
// tool names, schemas, handlers, surface gating, dispatch order-independent by tool name).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpEnv } from "../http.js";
import { registerApplyTools } from "./apply.js";
import { registerBaseTools } from "./base.js";
import { registerConnectorGrantTools } from "./connectors.js";
import { registerCodingTools } from "./coding.js";
import { registerRepoTools } from "./repo.js";
import { registerStatsTools } from "./stats.js";
import type { InstanceToolsCtx, SafetyResolver, TokenResolver } from "./shared.js";

export function registerInstanceTools(
	server: McpServer,
	env: McpEnv,
	tokenFor: TokenResolver,
	safetyFor: SafetyResolver,
	/** The console-surface groups the connected user's subscribed agents expose —
	 *  agent-specific tools are gated to these so a user only sees tools for the
	 *  agents they actually have (e.g. a Repo Chat user never sees apply_to_job). */
	groups: Set<string>,
): void {
	const ctx: InstanceToolsCtx = { env, tokenFor, safetyFor, groups };
	registerBaseTools(server, ctx);
	registerConnectorGrantTools(server, ctx);
	registerApplyTools(server, ctx);
	registerRepoTools(server, ctx);
	registerCodingTools(server, ctx);
	// Ungated, like base: every instance can have stats cards (#312).
	registerStatsTools(server, ctx);
}
