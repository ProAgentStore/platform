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
import { type ApplyRun, type ApplyTraceEvent, updateApplyRun } from "./store.js";
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

/**
 * The phases where the next local action CANNOT submit, so continuing is safe (#982).
 *
 * `uncertain` is deliberately absent: it is the runner saying it does not know what it is looking
 * at, which is the "unknown or unsafe condition" that must still stop. `before_submit` is absent
 * because it is the one checkpoint that CAN release an irreversible outward action.
 */
const ROUTINE_PHASES: ReadonlySet<string> = new Set(["initial", "post_navigation"]);

/** Who decided, which is the difference between a rule and a guess. */
export type DirectiveSource = "policy" | "brain";

/**
 * Why, as a closed id — never prose, and never a page value. These ride the run's trace, which an
 * owner, the board and MCP all read (#975's rule: structured causes, no free text).
 */
export type DirectiveReason =
	| "blocker"
	| "fill_and_review_never_submits"
	| "no_submit_authorization"
	| "routine_checkpoint_cannot_submit"
	| "unknown_phase_needs_review"
	| "brain_unavailable"
	| "brain_decision";

export interface CheckpointDecision {
	directive: SupervisorDirectiveKind;
	source: DirectiveSource;
	reason: DirectiveReason;
	/** True when policy overrode what the model asked for — the #982 failure, made visible. */
	overrodeBrain: boolean;
}

/**
 * The checkpoint decision. PURE, and policy-first (#982).
 *
 * The live failure this is written against: two runs reached `awaiting_review` at the runner's
 * INITIAL checkpoint with `filled: 0, uploaded: 0` and no blocker. Nothing was wrong with the page;
 * the brain simply proposed `request_review`, and before this a proposal passed straight through —
 * so a `fill_and_review` workflow stopped before it filled anything, and the owner was shown a
 * "review" state with nothing to review.
 *
 * The rule that fixes it is not "trust the model less"; it is that at a routine, non-final,
 * blocker-free checkpoint, review is not a legitimate OUTCOME. There is nothing to look at, and the
 * next local action cannot submit, so continuing is the only safe answer — and it is therefore
 * decided deterministically, whatever the model said and whether or not it answered at all.
 *
 * The safety rules keep their precedence, in this order:
 *   1. a blocker stops, whatever anyone proposes;
 *   2. `fill_and_review` never crosses the final-submit checkpoint;
 *   3. nor does an ungated run, so a model cannot turn one into an auto-submit by saying continue;
 *   4. only then does the routine auto-continue apply;
 *   5. a phase this platform does not recognise as routine keeps asking for a person.
 */
export function decideCheckpoint(run: ApplyRun, checkpoint: SupervisorCheckpoint, proposed: SupervisorDirectiveKind | null): CheckpointDecision {
	const phase = checkpoint.facts.phase;
	const policy = (directive: SupervisorDirectiveKind, reason: DirectiveReason): CheckpointDecision => ({
		directive,
		source: "policy",
		reason,
		overrodeBrain: proposed !== null && proposed !== directive,
	});
	if (checkpoint.facts.blockers.length) return policy("stop", "blocker");
	// The local bridge independently refuses the click; this turns it into the correct outcome.
	if (phase === "before_submit" && run.policy.mode !== "auto_submit") return policy("request_review", "fill_and_review_never_submits");
	if (phase === "before_submit" && (!run.policy.gate.allowed || !run.policy.gate.gateId)) return policy("request_review", "no_submit_authorization");
	// #982: routine, non-final, nothing wrong — continue, and say that the platform decided it.
	if (ROUTINE_PHASES.has(phase)) return policy("continue", "routine_checkpoint_cannot_submit");
	// `before_submit` WITH a valid one-shot gate, or a phase we do not recognise as routine. The
	// model's judgement is used where it has one; with no answer the owner is asked, because the
	// only actions left here are the ones that reach the employer.
	if (!proposed) return policy("request_review", phase === "before_submit" ? "brain_unavailable" : "unknown_phase_needs_review");
	return { directive: proposed, source: "brain", reason: "brain_decision", overrodeBrain: false };
}

/**
 * Policy has the final word even when a model chooses an unsafe action.
 *
 * Kept as the directive-only view of {@link decideCheckpoint} — callers that only need the verdict
 * do not have to destructure a record, and there is still exactly one set of rules.
 */
export function constrainBrainDirective(run: ApplyRun, checkpoint: SupervisorCheckpoint, proposed: SupervisorDirectiveKind): SupervisorDirectiveKind {
	return decideCheckpoint(run, checkpoint, proposed).directive;
}

/**
 * Decide the exact checkpoint. Invalid/missing credentials and invalid model output are all a
 * safe review request: no browser write gets released merely because the cloud brain is absent.
 */
export async function decideApplicationCheckpoint(env: Env, uid: string, run: ApplyRun, checkpoint: SupervisorCheckpoint): Promise<CheckpointDecision> {
	const brain = await instanceBrain(env, run.instanceId);
	// No brain configured, or it could not be read: the POLICY still decides. Before #982 this fell
	// straight to `request_review`, which is how a safe initial checkpoint became a terminal review
	// state with nothing filled — the model being absent is not a reason to stop safe work.
	if (!brain) return decideCheckpoint(run, checkpoint, null);
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
		return decideCheckpoint(run, checkpoint, proposed);
	} catch {
		// A model that errored is a model that did not answer.
		return decideCheckpoint(run, checkpoint, null);
	}
}

/**
 * The trace line a decision leaves behind (#982) — the phase it was taken at, the progress that
 * made it safe or not, WHO decided and WHY.
 *
 * Pure, and a closed vocabulary throughout: ids, counts and a phase, never a page value, a typed
 * answer or a browser snapshot. This is what lets an owner (and the board, and MCP) see that a run
 * continued because the platform decided it rather than because a model happened to say so — the
 * fact that was missing when two runs stopped at `filled: 0`.
 */
export function checkpointDecisionEvent(checkpoint: SupervisorCheckpoint, decision: CheckpointDecision, at: string): ApplyTraceEvent {
	const f = checkpoint.facts;
	return {
		type: "policy.decision",
		at,
		detail: {
			class: "checkpoint",
			checkpointId: checkpoint.checkpointId,
			phase: f.phase,
			decision: decision.directive,
			source: decision.source,
			reason: decision.reason,
			actions: f.actions,
			filled: f.filled,
			uploaded: f.uploaded,
			// Joined rather than an array: a trace detail holds scalars, and these are closed ids.
			...(f.blockers.length ? { blockers: f.blockers.join(",") } : {}),
			...(decision.overrodeBrain ? { overrodeBrain: true } : {}),
		},
	};
}

/**
 * Persist the first decision for this checkpoint, with its rationale on the run's trace. Every
 * retry reads the same immutable directive.
 */
export async function directApplicationCheckpoint(env: Env, uid: string, run: ApplyRun, checkpoint: SupervisorCheckpoint, now: number): Promise<SupervisorDirective | null> {
	if (checkpoint.directive) return checkpoint.directive;
	const decision = await decideApplicationCheckpoint(env, uid, run, checkpoint);
	const outcome = await issueSupervisorDirective(env, run, uid, {
		checkpointId: checkpoint.checkpointId,
		schemaVersion: SUPERVISOR_SCHEMA_VERSION,
		idempotencyKey: `brain:${checkpoint.checkpointId}`,
		directive: decision.directive,
	}, now);
	if (outcome.kind === "missing_checkpoint") return null;
	// Recorded only for the decision that was actually STORED (`issued`), so a replay does not
	// write the rationale again. Best-effort: losing the audit line must not lose the directive.
	if (outcome.kind === "issued") {
		// `events` with no `to` appends to the trace and leaves the status alone — the run is still
		// paused at this checkpoint, and the directive's delivery is what moves it.
		await updateApplyRun(env, run, { events: [checkpointDecisionEvent(checkpoint, decision, new Date(now).toISOString())] }, now).catch(() => undefined);
	}
	return outcome.directive;
}
