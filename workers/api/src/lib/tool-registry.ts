// Connector tool registry (issue #85/#86). ONE definition per tool — name, schema,
// and handler — surfaced to the agent runtime (agent-think), the generic tool-call
// API (routes/tools), and (later) MCP, so a new connector is declared in one place
// instead of the current triple-definition. Additive: the legacy AGENT_TOOLS /
// STORAGE_TOOLS catalog is untouched; registry tools are dispatched alongside them.
import { consentInstanceOf, describeAuthority, isDelegated } from "./execution-authority.js";
import { logEvent } from "./events.js";
import { connectorTools, getConnector } from "./connectors/registry.js";
import { connectorClient } from "./connectors/client.js";
import type { JsonSchema, RegistryTool, RegistryToolCtx, RegistryToolResult, ToolDef } from "./connectors/types.js";
import { hasConsent } from "./connector-consent.js";
import { undeclaredToolRefusal } from "./tool-refusal.js";
import { STEP_TOOLS } from "./steps.js";
import { DEFAULT_LOOP_DRIVER, loopDriverFor } from "./loop-drivers.js";
import { getLoopRun, listDelegatedRuns, listLoopRuns, type LoopRunView } from "./agent-loop-store.js";
import { subordinateIdsOf } from "./supervision.js";
import { describeWorkCheck } from "./work-report.js";
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { openBudget } from "./delegation-budget-store.js";
import { SELF_WRITABLE_FIELDS, behaviourToolSchema, describeBehaviour } from "./agent-behaviour.js";
import { patchBehaviour, readBehaviour } from "./behaviour-store.js";
// The caller's own timezone, for rendering run times as wall-clock (#329).
//
// `work-report.ts` states that `check_work` and the automatic "recent work" prompt block must never
// tell different stories about one run. The prompt block gets the zone free (it is on the config
// join `agent-think` already does); this path has no such join, so it pays one indexed lookup — the
// alternative is the same run reading `08:33 AEST` in the prompt and only `3m ago` in the tool
// result, which is the inconsistency that comment forbids.
//
// Moved to its own leaf module for #345, so `connectors/supervision.ts` can share it: importing
// this file from there would close a cycle (this file imports the connector registry).
import { accountTimeZone } from "./account-timezone.js";

/**
 * The tool contract now lives in `connectors/types.ts` — a leaf module with no imports
 * that reach back here (#293). It moved because every connector module needs the SHAPE
 * of a tool and none of them needs this file's execution runtime; while the two shared a
 * module, thirteen connectors imported the dispatcher that imports them.
 *
 * Re-exported so `import type { ToolDef } from "./tool-registry.js"` keeps working.
 */
export type { JsonSchema, RegistryTool, RegistryToolCtx, RegistryToolResult, ToolDef };

/**
 * First-party registry tools that are NOT provided by a connector (base/standard/runtime
 * tiers). `run_pipeline` (issue #97) lets an agent start a declarative pipeline the owner
 * has declared on the instance ("sweep Sydney" → run the `leads` pipeline with city=Sydney).
 */
const FIRST_PARTY_TOOLS: ToolDef[] = [
	{
		name: "start_work",
		description:
			"Hand a GOAL to this agent's own executor and let it work autonomously — the same thing the Loop button does. Use this whenever the user asks you to DO something rather than explain it. Give an outcome in plain language ('fix issue #83 and merge it'), not a single command. It runs durably in the background and reports each step back into this conversation; say it has started, do not claim it has finished.",
		tier: "base",
		jsonSchema: {
			type: "object",
			properties: {
				objective: { type: "string", description: "The outcome you want, in plain language." },
				maxIterations: { type: "number", description: "Optional cap on how many steps it may take (default 10)." },
			},
			required: ["objective"],
		},
		handler: async (ctx, input) => {
			if (!ctx.instanceId || !ctx.userId) return { content: "start_work needs an owned instance context.", success: false };
			const objective = String(input.objective ?? "").trim();
			if (!objective) return { content: "start_work needs an objective.", success: false };
			const caps = await capabilitiesForInstance(ctx.env, ctx.instanceId, ctx.userId);
			const driver = loopDriverFor(caps);
			// Only where handing work to a DIFFERENT executor means something. On a plain chat agent
			// the driver IS this chat, so starting one from inside it would be the chat looping
			// itself — recursion dressed as delegation.
			if (driver.id === DEFAULT_LOOP_DRIVER.id) {
				return { content: "This agent has no separate executor to hand work to — do it with your own tools instead.", success: false };
			}
			// Inherit the caller's pool when there is one; only a ROOT hand-off opens a new one — the
				// rule `delegate-instance.ts:71` states, and the reason it gives (#382). From chat there
				// is no pool and this IS the root; from a pipeline step the run already owns one, and
				// opening a second per call is the per-call copy that makes a tree's total grow with the
				// number of calls instead of staying inside one allowance.
				const budgetId = ctx.budgetId ?? (await openBudget(ctx.env, ctx.userId, ctx.instanceId)).id;
			const started = await driver.start({
				env: ctx.env,
				instanceId: ctx.instanceId,
				userId: ctx.userId,
				objective,
				maxIterations: typeof input.maxIterations === "number" ? input.maxIterations : undefined,
				budgetId,
				depth: 0,
			});
			return started.ok
				? { content: `Started work on: ${objective} (run ${started.runId}). It reports progress into this conversation.`, success: true }
				: { content: started.error, success: false };
		},
	},
	{
		name: "check_work",
		description:
			"Look up work YOU started — with start_work, or by handing a goal to an agent you supervise: its status, how far it got, and how it ended. Call this whenever the user asks whether something actually happened, or challenges a report you gave — answer from this record, never from memory and never by apologising. With no runId it returns your most recent runs, including the ones you delegated.",
		tier: "base",
		jsonSchema: {
			type: "object",
			properties: {
				runId: { type: "string", description: "A specific run id (as returned by start_work or delegate_goal). Omit for your most recent runs." },
			},
			required: [],
		},
		handler: async (ctx, input) => {
			if (!ctx.instanceId || !ctx.userId) return { content: "check_work needs an owned instance context.", success: false };
			const timeZone = await accountTimeZone(ctx.env, ctx.userId);
			const runId = typeof input.runId === "string" ? input.runId.trim() : "";
			if (runId) {
				const run = await getLoopRun(ctx.env, ctx.userId, runId);
				// Scoped to THIS instance, not just the owner: `getLoopRun` is user-scoped, so
				// without this an agent could read another of the owner's agents' runs and report
				// it as its own — a fresh way to describe work it did not do.
				//
				// `delegatedBy` is the OTHER way a run can be yours (#318): a supervisor's runs are
				// never on its own instance, so instance identity alone made a Lead disown the run
				// `delegate_goal` had handed back to it 90 seconds earlier. Still an ownership test,
				// not a widening — the column names the one instance that asked for the run.
				const own = !!run && run.instanceId === ctx.instanceId;
				if (!run || !(own || run.delegatedBy === ctx.instanceId)) {
					return { content: `No run ${runId} belongs to you. Do not describe it as if it happened.`, success: false };
				}
				return { content: describeWorkCheck(own ? [run] : [], Date.now(), own ? { timeZone } : { delegated: [run], timeZone }), success: true };
			}
			const [runs, delegatedRuns] = await Promise.all([
				listLoopRuns(ctx.env, ctx.userId, ctx.instanceId, 5),
				// Tolerated rather than required: an API deployed ahead of migration 0090 has no
				// `delegated_by` column, and a supervisor losing its delegations is a far better
				// failure than every agent losing `check_work` outright.
				listDelegatedRuns(ctx.env, ctx.userId, ctx.instanceId, 5).catch(() => [] as LoopRunView[]),
			]);
			// Asked ONLY when there is nothing to report — the one branch whose wording turns on it,
			// and it costs a graph read. A supervisor with an empty record must not be told it misled
			// the user: for a delegator, emptiness here is the normal state.
			const supervises =
				runs.length + delegatedRuns.length === 0 &&
				(await subordinateIdsOf(ctx.env, ctx.userId, ctx.instanceId).catch(() => [])).length > 0;
			return { content: describeWorkCheck(runs, Date.now(), { delegated: delegatedRuns, supervises, timeZone }), success: true };
		},
	},
	{
		name: "get_behaviour",
		description:
			"Read how your subscriber has asked you to communicate — technicality, length, tone, formatting, and so on. Use this when they ask what your settings are, or before changing one, so you report what is actually stored rather than what you remember.",
		tier: "base",
		jsonSchema: { type: "object", properties: {}, required: [] },
		handler: async (ctx) => {
			if (!ctx.instanceId || !ctx.userId) return { content: "get_behaviour needs an owned instance context.", success: false };
			const behaviour = await readBehaviour(ctx.env, ctx.instanceId, ctx.userId);
			const rows = describeBehaviour(behaviour);
			if (!rows.length) {
				return {
					content:
						"Nothing is configured — you are using the platform defaults. The subscriber can set your behaviour in the Behaviour tab, or ask you to change it here.",
					success: true,
				};
			}
			// The band PROSE, not the raw value. Reading back "technicality is 70" would put the
			// number into the conversation, which is exactly what the band mapping exists to avoid.
			return { content: rows.map((r) => `${r.label}: ${r.description}`).join("\n"), success: true };
		},
	},
	{
		name: "set_behaviour",
		description:
			"Change how you communicate, when the subscriber asks you to (\"be less technical\", \"stop using emoji\", \"keep answers short\"). Pass only the fields that change; pass null to reset one to the platform default. This is the ONLY correct place for preferences about your manner — do not store them in memory, which is for knowledge about the subject you work on.",
		tier: "base",
		jsonSchema: behaviourToolSchema(SELF_WRITABLE_FIELDS) as ToolDef["jsonSchema"],
		handler: async (ctx, input) => {
			if (!ctx.instanceId || !ctx.userId) return { content: "set_behaviour needs an owned instance context.", success: false };
			// SELF_WRITABLE_FIELDS excludes every guardrail. A Repo Coder reads untrusted repo files
			// and issue bodies; if injected text could widen the agent's own restrictions then the
			// restrictions are decorative. The schema above already omits them, but the schema is a
			// hint to the model — this is the enforcement.
			const { behaviour, rejected } = await patchBehaviour(
				ctx.env,
				ctx.instanceId,
				ctx.userId,
				input,
				SELF_WRITABLE_FIELDS,
			);
			const rows = describeBehaviour(behaviour);
			const summary = rows.length ? rows.map((r) => `${r.label}: ${r.description}`).join("\n") : "(nothing configured)";
			// Refusals are reported, not swallowed: a tool that half-applies a patch and returns
			// success teaches the model it changed something it did not.
			const refused = rejected.length
				? `\n\nNOT changed (either not a real setting, or only the subscriber can set it in the Behaviour tab): ${rejected.join(", ")}`
				: "";
			return { content: `Updated. Your behaviour is now:\n${summary}${refused}`, success: true };
		},
	},
	{
		name: "get_stats",
		description:
			"Read the stats cards configured for this agent AND their current numbers — the same numbers the Stats tab shows. Call this before answering any question about how much/how many ('how many leads did I find this week?'); never estimate and never recompute from a record dump. IMPORTANT: in a daily trend, a day marked \"no run\" means NOTHING RAN that day. It is not zero — never report it as a day with no results.",
		tier: "base",
		jsonSchema: {
			type: "object",
			properties: { window: { type: "number", description: "Days to cover: 7, 30 or 90. Defaults to 30." } },
			required: [],
		},
		handler: async (ctx, input) => {
			if (!ctx.instanceId || !ctx.userId) return { content: "get_stats needs an owned instance context.", success: false };
			const { computeStats, describeStats } = await import("./stats-report.js");
			const { readInstanceStats } = await import("./stats-store.js");
			const { parseStatsWindow } = await import("./stats-schema.js");
			const { completedDay } = await import("./stats-rollup.js");
			const windowDays = parseStatsWindow(input.window);
			const { cards } = await readInstanceStats(ctx.env, ctx.instanceId, ctx.userId);
			// Through `computeStats`, the one implementation the route and MCP also use — which is
			// what structurally guarantees #312's "get_stats returns the same numbers the tab shows".
			const values = await computeStats({ env: ctx.env, instanceId: ctx.instanceId, userId: ctx.userId }, cards, windowDays);
			return { content: describeStats(values, windowDays, completedDay(new Date())), success: true };
		},
	},
	{
		name: "set_stats_card",
		description:
			"Add, edit or remove ONE stats card, when the subscriber asks you to track something ('chart my leads per suburb'). Pass `card: null` to remove it. `kind` decides how it reads: 'line' is a daily trend built from a nightly snapshot, so a NEW line card starts empty and shows its first point tomorrow — say so. 'number'/'bar'/'table' are current values and work immediately. You may only pick a `source` from the fixed list; you can never write a query or change whose data is shown.",
		tier: "base",
		jsonSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Card id — lowercase letters, digits, _ or -." },
				card: {
					type: "object",
					description: "The card: {title, kind, source, params}. Pass null to remove the card instead.",
					properties: {
						title: { type: "string" },
						kind: { type: "string", description: "number | line | bar | table" },
						source: { type: "string", description: "One of the fixed sources; call get_stats or ask if unsure." },
						params: { type: "object", description: "Source-specific params, e.g. {collection:'leads', field:'suburb'}." },
					},
				},
			},
			required: ["id"],
		},
		handler: async (ctx, input) => {
			if (!ctx.instanceId || !ctx.userId) return { content: "set_stats_card needs an owned instance context.", success: false };
			const { patchInstanceStats } = await import("./stats-store.js");
			const { familyForKind, STATS_SOURCE_IDS } = await import("./stats-schema.js");
			const id = String(input.id ?? "").trim();
			if (!id) return { content: "set_stats_card needs a card id.", success: false };
			// Writes the INSTANCE override only. There is deliberately no tool that reaches
			// `agents.config.statsSchema`: a subscriber's agent editing the template would change
			// what every OTHER subscriber gets — the boundary `patchBehaviour` already holds.
			const { stats, rejected } = await patchInstanceStats(ctx.env, ctx.instanceId, ctx.userId, [
				{ id, card: input.card === null ? null : input.card },
			]);
			if (rejected.length) {
				// Named refusals, not a swallowed patch. A model told "saved" about a card that does
				// not exist will go on to report numbers from it.
				return {
					content:
						`NOT saved: ${rejected.map((r) => r.reason).join("; ")}.\n` +
						`Valid sources are: ${STATS_SOURCE_IDS.join(", ")}.`,
					success: false,
				};
			}
			const saved = stats.cards.find((c) => c.id === id);
			if (!saved) return { content: `Removed card "${id}". Its recorded history is kept in case you add it back.`, success: true };
			const trend =
				familyForKind(saved.kind) === "trend"
					? " It is a daily trend built from a nightly snapshot, so it will be empty until tomorrow — there is no backfill."
					: "";
			return { content: `Saved card "${saved.title}" (${saved.kind}, ${saved.source}).${trend}`, success: true };
		},
	},
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
	// Declared-capability gate (#381), FIRST because it is the cheapest and the most fundamental:
	// "is this tool part of this agent at all" precedes both "may this connector write" and "has
	// the owner consented". Only callers that resolved an allowlist assert one (today the pipeline
	// runner), so every other surface is unchanged — but a caller that does assert one gets the
	// gate on NESTED dispatches too, which is the case a step-name check cannot reach: `enrich`
	// takes the tool to run as an input and re-dispatches it per record through this same path.
	//
	// `ctx.stepTool` only changes the WORDING (#396): a nested dispatch names the step that needs
	// the tool, because a definition that never mentions `http_request` cannot be searched for it.
	// The rule itself is unchanged — this is the security boundary and it stays exactly as strict.
	const undeclared = undeclaredToolRefusal(name, ctx.declaredTools, tool.connector, ctx.stepTool);
	if (undeclared) return { name, content: undeclared, success: false };
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
		// #185: resolve the authority through the named helper rather than reading a field, so
		// the "executor, never the asker" rule has one reviewable, tested place to live.
		const authority = consentInstanceOf({ instanceId: ctx.instanceId ?? "", userId: ctx.userId ?? "", onBehalfOf: ctx.onBehalfOf });
		if (!tool.connector || !(await hasConsent(ctx.env, authority || undefined, tool.connector, "write"))) {
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
			// Tokens are minted for the EXECUTOR too (#185) — instance-resource grants must not
			// follow the asker either, or up-borrowing would work where consent-bypass does not.
			connectorClient: ctx.connectorClient ?? ((provider: string) => connectorClient(ctx.env, provider, { userId: ctx.userId, instanceId: consentInstanceOf({ instanceId: ctx.instanceId ?? "", userId: ctx.userId ?? "", onBehalfOf: ctx.onBehalfOf }) || undefined })),
		};
		const r = await tool.handler(handlerCtx, input || {});
		// #185 audit: record WHOSE authority ran a delegated tool call. Only when delegated —
		// for ordinary work the authority is trivially the instance already on the event, so
		// logging every call would be pure noise at real cost. When a supervisor asked, "who
		// asked" and "whose permissions applied" are different questions and both matter.
		if (isDelegated({ instanceId: ctx.instanceId ?? "", userId: ctx.userId ?? "", onBehalfOf: ctx.onBehalfOf })) {
			await logEvent(ctx.env, {
				source: "tool",
				event: "delegated_tool_call",
				message: `${name} ${describeAuthority({ instanceId: ctx.instanceId ?? "", userId: ctx.userId ?? "", onBehalfOf: ctx.onBehalfOf })}`,
				userId: ctx.userId ?? null,
				instanceId: ctx.instanceId ?? null,
				traceId: ctx.traceId ?? null,
				level: r.success ? "info" : "warn",
				context: { tool: name, scope: tool.scope, onBehalfOf: ctx.onBehalfOf, success: r.success },
			}).catch(() => undefined);
		}
		return { name, content: r.content, success: r.success };
	} catch (err) {
		return { name, content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false };
	}
}
