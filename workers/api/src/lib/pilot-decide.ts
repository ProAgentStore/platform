/**
 * One Pilot decision under the controller recovery policy (#907) — what the workflow's decide step runs.
 *
 * Inside the step: each ATTEMPT reserves and settles its own budget draw (`decideWithinBudget`), reloads
 * the owner's standing rules and directives (#1015), and uses the selected model within that attempt's deadlines. An opt-in canary may
 * make one Sonnet validation request within the SAME deadline; recovery attempts go straight to Sonnet. A stall is retried here, bounded by the policy's attempts and wall-clock ceiling,
 * with cancellation checked before every attempt and after every backoff.
 *
 * Across the step boundary: an exhausted recovery is RETURNED, not thrown. Thrown, Cloudflare's own
 * step retry (`limit: 2`) would run the whole recovery two more times — the nested multiplication #907
 * forbids. Outside the step `unwrapPilotDecide` raises it as an ordinary error, which the round-level
 * resume (`coding-interrupt.ts`, bounded per run) classifies as `provider_stall` and handles once.
 * A stalled attempt raised before returning anything, so no partial decision ever reaches the engine,
 * and every completed step is journalled, so nothing already done is replayed.
 */
import type { Env } from "../types.js";
import { isCancelRequested } from "./agent-loop-store.js";
import { decideWithinBudget } from "./coding-decide-budget.js";
import { type CodingDecision, type CodingGoal, type CodingPaneSnapshot, decideCodingAction } from "./coding-loop.js";
import { refreshGoalConstraints } from "./coding-standing-constraints.js";
import type { ScopeConstraint } from "./coding-scope-constraints.js";
import { ControllerAiCancelled, ControllerAiStalled, type ControllerAiPolicy, controllerAiCall } from "./controller-ai-recovery.js";
import { readPilotModel } from "./pilot-model.js";

/**
 * What crosses the step boundary: a decision, or a stall the recovery could not get past. Serializable.
 *
 * `constraints` rides with the decision (#1019): the refresh runs INSIDE the step, so on a Workflow
 * replay it does not run again and the goal would hold the previous decision's constraints while the
 * journalled decision was made under these. `unwrapPilotDecide` re-applies them, so the action is
 * screened against the constraints it was decided under, on every attempt and every replay.
 */
export type PilotDecideOutcome = { decision: CodingDecision; constraints?: ScopeConstraint[] } | { stalled: { message: string; attempts: number } };

export interface PilotDecideInput {
	userId: string;
	instanceId: string;
	repoId: string;
	sessionId: string;
	runStartedAt: number;
	loopRunId?: string | null;
	budgetId?: string | null;
	depth?: number;
	/** `atCap` (#1261): routes to the one-off cap-report decision instead of a normal action round. */
	params: { goal: CodingGoal; actionLog: string[]; snapshot: CodingPaneSnapshot; atCap?: boolean };
}

export async function pilotDecide(env: Env, input: PilotDecideInput, opts: { policy?: ControllerAiPolicy; sleep?: (ms: number) => Promise<void> } = {}): Promise<PilotDecideOutcome> {
	const traceId = input.loopRunId ?? input.sessionId;
	const loopRunId = input.loopRunId;
	try {
		const decision = await controllerAiCall(
			env,
			{ userId: input.userId, instanceId: input.instanceId, traceId, surface: "pilot", isCancelled: loopRunId ? () => isCancelRequested(env, loopRunId) : undefined, policy: opts.policy, sleep: opts.sleep },
			(deadlines) =>
				decideWithinBudget(env, { userId: input.userId, instanceId: input.instanceId, budgetId: input.budgetId, depth: input.depth }, async () => {
					// Read inside the journalled decision attempt; old runs retain their recorded decisions.
					input.params.goal.pilotModel = await readPilotModel(env, input.instanceId, input.userId);
					// The owner's standing rules and latest directives, fresh for THIS attempt (#1015).
					const ctx = { instanceId: input.instanceId, userId: input.userId, repoId: input.repoId, sessionId: input.sessionId, runStartedAt: input.runStartedAt };
					await refreshGoalConstraints(env, input.params.goal, ctx);
					const decided = await decideCodingAction(env, input.userId, input.params, { kind: "coding", instanceId: input.instanceId, traceId }, deadlines);
					// …and AGAIN once the provider has answered (#1019). A generation takes seconds to minutes, and a
					// directive the owner sent meanwhile is not in the prompt that produced this action — but it binds
					// the action all the same. The loop screens against the constraints returned below, so work the
					// owner forbade mid-generation is refused before transport rather than one decision too late.
					await refreshGoalConstraints(env, input.params.goal, ctx);
					return decided;
				}),
		);
		return { decision: decision as CodingDecision, constraints: input.params.goal.scopeConstraints };
	} catch (e) {
		if (e instanceof ControllerAiStalled) return { stalled: { message: e.message, attempts: e.attempts } };
		if (e instanceof ControllerAiCancelled) return { decision: { cancelled: { why: e.message } } };
		throw e;
	}
}

/** Outside the step: a decision passes through (its constraints applied to `goal`); an exhausted recovery is raised. */
export function unwrapPilotDecide(outcome: PilotDecideOutcome, goal?: CodingGoal): CodingDecision {
	if ("stalled" in outcome) {
		const err = new Error(outcome.stalled.message);
		err.name = "ControllerAiStalled";
		throw err;
	}
	if (goal && outcome.constraints) goal.scopeConstraints = outcome.constraints;
	return outcome.decision;
}
