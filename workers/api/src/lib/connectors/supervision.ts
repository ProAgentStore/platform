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
import { getLoopRun, listLoopRuns } from "../agent-loop-store.js";
import { loadGraph } from "../supervision.js";
import { subordinatesOf } from "../supervision-graph.js";
import { getActiveSessionForRepo, listRepos } from "../coding-store.js";
import { lastTerminal } from "../coding-timeline.js";
import type { ToolDef } from "../tool-registry.js";

/** Names of the instances a supervisor may drive, with their display names for the model. */
async function subordinateSummaries(
	ctx: { env: { DB: D1Database }; userId?: string; instanceId?: string },
): Promise<Array<{ instanceId: string; name: string; status: string }>> {
	const userId = ctx.userId ?? "";
	const supervisorId = ctx.instanceId ?? "";
	if (!userId || !supervisorId) return [];
	const ids = subordinatesOf(await loadGraph(ctx.env as never, userId), supervisorId);
	if (!ids.length) return [];
	const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
	// `agent_instances` has NO name column — a per-instance display name lives in
	// config.displayName (set by PUT /:id/name), and everything else falls back to the template's
	// name. Selecting i.name is a D1 error, not an empty result, so it takes the whole tool down.
	const res = await ctx.env.DB.prepare(
		`SELECT i.id AS id, i.status AS status, i.config AS config, a.name AS agent_name
		   FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id
		  WHERE i.user_id = ?1 AND i.id IN (${placeholders})`,
	)
		.bind(userId, ...ids)
		.all<{ id: string; status: string; config: string | null; agent_name: string | null }>();
	return (res.results ?? []).map((r) => {
		let displayName: string | null = null;
		try {
			const cfg = JSON.parse(r.config ?? "{}") as { displayName?: unknown };
			if (typeof cfg.displayName === "string" && cfg.displayName.trim()) displayName = cfg.displayName.trim();
		} catch {
			// A malformed config must not hide the subordinate — fall back to the template name.
		}
		return { instanceId: r.id, name: displayName ?? r.agent_name ?? r.id, status: r.status };
	});
}


/** Per-subordinate live picture. Bounded hard: a supervisor's context is not a log dump. */
const WORK_TAIL_CHARS = 400;
const WORK_TOTAL_CHARS = 8_000;

interface SubordinateWork {
	/** Repos this subordinate owns, with whether an engine is live and what it last printed. */
	repos: Array<{ name: string; live: boolean; recent?: string; instructions?: string }>;
	/** The most recent run THIS supervisor can be accountable for. */
	lastRun?: { runId: string; status: string; stopReason?: string | null; detail?: string | null };
}

/**
 * What each subordinate is actually DOING — the half that makes a supervisor an Overseer rather
 * than a dispatcher.
 *
 * The hardcoded Overseer opens by building exactly this, one level down: for every repo, is a
 * session live, and what did it last print. That global picture is what lets it answer "which repo
 * needs me?" in a single model call instead of starting work to find out. `list_subordinates`
 * returned `{instanceId, name, status}` — and `status` is `agent_instances.status`, the
 * SUBSCRIPTION status, which is "active" for every healthy subordinate forever. So the Lead could
 * name who it supervises and knew nothing else: every question about state had to be answered by
 * delegating a run, which costs a durable workflow and a full LLM loop per question.
 *
 * Same loop as the Overseer's, iterating SUBORDINATE INSTANCES instead of repos on one instance.
 * Best-effort throughout: a subordinate whose runner is offline still lists, it just has no live
 * detail. Failing to read one must never take the tool down.
 */
async function subordinateWork(
	env: { DB: D1Database },
	userId: string,
	instanceId: string,
	budget: { left: number },
): Promise<SubordinateWork> {
	const out: SubordinateWork = { repos: [] };
	const repos = await listRepos(env as never, instanceId, userId).catch(() => []);
	for (const r of repos) {
		const active = await getActiveSessionForRepo(env as never, instanceId, userId, r.id).catch(() => null);
		let recent: string | undefined;
		if (active && budget.left > 0) {
			const term = await lastTerminal(env as never, active.id).catch(() => null);
			if (term) {
				recent = term.slice(-Math.min(WORK_TAIL_CHARS, budget.left));
				budget.left -= recent.length;
			}
		}
		out.repos.push({
			name: r.name,
			live: !!active,
			...(recent ? { recent } : {}),
			...(r.instructions ? { instructions: r.instructions.slice(0, 300) } : {}),
		});
	}
	const runs = await listLoopRuns(env as never, userId, instanceId, 1).catch(() => []);
	const last = runs[0];
	if (last) out.lastRun = { runId: last.runId, status: last.status, stopReason: last.stopReason, detail: last.detail };
	return out;
}

export const SUPERVISION_TOOLS: ToolDef[] = [
	{
		name: "list_subordinates",
		tier: "connector",
		connector: "supervision",
		scope: "read",
		description:
			"The agents this one supervises AND what each is currently doing — its repos, whether an engine is live, what it last printed, and how its last delegated run ended. Call this FIRST: it is your global picture, so you can answer \"what is happening / which one needs me / is anything stuck\" directly, and only delegate when work is actually required. You may only delegate to agents that appear here.",
		jsonSchema: {
			type: "object",
			properties: {
				detail: {
					type: "boolean",
					description: "Include each subordinate's live work state (default true). Set false for just the roster.",
				},
			},
		},
		handler: async (ctx, input) => {
			const subs = await subordinateSummaries(ctx as never);
			if (!subs.length) {
				return {
					content: "You do not supervise any agents yet. Add a supervision link in Settings first.",
					success: true,
				};
			}
			// The global picture, not just the roster. Without it a supervisor has to START WORK to
			// find out what is happening — the hardcoded Overseer answered from context in one
			// model call, and a Lead that cannot is a dispatcher, not an overseer.
			if (input?.detail === false) return { content: JSON.stringify(subs, null, 2), success: true };
			const userId = (ctx as { userId?: string }).userId ?? "";
			const budget = { left: WORK_TOTAL_CHARS };
			const detailed = [];
			for (const sub of subs) {
				const work = await subordinateWork((ctx as { env: { DB: D1Database } }).env, userId, sub.instanceId, budget).catch(
					() => ({ repos: [] }) as SubordinateWork,
				);
				detailed.push({ ...sub, ...work });
			}
			return { content: JSON.stringify(detailed, null, 2), success: true };
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
			"Check what a delegated run is doing: its status, how many steps it has taken, and why it stopped. With no run id, lists the most recent runs you started. Use this instead of asking the agent — delegation reports back through here.",
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
			const instanceId = String(input.instanceId ?? "").trim();
			if (!instanceId) {
				return { content: "Give either a runId, or an instanceId to list that agent's runs.", success: false };
			}
			const runs = await listLoopRuns(ctx.env as never, userId, instanceId, 10);
			return { content: JSON.stringify(runs, null, 2), success: true };
		},
	},
];
