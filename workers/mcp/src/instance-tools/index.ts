// Instance-scoped MCP tools — split by group out of the old 2029-LOC monolith (#135), and
// again out of `base.ts` when that grew to 1871 lines and 67 tools (#305). This thin index
// just builds the shared ctx and registers each group; behaviour is identical (same tool
// names, schemas, handlers, surface gating, dispatch order-independent by tool name).
//
// The registrars below are the ONLY way a tool reaches the server, which is what lets
// `contract.test.ts` enumerate the whole instance surface and hold every tool to its scope,
// its confirmation string and its dry-run behaviour — the three properties a file move is
// most likely to lose, and the three nothing else checks.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpEnv } from "../http.js";
import { registerAccountTools } from "./account.js";
import { registerAgentAuthoringTools } from "./agent-authoring.js";
import { registerAgentTaskTools } from "./agent-tasks.js";
import { registerApplyTools } from "./apply.js";
import { registerBaseTools } from "./base.js";
import { registerBoardTools } from "./board.js";
import { registerCodingTools } from "./coding.js";
import { registerCompositionTools } from "./composition.js";
import { registerConnectorAccountTools, registerConnectorGrantTools } from "./connectors.js";
import { registerGuideTools } from "./guide.js";
import { registerKnowledgeTools } from "./knowledge.js";
import { registerMachineControlTools } from "./machine-control.js";
import { registerMcpConnectionTools } from "./mcp-connections.js";
import { registerObservabilityTools } from "./observability.js";
import { registerRecentTools } from "./recent.js";
import { registerRepoTools } from "./repo.js";
import { registerRuntimeTools } from "./runtime.js";
import { registerSettingsTools } from "./settings.js";
import type { InstanceToolsCtx, SafetyResolver, TokenResolver } from "./shared.js";
import { registerStatsTools } from "./stats.js";
import { registerTriggerTools } from "./triggers.js";

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
	// Ungated — every subscriber gets these, whatever agent they run.
	registerBaseTools(server, ctx);
	registerRuntimeTools(server, ctx);
	registerMachineControlTools(server, ctx);
	registerKnowledgeTools(server, ctx);
	registerObservabilityTools(server, ctx);
	// The per-instance connection guide (#772) — ungated: the discovery problem it solves
	// belongs to every agent type, not only the ones with a console surface.
	registerGuideTools(server, ctx);
	// "What was I working on?" (#787) — ungated for the same reason as the guide: the question
	// belongs to every agent type, and the run lookup answers for every instance.
	registerRecentTools(server, ctx);
	registerBoardTools(server, ctx);
	// The agent's OWN standing tasks — DO state rendered into its prompt, deliberately a
	// separate registrar from the runtime board above so the two task stores stay told apart.
	registerAgentTaskTools(server, ctx);
	// The creator side of an agent TEMPLATE, read as its owner (#613). Its own registrar rather
	// than joining `create_agent`/`update_agent` in index.ts: that file is the server bootstrap
	// and is pinned, and these six are one topic — what a creator authored, as opposed to what
	// the catalogue advertises. The contract table's group column is what keeps that seam visible.
	registerAgentAuthoringTools(server, ctx);
	registerSettingsTools(server, ctx);
	registerTriggerTools(server, ctx);
	registerCompositionTools(server, ctx);
	registerAccountTools(server, ctx);
	registerConnectorGrantTools(server, ctx);
	// Which of the owner's accounts an instance uses on a multi-account connector (#736).
	registerConnectorAccountTools(server, ctx);
	// PAGS as an MCP CLIENT — the outbound connections an instance makes to someone else's
	// server. Ungated: an outbound connection is config on any instance, not a console surface.
	registerMcpConnectionTools(server, ctx);
	registerApplyTools(server, ctx);
	registerRepoTools(server, ctx);
	registerCodingTools(server, ctx);
	// Ungated, like base: every instance can have stats cards (#312).
	registerStatsTools(server, ctx);
}
