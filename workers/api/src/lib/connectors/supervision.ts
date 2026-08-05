// The supervision connector — how a SUPERVISOR agent's brain drives its subordinates (#156/#159).
//
// This is the piece that makes a supervisor declarable. Everything else needed for a
// "Coder 2" existed: the graph is data (#183), delegation is enforced (#159), the loop is durable
// (#158), spend is bounded (#184). But an agent's brain can only act through TOOLS, and there was
// no delegation tool — so a declared supervisor could be wired up perfectly and still be unable
// to do the one thing that makes it a supervisor.
//
// The hardcoded Coder solved this with `drive_claude`, a bespoke tool defined inline in
// routes/coding.ts, hand-rolled into one route's LLM call, reaching a repo. These are the same
// idea with the Coder-specific parts removed: the target is an instance from the configured
// graph, and they surface through the ordinary registry — so they appear in the agent runtime,
// `/v1/instances/:id/tools` and MCP without any of them being taught about supervision.
//
// auth:"none" — supervision is internal to the platform and to ONE owner (both instances are
// theirs). There is no external system and so no credential; what governs it is the graph, and
// `delegate_goal` re-checks that on every call rather than trusting the caller.

import { delegateToInstance } from "../delegate-instance.js";
import { getLoopRun } from "../agent-loop-store.js";
import { loadGraph } from "../supervision.js";
import { subordinatesOf } from "../supervision-graph.js";
import { agentCapabilities, sanitizeBoardColumns, type BoardColumn } from "../agent-capabilities.js";
import { recentRunsForInstances, recentWorkForInstances } from "../instance-work.js";
import { summarizeSubordinates } from "../subordinate-observation.js";
import type { ToolDef } from "../tool-registry.js";

/** Names of the instances a supervisor may drive, with their display names for the model. */
interface SubordinateRow {
	instanceId: string;
	name: string;
	/** `active | paused | canceled` — the SUBSCRIPTION lifecycle, not work state. */
	subscription: string;
	/** Resolved per-instance override → agent declaration → per-surface default. */
	columns: BoardColumn[];
}

async function subordinateSummaries(
	ctx: { env: { DB: D1Database }; userId?: string; instanceId?: string },
	only?: string,
): Promise<SubordinateRow[]> {
	const userId = ctx.userId ?? "";
	const supervisorId = ctx.instanceId ?? "";
	if (!userId || !supervisorId) return [];
	let ids = subordinatesOf(await loadGraph(ctx.env as never, userId), supervisorId);
	// A named instance is INTERSECTED with the graph, never trusted — same posture as
	// delegate_goal, which re-checks membership inside delegateToInstance rather than relying on
	// the tool description to discourage a model from naming someone else's agent.
	if (only) ids = ids.filter((id) => id === only);
	if (!ids.length) return [];
	const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
	// `agent_instances` has NO name column — a per-instance display name lives in
	// config.displayName (set by PUT /:id/name), and everything else falls back to the template's
	// name. Selecting i.name is a D1 error, not an empty result, so it takes the whole tool down.
	const res = await ctx.env.DB.prepare(
		`SELECT i.id AS id, i.status AS status, i.config AS config, a.name AS agent_name,
		        a.slug AS slug, a.category AS category, a.config AS agent_config
		   FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id
		  WHERE i.user_id = ?1 AND i.id IN (${placeholders})`,
	)
		.bind(userId, ...ids)
		.all<{ id: string; status: string; config: string | null; agent_name: string | null; slug: string | null; category: string | null; agent_config: string | null }>();
	return (res.results ?? []).map((r) => {
		let displayName: string | null = null;
		try {
			const cfg = JSON.parse(r.config ?? "{}") as { displayName?: unknown };
			if (typeof cfg.displayName === "string" && cfg.displayName.trim()) displayName = cfg.displayName.trim();
		} catch {
			// A malformed config must not hide the subordinate — fall back to the template name.
		}
		// The subordinate's OWN status vocabulary, resolved the same way boardConfigForInstance
		// does: per-instance override → agent declaration → per-surface default. This is what lets
		// a supervisor interpret a free-text status without holding any vocabulary of its own.
		let override: BoardColumn[] | undefined;
		try {
			override = sanitizeBoardColumns((JSON.parse(r.config ?? "{}") as { boardColumns?: unknown }).boardColumns);
		} catch {
			/* malformed config — fall through to the agent's declared columns */
		}
		const declared = agentCapabilities({ slug: r.slug ?? undefined, category: r.category ?? undefined, config: r.agent_config ?? undefined }).boardColumns;
		return {
			instanceId: r.id,
			name: displayName ?? r.agent_name ?? r.id,
			subscription: r.status,
			columns: override ?? declared,
		};
	});
}

/**
 * The supervisor's global picture. Shared by `subordinate_status` and by `check_delegation`'s
 * no-run-id branch, so the answer does not depend on which tool the model happens to reach for.
 */
async function observeSubordinates(
	ctx: { env: never; userId?: string; instanceId?: string },
	only?: string,
	limit?: number,
): Promise<{ content: string; success: boolean }> {
	const subs = await subordinateSummaries(ctx as never, only);
	if (!subs.length) {
		return {
			content: only ? "You do not supervise that agent. Call list_subordinates to see who you may address." : NO_SUBORDINATES,
			success: true,
		};
	}
	const userId = ctx.userId ?? "";
	const ids = subs.map((s) => s.instanceId);
	// Two statements total, regardless of fan-out — see instance-work.ts.
	const [work, runs] = await Promise.all([
		recentWorkForInstances(ctx.env, userId, ids, limit).catch(() => []),
		recentRunsForInstances(ctx.env, userId, ids).catch(() => []),
	]);
	const view = summarizeSubordinates({ now: Date.now(), subordinates: subs, work, runs });
	return { content: JSON.stringify({ asOf: new Date().toISOString(), ...view }, null, 2), success: true };
}

const NO_SUBORDINATES = "You do not supervise any agents yet. Add a supervision link in Settings first.";

export const SUPERVISION_TOOLS: ToolDef[] = [
	{
		name: "list_subordinates",
		tier: "connector",
		connector: "supervision",
		scope: "read",
		description:
			"The roster of agents this one supervises — instance id, name, and SUBSCRIPTION state (active/paused), which is NOT what they are doing. Use subordinate_status to see what each is working on. You may only delegate to agents that appear here.",
		jsonSchema: { type: "object", properties: {} },
		handler: async (ctx) => {
			const subs = await subordinateSummaries(ctx as never);
			if (!subs.length) return { content: NO_SUBORDINATES, success: true };
			// Roster only — the columns are an implementation detail of subordinate_status.
			const roster = subs.map((s) => ({ instanceId: s.instanceId, name: s.name, subscription: s.subscription }));
			return { content: JSON.stringify(roster, null, 2), success: true };
		},
	},
	{
		name: "subordinate_status",
		tier: "connector",
		connector: "supervision",
		scope: "read",
		description:
			"What every agent you supervise is doing RIGHT NOW, in one call: what each is working on, " +
			"what finished, what is waiting on a human, and how long anything has been quiet. Call this " +
			"FIRST whenever you are asked about status, progress, or what is happening, and answer from " +
			"it — never start a run just to find out. Each item's `status` is that agent's own word for " +
			"it; `columnTitle` is what THAT agent says the word means.",
		jsonSchema: {
			type: "object",
			properties: {
				instanceId: { type: "string", description: "Only this subordinate. Omit for all of them." },
				limit: { type: "number", description: "Recent items per agent (1-25, default 8)." },
			},
		},
		handler: async (ctx, input) => {
			const only = typeof input.instanceId === "string" && input.instanceId.trim() ? input.instanceId.trim() : undefined;
			const limit = typeof input.limit === "number" ? input.limit : undefined;
			return observeSubordinates(ctx as never, only, limit);
		},
	},
	{
		name: "delegate_goal",
		tier: "connector",
		connector: "supervision",
		// WRITE: it starts real work on another agent and spends real money, so it sits behind
		// the per-instance write-consent gate (#90) like every other write tool.
		scope: "write",
		description:
			"Hand a GOAL to an agent you supervise. It runs autonomously with its own tools and knowledge and reports back — you do not micro-manage it. Give an outcome ('get the test suite green'), not a single command. Returns a run id you can check with check_delegation.",
		jsonSchema: {
			type: "object",
			properties: {
				instanceId: { type: "string", description: "The subordinate's instance id, from list_subordinates." },
				objective: { type: "string", description: "The outcome you want, in plain language." },
				maxIterations: { type: "number", description: "Optional cap on how many steps it may take." },
			},
			required: ["instanceId", "objective"],
		},
		handler: async (ctx, input) => {
			// The graph is re-checked inside delegateToInstance — a model naming an instance it
			// does not supervise is refused there, not merely discouraged by the description.
			const res = await delegateToInstance(ctx.env as never, {
				userId: ctx.userId ?? "",
				supervisorInstanceId: ctx.instanceId ?? "",
				subordinateInstanceId: String(input.instanceId ?? ""),
				objective: String(input.objective ?? ""),
				maxIterations: typeof input.maxIterations === "number" ? input.maxIterations : undefined,
				// Correlate the child run with whatever run asked for it, so a multi-level
				// delegation renders as one tree.
				parentTraceId: ctx.traceId ?? null,
				// Share the TREE's pool. Omitting this made `delegateToInstance` open a fresh
				// budget per hop, so the real ceiling was allowance × edges — the per-tree bound
				// was inert on the only path an agent can actually delegate through.
				budgetId: ctx.budgetId ?? undefined,
			});
			if (!res.ok) return { content: res.error, success: false };
			return {
				content: `Delegated. Run ${res.runId} started at depth ${res.depth}. Check it with check_delegation.`,
				success: true,
			};
		},
	},
	{
		name: "check_delegation",
		tier: "connector",
		connector: "supervision",
		scope: "read",
		description:
			"Check ONE delegated run by id: its status, how many steps it has taken, and why it stopped. With no run id this falls through to the same picture subordinate_status gives — so for \"what is happening across my agents\", prefer subordinate_status directly.",
		jsonSchema: {
			type: "object",
			properties: {
				runId: { type: "string", description: "A run id from delegate_goal. Omit to list recent runs." },
				instanceId: { type: "string", description: "Subordinate to list runs for, when omitting runId." },
			},
		},
		handler: async (ctx, input) => {
			const userId = ctx.userId ?? "";
			const runId = String(input.runId ?? "").trim();
			if (runId) {
				const run = await getLoopRun(ctx.env as never, userId, runId);
				if (!run) return { content: `No delegated run with id ${runId}.`, success: false };
				return { content: JSON.stringify(run, null, 2), success: true };
			}
			// No run id → the caller is asking "what is going on", not "how is run X". Answer with
			// the SAME view subordinate_status returns rather than a bare list of loop rows.
			//
			// Not politeness — measured. Given both tools, the Lead reached for this one three
			// times in a row and never called subordinate_status, because it is the tool it has
			// always used and its own description advertises the listing branch. A new tool name
			// has to be DISCOVERED; the one already in the model's habit does not. Making both
			// paths return the good answer is robust to which one it picks.
			const only = String(input.instanceId ?? "").trim() || undefined;
			return observeSubordinates(ctx as never, only);
		},
	},
];
