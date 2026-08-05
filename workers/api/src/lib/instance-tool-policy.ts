// Instance tool policy — the ONE answer to "what may this instance actually run?".
//
// Before this, `capabilities.tools` bounded the CHAT and nothing else. The generic invoker
// (`POST /v1/instances/:id/tools/:name`, and MCP `call_instance_tool` which proxies it)
// checked only that the caller owned the instance, then dispatched ANY tool in the registry.
// So a read-only agent was read-only in conversation while its instance could still be driven
// to `tmux_capture_pane` the owner's terminals or `sheets_read` their spreadsheets. "This agent
// is read-only" has to be a property of the INSTANCE, not of one surface's prompt-building.
//
// Two independent gates, both fail-closed, evaluated here so every surface shares them:
//
//   1. DECLARED — the agent's `capabilities.tools` allowlist (creator-side). A tool the agent
//      never declared is not part of it, no matter who asks.
//   2. DISABLED — the owner's per-instance off-switch (`config.disabledTools`). The subscriber's
//      veto over what their own copy may do, independent of what the creator declared.
//
// Write-consent (#90) is a THIRD, separate gate enforced in runRegistryTool. It is deliberately
// not merged here: consent answers "may this act on an external system as me", while this
// answers "is this tool part of this agent at all". A tool can be allowed here and still be
// refused there.
import { agentCapabilities, type AgentCapabilities } from "./agent-capabilities.js";
import { toolNamesFor } from "../agent-do-tools.js";
import { registryTools } from "./tool-registry.js";
import type { Env } from "../types.js";

/** Why a tool is or isn't runnable — surfaced to the UI/MCP so "blocked" is never a mystery. */
export type ToolPolicyReason = "ok" | "not_declared" | "disabled_by_owner";

export interface ToolPolicyEntry {
	name: string;
	connector?: string;
	scope: "read" | "write";
	description: string;
	jsonSchema: unknown;
	/** The final answer: may this instance run this tool right now? */
	allowed: boolean;
	/** True when the agent declares it but the owner switched it off. */
	disabled: boolean;
	reason: ToolPolicyReason;
}

/** Where the owner's per-instance off-switches live in `agent_instances.config`. */
export const DISABLED_TOOLS_KEY = "disabledTools";

/**
 * Resolve the policy for every registry tool. Pure — the caller supplies the agent's
 * capabilities and the owner's disabled list, so this is exhaustively testable and the two
 * gates can't drift between the chat runtime, the REST invoker and MCP.
 *
 * Returns EVERY tool, not just the allowed ones: "what can this agent do" is only answerable
 * if the answer includes what it can't, and why. Callers that want the old shape filter on
 * `.allowed`.
 */
export function resolveToolPolicy(
	capabilities: AgentCapabilities,
	disabledTools: readonly string[] = [],
	tools: ReadonlyArray<{ name: string; connector?: string; scope?: "read" | "write"; description: string; jsonSchema: unknown }> = registryTools(),
): ToolPolicyEntry[] {
	const declared = toolNamesFor(capabilities);
	const off = new Set(disabledTools);
	return tools.map((t) => {
		const isDeclared = declared.has(t.name);
		const disabled = off.has(t.name);
		const reason: ToolPolicyReason = !isDeclared ? "not_declared" : disabled ? "disabled_by_owner" : "ok";
		return {
			name: t.name,
			connector: t.connector,
			scope: t.scope ?? "read",
			description: t.description,
			jsonSchema: t.jsonSchema,
			allowed: isDeclared && !disabled,
			disabled,
			reason,
		};
	});
}

/** Human-readable refusal, so an API 403 and an agent's own error say the same thing. */
export function explainRefusal(name: string, reason: ToolPolicyReason): string {
	return reason === "disabled_by_owner"
		? `"${name}" is switched off for this agent. Turn it back on in the console (Settings → Tools) to use it.`
		: `"${name}" is not one of this agent's tools. It can only run the tools its agent declares.`;
}

/** Parse the owner's off-switch list out of an instance's config blob. Never throws. */
export function readDisabledTools(config: string | null | undefined): string[] {
	if (!config) return [];
	try {
		const cfg = JSON.parse(config) as Record<string, unknown>;
		const raw = cfg[DISABLED_TOOLS_KEY];
		return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

/**
 * The policy for one owned instance, resolving its agent's capabilities from D1.
 *
 * Fail-closed on a capability lookup miss is WRONG here and deliberately avoided: a missing
 * agent row means we can't prove the agent declared anything, and `agentCapabilities({})`
 * already returns the permissive default that the chat runtime uses. Diverging would make
 * this gate stricter than the chat for the same instance, which is a confusing failure. The
 * gate that matters for damage — write consent — is separately fail-closed.
 */
export async function instanceToolPolicy(
	env: Env,
	instanceId: string,
	userId: string,
	instanceConfig?: string | null,
): Promise<ToolPolicyEntry[]> {
	const row = await env.DB.prepare(
		"SELECT a.slug AS slug, a.category AS category, a.config AS config, i.config AS instance_config FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2",
	)
		.bind(instanceId, userId)
		.first<{ slug: string | null; category: string | null; config: string | null; instance_config: string | null }>();
	const capabilities = agentCapabilities(row ?? {});
	const disabled = readDisabledTools(instanceConfig !== undefined ? instanceConfig : row?.instance_config);
	return resolveToolPolicy(capabilities, disabled);
}
