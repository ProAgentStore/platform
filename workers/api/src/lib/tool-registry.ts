// Connector tool registry (issue #85/#86). ONE definition per tool — name, schema,
// and handler — surfaced to the agent runtime (agent-think), the generic tool-call
// API (routes/tools), and (later) MCP, so a new connector is declared in one place
// instead of the current triple-definition. Additive: the legacy AGENT_TOOLS /
// STORAGE_TOOLS catalog is untouched; registry tools are dispatched alongside them.
import type { Env } from "../types.js";
import { GITHUB_TOOLS } from "./connectors/github.js";
import { hasConsent } from "./connector-consent.js";

export interface RegistryToolCtx {
	env: Env;
	userId?: string;
	agentId?: string;
	instanceId?: string;
}

export interface RegistryToolResult {
	content: string;
	success: boolean;
}

export interface RegistryTool {
	name: string;
	/** Which connector provides it (e.g. "github"). */
	connector: string;
	/** read = safe; write = mutates the external system (gated by consent later, #90). */
	scope: "read" | "write";
	description: string;
	/** JSON-schema-ish params, same shape as ToolDef.parameters. */
	parameters: Record<string, { type: string; description: string; required?: boolean }>;
	handler: (ctx: RegistryToolCtx, input: Record<string, unknown>) => Promise<RegistryToolResult>;
}

// All connectors' tools, keyed by name. Add a connector = add its tools array here.
const REGISTRY: ReadonlyMap<string, RegistryTool> = new Map(
	[...GITHUB_TOOLS].map((t) => [t.name, t] as const),
);

export function getRegistryTool(name: string): RegistryTool | undefined {
	return REGISTRY.get(name);
}

export function registryToolNameSet(): Set<string> {
	return new Set(REGISTRY.keys());
}

export function registryTools(): RegistryTool[] {
	return [...REGISTRY.values()];
}

/** ToolDef-shaped entries for buildAgentToolDefinitions (name, description, parameters). */
export function registryToolDefs(): Array<{ name: string; description: string; parameters: RegistryTool["parameters"] }> {
	return registryTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/** Catalog groups (one per connector) so the tool catalog + creator-selectable set include them. */
export function registryConnectorGroups(): Array<{ connector: string; tools: string[] }> {
	const byConnector = new Map<string, string[]>();
	for (const t of REGISTRY.values()) {
		const arr = byConnector.get(t.connector) ?? [];
		arr.push(t.name);
		byConnector.set(t.connector, arr);
	}
	return [...byConnector.entries()].map(([connector, tools]) => ({ connector, tools }));
}

/** Run a registry tool, wrapping errors into a ToolCallResult-compatible shape. */
export async function runRegistryTool(
	name: string,
	ctx: RegistryToolCtx,
	input: Record<string, unknown>,
): Promise<{ name: string; content: string; success: boolean }> {
	const tool = REGISTRY.get(name);
	if (!tool) return { name, content: `Unknown tool: ${name}`, success: false };
	// Write-consent gate (issue #90): a write tool needs explicit per-instance consent
	// for its connector. Fail-closed — no instance context or no consent → refused.
	if (tool.scope === "write" && !(await hasConsent(ctx.env, ctx.instanceId, tool.connector, "write"))) {
		return {
			name,
			content: `Writing via the ${tool.connector} connector isn't permitted for this agent. Enable write access for ${tool.connector} in the instance's Connections settings, then try again.`,
			success: false,
		};
	}
	try {
		const r = await tool.handler(ctx, input || {});
		return { name, content: r.content, success: r.success };
	} catch (err) {
		return { name, content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false };
	}
}
