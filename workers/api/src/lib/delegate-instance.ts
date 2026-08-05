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
import { DEFAULT_LOOP_DRIVER, loopDriverFor } from "./loop-drivers.js";
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { sanitizeMaxIterations } from "./agent-loop.js";
import { logEvent } from "./events.js";
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
	// The SAME dispatcher the owner's own Loop button uses (#210). It was this `if` — one
	// hardcoded workflow name — and the owner's path didn't have it, so pressing Loop on a Repo
	// Coder looped a chat that cannot write. One table now serves both, and a new agent type is
	// an entry in it rather than a branch in each caller.
	const caps = await capabilitiesForInstance(env, input.subordinateInstanceId, input.userId);
	const driver = loopDriverFor(caps);
	if (driver.id !== DEFAULT_LOOP_DRIVER.id) {
		const started = await driver.start({
			env,
			instanceId: input.subordinateInstanceId,
			userId: input.userId,
			objective,
			maxIterations: input.maxIterations,
			budgetId,
			depth,
			delegated: true,
		});
		return started.ok
			? { ok: true, runId: started.runId, budgetId, depth }
			: { ok: false, status: started.status, error: started.error };
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
