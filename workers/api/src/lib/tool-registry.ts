// Connector tool registry (issue #85/#86). ONE definition per tool — name, schema,
// and handler — surfaced to the agent runtime (agent-think), the generic tool-call
// API (routes/tools), and (later) MCP, so a new connector is declared in one place
// instead of the current triple-definition. Additive: the legacy AGENT_TOOLS /
// STORAGE_TOOLS catalog is untouched; registry tools are dispatched alongside them.
import type { Env } from "../types.js";
import { GITHUB_TOOLS } from "./connectors/github.js";
import { TMUX_TOOLS } from "./connectors/tmux.js";
import { META_TOOLS } from "./connectors/meta.js";
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

/** A draft-07 JSON Schema for a tool's input — an object schema with typed properties. */
export interface JsonSchema {
	type: "object";
	properties: Record<string, { type: string; description?: string }>;
	required?: string[];
	[k: string]: unknown;
}

/**
 * The ONE tool definition shape (issue #85). A tool is declared once with its JSON
 * Schema and handler; the same def surfaces to the agent runtime (via
 * `registryToolDefs` → buildAgentToolDefinitions), the generic tool-call API
 * (routes/tools), and — later — MCP. `jsonSchema` is the source of truth for the tool's
 * inputs; the runtime passes it through verbatim (no more rebuilding from an ad-hoc map).
 */
export interface ToolDef {
	name: string;
	description: string;
	/** Draft-07 object schema for the tool's input. Passed to the LLM + validated on the API. */
	jsonSchema: JsonSchema;
	/** base = always granted · standard = creator-selectable · runtime = needs a local runner · connector = external system. */
	tier: "base" | "standard" | "runtime" | "connector";
	/** Which connector provides it (e.g. "github"). Present for connector-tier tools. */
	connector?: string;
	/** read = safe; write = mutates the external system (gated by consent, #90). */
	scope?: "read" | "write";
	handler: (ctx: RegistryToolCtx, input: Record<string, unknown>) => Promise<RegistryToolResult>;
}

/**
 * @deprecated Use {@link ToolDef}. Kept as an alias so existing connector modules that
 * annotate their arrays as `RegistryTool[]` keep compiling during the migration.
 */
export type RegistryTool = ToolDef;

// All connectors' tools, keyed by name. Add a connector = add its tools array here.
const REGISTRY: ReadonlyMap<string, ToolDef> = new Map(
	[...GITHUB_TOOLS, ...TMUX_TOOLS, ...META_TOOLS].map((t) => [t.name, t] as const),
);

export function getRegistryTool(name: string): ToolDef | undefined {
	return REGISTRY.get(name);
}

export function registryToolNameSet(): Set<string> {
	return new Set(REGISTRY.keys());
}

export function registryTools(): ToolDef[] {
	return [...REGISTRY.values()];
}

/**
 * Runtime tool definitions for buildAgentToolDefinitions. Pass-through of each tool's
 * `jsonSchema` (name/description/jsonSchema) — the schema the LLM sees is authored on
 * the ToolDef, not rebuilt from an ad-hoc parameters map. Back-compatible: the merged
 * output in buildAgentToolDefinitions is identical to before this refactor.
 */
export function registryToolDefs(): Array<{ name: string; description: string; jsonSchema: JsonSchema }> {
	return registryTools().map((t) => ({ name: t.name, description: t.description, jsonSchema: t.jsonSchema }));
}

/** Catalog groups (one per connector) so the tool catalog + creator-selectable set include them. */
export function registryConnectorGroups(): Array<{ connector: string; tools: string[] }> {
	const byConnector = new Map<string, string[]>();
	for (const t of REGISTRY.values()) {
		if (!t.connector) continue; // only connector-provided tools form catalog groups
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
	// for its connector. Fail-closed — no connector, no instance context, or no consent
	// → refused. (A write-scoped tool without a connector can't be consented to, so it's
	// unreachable rather than silently ungated.)
	if (tool.scope === "write") {
		if (!tool.connector || !(await hasConsent(ctx.env, ctx.instanceId, tool.connector, "write"))) {
			const label = tool.connector ?? "this";
			return {
				name,
				content: `Writing via the ${label} connector isn't permitted for this agent. Enable write access for ${label} in the instance's Connections settings, then try again.`,
				success: false,
			};
		}
	}
	try {
		const r = await tool.handler(ctx, input || {});
		return { name, content: r.content, success: r.success };
	} catch (err) {
		return { name, content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false };
	}
}
