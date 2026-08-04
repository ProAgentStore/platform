// Agent-to-agent delegation (#159) — hand a GOAL to another instance's brain.
//
// This is the capability #156 deliberately parsed but refused, held back until the three things
// that make it safe existed: the supervision graph (#183), the spend budget (#184) and authority
// containment (#185). All three landed, so it turns on here — and every one of them is enforced
// on this path rather than assumed:
//
//  • the edge must EXIST in the configured graph. Without that check any instance could drive any
//    other, which would make the graph decorative and re-create the bypass #185 closes from a
//    different direction.
//  • depth comes from the graph, not from the caller, so a subordinate cannot understate its own
//    depth to escape the cap.
//  • the budget is INHERITED from the parent run when there is one. A fresh pool per hop would be
//    the per-path copy that makes a tree cost allowance × fanout^depth.
//  • the subordinate runs on its own brain, so #185's "executor is the authority" holds by
//    construction; the supervisor rides along only as `onBehalfOf`, for the audit trail.

import { depthAbove, subordinatesOf } from "./supervision-graph.js";
import { loadGraph } from "./supervision.js";
import { openBudget } from "./delegation-budget-store.js";
import { createLoopRun } from "./agent-loop-store.js";
import { sanitizeMaxIterations } from "./agent-loop.js";
import { logEvent } from "./events.js";
import { agentCapabilities } from "./agent-capabilities.js";
import { getActiveSessionForRepo, listRepos } from "./coding-store.js";
import { delegationTaskRecord } from "./delegation.js";
import type { Env } from "../types.js";

export interface DelegateInstanceInput {
	userId: string;
	supervisorInstanceId: string;
	subordinateInstanceId: string;
	objective: string;
	/** Budget of the run doing the delegating. Inherited so the whole tree shares one pool. */
	budgetId?: string | null;
	/** Trace of the parent run, so a multi-level delegation renders as ONE tree. */
	parentTraceId?: string | null;
	maxIterations?: number;
}

export type DelegateInstanceResult =
	| { ok: true; runId: string; budgetId: string; depth: number }
	| { ok: false; error: string; status: number };

/**
 * Start a durable loop on a subordinate instance, on the supervisor's behalf.
 *
 * Returns a run handle rather than a reply: delegation is a goal with follow-through, not a
 * one-shot. The supervisor tracks status; it does not block.
 */
export async function delegateToInstance(env: Env, input: DelegateInstanceInput): Promise<DelegateInstanceResult> {
	const objective = (input.objective || "").trim();
	if (!objective) return { ok: false, status: 400, error: "An objective is required to delegate." };
	if (objective.length > 2000) return { ok: false, status: 400, error: "Objective too long." };
	if (input.supervisorInstanceId === input.subordinateInstanceId) {
		return { ok: false, status: 400, error: "An agent cannot delegate to itself." };
	}

	// The configured graph is the authority on who may drive whom. Checking it here is what keeps
	// supervision from being merely advisory.
	const graph = await loadGraph(env, input.userId);
	if (!subordinatesOf(graph, input.supervisorInstanceId).includes(input.subordinateInstanceId)) {
		return {
			ok: false,
			status: 403,
			error: "That agent is not supervised by this one. Add the supervision link first.",
		};
	}

	// Depth is derived, never taken from the caller.
	const depth = depthAbove(graph, input.subordinateInstanceId);

	// Inherit the parent's pool; only a ROOT delegation opens a new one. Opening one per hop is
	// the per-path copy that makes the tree total grow as fanout^depth.
	const budgetId = input.budgetId ?? (await openBudget(env, input.userId, input.supervisorInstanceId)).id;

	// Route by the target's DECLARED capability (#156: one delegate verb that picks the level).
	// A coding agent's work happens in its Pilot driving a real CLI; its chat only explains.
	// Sending a coding goal to the chat loop makes the agent TALK about the repo instead of
	// changing it — which looks like success on the board and produces nothing. The hardcoded
	// Overseer always reached the Pilot; a declared supervisor must too, or "as capable as the
	// hardcoded Coder" is false in the only way that matters.
	const target = await env.DB.prepare(
		`SELECT a.slug AS slug, a.category AS category, a.config AS config
		   FROM agent_instances i JOIN agents a ON a.id = i.agent_id
		  WHERE i.id = ?1 AND i.user_id = ?2`,
	)
		.bind(input.subordinateInstanceId, input.userId)
		.first<{ slug: string; category: string; config: string | null }>();
	if (target && agentCapabilities(target as never).workflow === "CODING_SESSION") {
		return delegateToPilot(env, input, depth, budgetId, objective);
	}

	const runId = crypto.randomUUID();
	await createLoopRun(env, {
		runId,
		userId: input.userId,
		instanceId: input.subordinateInstanceId,
		objective,
		maxIterations: sanitizeMaxIterations(input.maxIterations),
		budgetId,
		startedAt: Date.now(),
	});

	await env.AGENT_LOOP.create({
		id: runId,
		params: {
			runId,
			instanceId: input.subordinateInstanceId,
			userId: input.userId,
			objective,
			maxIterations: sanitizeMaxIterations(input.maxIterations),
			budgetId,
			depth,
			// #185: audit only. The subordinate's own consent and tools govern what it may do.
			onBehalfOf: input.supervisorInstanceId,
		},
	});

	// Logged under the PARENT's trace as well as its own, so a three-level delegation reads as one
	// tree rather than as unrelated runs — the join choreography normally lacks.
	await logEvent(env, {
		source: "loop",
		event: "delegate",
		message: `${input.supervisorInstanceId} → ${input.subordinateInstanceId}: ${objective.slice(0, 160)}`,
		userId: input.userId,
		instanceId: input.supervisorInstanceId,
		traceId: input.parentTraceId ?? runId,
		context: { runId, depth, budgetId },
	}).catch(() => undefined);

	return { ok: true, runId, budgetId, depth };
}

/**
 * Delegate to a coding agent's Pilot — the durable loop that drives a real CLI.
 *
 * Mirrors what the hardcoded Overseer does, with the repo resolved from the subordinate rather
 * than named by the caller: a Repo Coder owns exactly one repo, so the supervisor should not have
 * to know which. Refusals are explicit, because the alternative — a board card that looks
 * delegated and never moves — is the failure #154 was written to kill.
 */
async function delegateToPilot(
	env: Env,
	input: DelegateInstanceInput,
	depth: number,
	budgetId: string,
	objective: string,
): Promise<DelegateInstanceResult> {
	const repos = await listRepos(env, input.subordinateInstanceId, input.userId).catch(() => []);
	const repo = repos[0];
	if (!repo) {
		return {
			ok: false,
			status: 409,
			error: "That coding agent has no repository yet — add one on its Coding tab first.",
		};
	}
	const session = await getActiveSessionForRepo(env, input.subordinateInstanceId, input.userId, repo.id);
	if (!session) {
		return {
			ok: false,
			status: 409,
			error: `${repo.name} has no live coding session — start one on its Coding tab (and run \`pags up\`), then delegate again.`,
		};
	}

	// Observable board task, so a delegated goal is trackable rather than buried in one repo's
	// thread. The Pilot flips it to completed/failed at its terminal state.
	const taskId = `deleg-${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
		 VALUES (?1, ?2, ?3, 'delegation', 'running', ?4, datetime('now'), datetime('now'))`,
	)
		.bind(
			taskId,
			input.subordinateInstanceId,
			input.userId,
			JSON.stringify(delegationTaskRecord({ id: taskId, targetLabel: repo.name, objective, status: "running", now: new Date().toISOString() })),
		)
		.run()
		.catch(() => undefined);

	await env.CODING_SESSION.create({
		params: {
			instanceId: input.subordinateInstanceId,
			userId: input.userId,
			sessionId: session.id,
			repoId: repo.id,
			runnerNode: session.runnerNode ?? null,
			cloneUrl: repo.cloneUrl ?? undefined,
			branch: repo.branch || undefined,
			goal: { objective, repo: repo.name, clientType: session.clientType },
			boardTaskId: taskId,
			// #184: a DELEGATED coding run draws on the tree's pool. A human driving the same
			// Pilot from the Coding tab passes no budget and stays unmetered, as before.
			budgetId,
			depth,
		},
	});

	await logEvent(env, {
		source: "coding",
		event: "delegate",
		message: `${input.supervisorInstanceId} → ${repo.name}: ${objective.slice(0, 160)}`,
		userId: input.userId,
		instanceId: input.supervisorInstanceId,
		traceId: input.parentTraceId ?? taskId,
		context: { taskId, depth, budgetId, subordinate: input.subordinateInstanceId },
	}).catch(() => undefined);

	return { ok: true, runId: taskId, budgetId, depth };
}
