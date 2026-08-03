// Connector tool registry (issue #85/#86). ONE definition per tool — name, schema,
// and handler — surfaced to the agent runtime (agent-think), the generic tool-call
// API (routes/tools), and (later) MCP, so a new connector is declared in one place
// instead of the current triple-definition. Additive: the legacy AGENT_TOOLS /
// STORAGE_TOOLS catalog is untouched; registry tools are dispatched alongside them.
import type { Env } from "../types.js";
import { connectorTools, getConnector } from "./connectors/registry.js";
import { connectorClient, type ConnectorClient } from "./connectors/client.js";
import { hasConsent } from "./connector-consent.js";
import { STEP_TOOLS } from "./steps.js";

export interface RegistryToolCtx {
	env: Env;
	userId?: string;
	agentId?: string;
	instanceId?: string;
	/**
	 * The run this tool call belongs to (a pipeline run id). Carried so a step that emits an
	 * agent-to-agent event can stamp the emitting run onto the delivery — choreography is
	 * otherwise undebuggable, because nothing links the source run to the run it set off.
	 */
	traceId?: string;
	/**
	 * The connector client factory (issue #86) — handlers call
	 * `ctx.connectorClient(provider)` to mint the provider's token and enforce
	 * grant/scope, instead of importing token-minting fns directly. Injected by
	 * runRegistryTool; optional so tests can construct a ctx without it.
	 */
	connectorClient?: (provider: string) => ConnectorClient;
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

/**
 * First-party registry tools that are NOT provided by a connector (base/standard/runtime
 * tiers). `run_pipeline` (issue #97) lets an agent start a declarative pipeline the owner
 * has declared on the instance ("sweep Sydney" → run the `leads` pipeline with city=Sydney).
 */
const FIRST_PARTY_TOOLS: ToolDef[] = [
	{
		name: "run_pipeline",
		description:
			"Run a declarative data pipeline that the owner has configured on this agent. Pass the pipeline `name` and any `params` (e.g. {city:\"Sydney\"}). The pipeline runs durably in the background (source → transform → sink); it does not return results inline — tell the user it's started.",
		tier: "base",
		jsonSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Name of a pipeline configured on this instance." },
				params: { type: "object", description: "Run parameters passed to the pipeline (JSON object)." },
			},
			required: ["name"],
		},
		handler: async (ctx, input) => {
			if (!ctx.instanceId || !ctx.userId) return { content: "run_pipeline needs an owned instance context.", success: false };
			const name = String(input.name ?? "");
			if (!name) return { content: "Pipeline name is required.", success: false };
			const params = (input.params && typeof input.params === "object" && !Array.isArray(input.params) ? input.params : {}) as Record<string, unknown>;
			// Deferred import avoids a cycle (pipeline.ts imports this module for the registry).
			const { startPipelineRun } = await import("./pipeline-run-start.js");
			const started = await startPipelineRun(ctx.env, ctx.instanceId, ctx.userId, name, params, "chat");
			if (!started.ok) return { content: started.error, success: false };
			return { content: `Started pipeline "${name}" (run ${started.runId}). It runs in the background; check the trace/board for progress.`, success: true };
		},
	},
	{
		name: "create_ticket",
		description:
			"Put a ticket on the board asking the owner to approve a piece of work. Give it a `title`, the `reasoning` (the WHY, shown on the card), and optionally the work itself — `action` (run_pipeline / insert_record / add_knowledge / create_task / run_browse) with its `config` and `params`. A ticket carrying an action sits in Needs-approval until the owner approves it, and approving RUNS exactly that action. Use this to pause for a human decision before doing something consequential; without an action it's an informational card.",
		tier: "base",
		jsonSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short card title, e.g. \"Deploy the site for Palm Tree Kiosk\"." },
				reasoning: { type: "string", description: "Why this is being asked — rendered on the card so the decision is informed." },
				description: { type: "string", description: "Optional longer detail." },
				action: { type: "string", description: "Work to run on approval: run_pipeline | insert_record | add_knowledge | create_task | run_browse. Omit for an informational ticket." },
				config: { type: "object", description: "Action config, e.g. {pipeline:\"site-deploy\"} for run_pipeline." },
				params: { type: "object", description: "Payload handed to the action (the run params for run_pipeline)." },
			},
			required: ["title"],
		},
		handler: async (ctx, input) => {
			if (!ctx.instanceId || !ctx.userId) return { content: "create_ticket needs an owned instance context.", success: false };
			const title = String(input.title ?? "").trim();
			if (!title) return { content: "Ticket title is required.", success: false };
			// Deferred import keeps this module free of the routes/board import graph.
			const { buildTicketAction, validateTicketAction } = await import("./actionable-ticket.js");
			const invalid = validateTicketAction(input.action, input.config, input.params);
			if (invalid) return { content: invalid, success: false };
			const action = input.action ? buildTicketAction(String(input.action), input.config, input.params) : null;
			const now = new Date().toISOString();
			const task = {
				id: crypto.randomUUID(),
				type: "ticket",
				status: action ? "needs_approval" : "completed",
				title: title.slice(0, 200),
				description: typeof input.description === "string" ? input.description.slice(0, 2000) : "",
				reasoning: typeof input.reasoning === "string" ? input.reasoning.slice(0, 8000) : "",
				...(action ? { action } : {}),
				createdAt: now,
				updatedAt: now,
			};
			const { mirrorRuntimeTask } = await import("../routes/instances-runtime.js");
			await mirrorRuntimeTask(ctx.env, ctx.instanceId, ctx.userId, task);
			return {
				content: JSON.stringify({ ticketId: task.id, status: task.status, awaitingApproval: !!action }, null, 2),
				success: true,
			};
		},
	},
	// Core pipeline step library (issue #96): map / filter / dedupe_upsert / fan_out /
	// http_reachable / geocode — standard-tier, composed by the pipeline runner (#97).
	...STEP_TOOLS,
];

// The tool REGISTRY, keyed by name: every connector's tools (flattened from the connector
// registry, with connector/tier/scope stamped) plus first-party tools. Add a connector =
// add it to CONNECTORS in connectors/registry.ts.
const REGISTRY: ReadonlyMap<string, ToolDef> = new Map(
	[...connectorTools(), ...FIRST_PARTY_TOOLS].map((t) => [t.name, t] as const),
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
	// Scope enforcement (issue #86): a write-scoped tool on a read-only connector is
	// unreachable — reject before consent/handler so the abstraction can't be bypassed.
	if (tool.scope === "write" && tool.connector) {
		const conn = getConnector(tool.connector);
		if (conn && !conn.scopes.write) {
			return { name, content: `The ${conn.id} connector is read-only — "${name}" cannot run.`, success: false };
		}
	}
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
		// Inject the connector-client factory so handlers mint tokens + enforce grant/scope
		// through the ONE path (issue #86) instead of importing token fns directly.
		const handlerCtx: RegistryToolCtx = {
			...ctx,
			connectorClient: ctx.connectorClient ?? ((provider: string) => connectorClient(ctx.env, provider, { userId: ctx.userId, instanceId: ctx.instanceId })),
		};
		const r = await tool.handler(handlerCtx, input || {});
		return { name, content: r.content, success: r.success };
	} catch (err) {
		return { name, content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false };
	}
}
