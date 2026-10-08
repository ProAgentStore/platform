/**
 * The Application Runner's cloud brain.
 *
 * This is deliberately not another catalog agent or a second application workflow.  It uses the
 * Runner instance's existing selected brain to decide one bounded, runner-observed checkpoint,
 * persists exactly one directive, then lets the relay deliver that directive to the local CLI.
 * The model never receives browser snapshots, form values, source files, or CLI prose.
 */
import type { AgentState } from "../../agent-types.js";
import type { Env } from "../../types.js";
import { brainModel } from "../brain-models.js";
import { runUserWorkersAi } from "../user-ai.js";
import type { ApplyRun } from "./store.js";
import {
	SUPERVISOR_SCHEMA_VERSION,
	issueSupervisorDirective,
	type SupervisorCheckpoint,
	type SupervisorDirective,
	type SupervisorDirectiveKind,
} from "./supervision.js";

const DEFAULT_BRAIN_MODEL = "claude-sonnet-4-6";
const DECISION_TOOL = {
	type: "function",
	function: {
		name: "decide_application_checkpoint",
		description: "Choose the sole persisted directive for this application-runner checkpoint.",
		parameters: {
			type: "object",
			properties: { directive: { type: "string", enum: ["continue", "request_review", "stop"] } },
			required: ["directive"],
			additionalProperties: false,
		},
	},
} as const;

type BrainResponse = { tool_calls?: Array<{ name?: unknown; arguments?: unknown }> };

async function instanceBrain(env: Env, instanceId: string): Promise<{ model: string; modelChosen: boolean } | null> {
	try {
		const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
		const res = await stub.fetch(new Request("https://agent/state"));
		if (!res.ok) return null;
		const state = (await res.json().catch(() => null)) as Partial<AgentState> | null;
		// An instance normally always has its selected/default brain. A malformed or stale DO state
		// must fail closed rather than silently run an arbitrary model id.
		const model = typeof state?.model === "string" && brainModel(state.model) ? state.model : DEFAULT_BRAIN_MODEL;
		return { model, modelChosen: state?.modelChosen === true };
	} catch {
		return null;
	}
}

const parsedDirective = (value: unknown): SupervisorDirectiveKind | null =>
	value === "continue" || value === "request_review" || value === "stop" ? value : null;

/** Policy has the final word even when a model chooses an unsafe action. */
export function constrainBrainDirective(run: ApplyRun, checkpoint: SupervisorCheckpoint, proposed: SupervisorDirectiveKind): SupervisorDirectiveKind {
	if (checkpoint.facts.blockers.length) return "stop";
	// A fill-and-review run is never allowed to cross the final-submit checkpoint. The local
	// bridge independently refuses the click; this turns it into the correct terminal outcome.
	if (checkpoint.facts.phase === "before_submit" && run.policy.mode !== "auto_submit") return "request_review";
	// The model cannot turn an ungated run into an auto-submit run by simply saying continue.
	if (checkpoint.facts.phase === "before_submit" && (!run.policy.gate.allowed || !run.policy.gate.gateId)) return "request_review";
	return proposed;
}

/**
 * Decide the exact checkpoint. Invalid/missing credentials and invalid model output are all a
 * safe review request: no browser write gets released merely because the cloud brain is absent.
 */
export async function decideApplicationCheckpoint(env: Env, uid: string, run: ApplyRun, checkpoint: SupervisorCheckpoint): Promise<SupervisorDirectiveKind> {
	const fallback: SupervisorDirectiveKind = checkpoint.facts.blockers.length ? "stop" : "request_review";
	const brain = await instanceBrain(env, run.instanceId);
	if (!brain) return fallback;
	try {
		const res = (await runUserWorkersAi(
			env,
			uid,
			brain.model,
			{
				messages: [
					{
						role: "system",
						content:
							"You are the cloud brain attached to one Job Application Runner. Decide only the supplied typed checkpoint. " +
							"Never infer facts that are absent. Continue only when the observed facts show no blocker and the next local action can stay within the recorded policy. " +
							"For a before_submit checkpoint, continue only when auto_submit is explicitly gated. Return exactly one decision tool call.",
					},
					{
						role: "user",
						content: JSON.stringify({
							policy: { mode: run.policy.mode, submitGateAllowed: run.policy.gate.allowed, hasSubmitGate: !!run.policy.gate.gateId },
							checkpoint: { schemaVersion: checkpoint.schemaVersion, checkpointId: checkpoint.checkpointId, facts: checkpoint.facts },
						}),
					},
				],
				tools: [DECISION_TOOL],
				toolChoice: "auto",
				maxTokens: 96,
				timeoutMs: 20_000,
			},
			{ kind: "run", instanceId: run.instanceId },
			{ honorModel: brain.modelChosen },
		)) as BrainResponse;
		const call = res.tool_calls?.find((c) => c.name === "decide_application_checkpoint");
		const args = call?.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : null;
		const proposed = parsedDirective(args?.directive);
		return constrainBrainDirective(run, checkpoint, proposed ?? fallback);
	} catch {
		return fallback;
	}
}

/** Persist the brain's first decision. Every retry reads the same immutable directive. */
export async function directApplicationCheckpoint(env: Env, uid: string, run: ApplyRun, checkpoint: SupervisorCheckpoint, now: number): Promise<SupervisorDirective | null> {
	if (checkpoint.directive) return checkpoint.directive;
	const directive = await decideApplicationCheckpoint(env, uid, run, checkpoint);
	const outcome = await issueSupervisorDirective(env, run, uid, {
		checkpointId: checkpoint.checkpointId,
		schemaVersion: SUPERVISOR_SCHEMA_VERSION,
		idempotencyKey: `brain:${checkpoint.checkpointId}`,
		directive,
	}, now);
	return outcome.kind === "missing_checkpoint" ? null : outcome.directive;
}
