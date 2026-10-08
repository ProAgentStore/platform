/**
 * "Approve & continue" — the owner's decision on an application they have now LOOKED at (#981).
 *
 * ── What was missing
 *
 * #973 gave one application one single-use submission authorization, and offered it at exactly one
 * moment: `materials_ready`, BEFORE anything was filled. #982 then made a review-mode run stop
 * deterministically at its `before_submit` checkpoint. Put together, the product contradicted
 * itself: an owner could ask for a review-mode fill, watch it reach `awaiting_review` with the
 * employer's form populated — and have no way to say "that one, send it". The live queue offered
 * `defer`, `archive` and `mark_not_interested`. The strongest moment to decide was the one moment
 * with no decision available.
 *
 * ── What this adds, and what it refuses to add
 *
 * The SAME authorization model, available at the post-fill stage (`approval.ts` `approvalStageOf`).
 * One application, one single-use grant, fingerprinted against the lead revision and the artifact
 * digests, consumed atomically by the one run that may submit. Nothing here touches
 * `ApplicationRunnerSettings`: a per-application approval is not a policy, and #981's "never widen
 * global auto-submit" is kept by construction — this module cannot reach that record.
 *
 * ── Resuming the EXACT run, and what happens when that is impossible
 *
 * A directive is immutable per checkpoint (`supervision.ts`) and a `request_review` directive ENDS
 * the run on the runner (`local-apply/runtime.ts`), closing the browser session with it. So there
 * are two genuinely different situations, and conflating them is how an owner would end up with two
 * applications sent to one employer:
 *
 *   the run is still parked at a checkpoint nobody has answered  →  issue `continue` for THAT
 *       checkpoint id, and the engine carries on in the session that is already open.
 *   the run has ended (or the machine no longer holds it)        →  there is nothing to resume.
 *       Say so, name the recoverable path, and create NOTHING.
 *
 * The second case is the one #981 is explicit about: "fail explicitly with a recoverable path; never
 * silently recreate or double-submit". So this does not start a fresh fill behind the owner's back.
 * It grants the authorization — which is the durable half of their decision, and survives — and
 * reports that the session is gone and that `retry_fill` is what spends it. The retry is a second
 * explicit act by the owner, and because the authorization is single-use and the gate refuses an
 * application that has already attempted a submit, neither act can be doubled into two submissions.
 */
import { HttpError } from "../auth.js";
import { deliverSupervisorDirective } from "./apply.js";
import { type ApprovalRunContext, type ApprovalStage, approvalEligibility, approvalStageOf, approvalState } from "./approval.js";
import { getSubmitAuthorization, grantSubmitAuthorization, type GrantOutcome } from "./approval-store.js";
import { SUPERVISOR_SCHEMA_VERSION, issueSupervisorDirective, listSupervisorCheckpoints } from "./supervision.js";
import { type ApplyRun, isTerminalApplyRun, updateApplyRun } from "./store.js";
import type { JobApplication } from "../local-artifact/store.js";
import type { Env } from "../../types.js";

/**
 * Why the exact correlated run could not be continued. A closed vocabulary, because the console and
 * MCP both branch on it and a free-text reason is a reason nobody can act on.
 */
export const CONTINUE_REFUSALS = ["no_run", "run_ended", "not_paused_at_checkpoint", "checkpoint_already_directed", "directive_conflict"] as const;
export type ContinueRefusal = (typeof CONTINUE_REFUSALS)[number];

/** The one recoverable path out of every refusal: a fresh run that spends the authorization. */
export const CONTINUE_RECOVERY = "retry_fill" as const;

export type Continuation =
	| { kind: "continued"; runId: string; checkpointId: string; directive: "continue"; delivered: boolean; detail: string }
	| { kind: "not_resumable"; runId: string | null; reason: ContinueRefusal; recovery: typeof CONTINUE_RECOVERY; detail: string };

/**
 * What the owner is told when the exact run cannot be continued. PURE, so the sentence an owner
 * acts on is asserted without a database — and every one of them names the same next step, because
 * a refusal that does not is how #981's application sat in `awaiting_review` with nothing to do.
 */
export function refusalDetail(reason: ContinueRefusal, runId: string | null): string {
	const run = runId ? `run ${runId}` : "that fill";
	const tail = "Your approval is recorded and held for this application: `retry_fill` starts a fresh run that spends it and may submit once. Nothing has been sent, and nothing was started automatically.";
	switch (reason) {
		case "no_run":
			return `This application has no fill run to continue. ${tail}`;
		case "run_ended":
			return `The browser session for ${run} has ended, so the filled form it had open cannot be resumed — the runner closed it when the run stopped for your review. ${tail}`;
		case "not_paused_at_checkpoint":
			return `${run} is not parked at a supervisor checkpoint, so there is no checkpoint to release. ${tail}`;
		case "checkpoint_already_directed":
			return `The checkpoint ${run} stopped at was already answered (a directive is recorded for it and cannot be revised), and that answer ended the run. ${tail}`;
		case "directive_conflict":
			return `Another decision is already recorded for ${run} under this key. ${tail}`;
	}
}

/**
 * Release the checkpoint the correlated run is parked at, if it is parked at one.
 *
 * The LATEST checkpoint with no directive is the one the run is waiting on: `listSupervisorCheckpoints`
 * is ordered oldest-first, and earlier checkpoints of the same run were already answered to get
 * here. A checkpoint that already carries a directive is not re-decided — immutability per
 * checkpoint is what makes a retried delivery an unambiguous operation, and overriding it here
 * would make "the recorded decision" mean whoever asked last.
 */
export async function continueCorrelatedRun(env: Env, uid: string, run: ApplyRun | null, idempotencyKey: string, now: number): Promise<Continuation> {
	const refuse = (reason: ContinueRefusal): Continuation => ({ kind: "not_resumable", runId: run?.id ?? null, reason, recovery: CONTINUE_RECOVERY, detail: refusalDetail(reason, run?.id ?? null) });
	if (!run) return refuse("no_run");
	if (isTerminalApplyRun(run.status)) return refuse("run_ended");
	if (run.status !== "paused" || run.pause?.reason !== "supervisor_checkpoint") return refuse("not_paused_at_checkpoint");
	const checkpoints = await listSupervisorCheckpoints(env, run);
	// Undirected, or ALREADY carrying this very decision: the second half is what makes a
	// double-clicked Approve idempotent rather than "already answered". The key is derived from the
	// authorization, which is itself one per application, so a repeat of the same decision converges
	// on the same directive while somebody else's decision on the same checkpoint still conflicts.
	const open = [...checkpoints].reverse().find((c) => !c.directive || (c.directive.directive === "continue" && c.directive.idempotencyKey === idempotencyKey));
	if (!open) return refuse(checkpoints.length ? "checkpoint_already_directed" : "not_paused_at_checkpoint");
	const issued = await issueSupervisorDirective(env, run, uid, { checkpointId: open.checkpointId, schemaVersion: SUPERVISOR_SCHEMA_VERSION, idempotencyKey, directive: "continue" }, now);
	if (issued.kind === "missing_checkpoint") return refuse("not_paused_at_checkpoint");
	if (issued.kind === "idempotency_conflict") return refuse("directive_conflict");
	if (issued.kind === "checkpoint_already_directed") return refuse("checkpoint_already_directed");
	// Delivery is best-effort BY DESIGN: the directive is durable, and the status pull retries an
	// undelivered one with the same checkpoint and the same decision (`syncApplyRun`). `delivered`
	// is reported rather than hidden so the owner knows whether the engine has it yet.
	const delivered = await deliverSupervisorDirective(env, uid, run, issued.directive, now).catch(() => null);
	return {
		kind: "continued",
		runId: run.id,
		checkpointId: open.checkpointId,
		directive: "continue",
		delivered: !!delivered?.deliveredAt,
		detail: delivered?.deliveredAt
			? `The engine was released at checkpoint ${open.checkpointId} and is continuing in the session it already has open.`
			: `Continue was recorded for checkpoint ${open.checkpointId}; the machine has not acknowledged it yet and the next status pull delivers the same decision.`,
	};
}

/**
 * Is an approval on this application the POST-FILL decision? One definition, read by the action
 * table that offers the button and by the action that performs it — a card that offered a button
 * the service then refused (or hid one it would accept) is the drift this prevents.
 */
export function isPostFillApproval(app: Pick<JobApplication, "status">, run: { status: string; pause?: unknown } | null): boolean {
	const context: ApprovalRunContext | null = run ? { status: run.status, pauseReason: (run.pause as { reason?: string } | null)?.reason ?? null } : null;
	return approvalStageOf(app, context) === "post_fill";
}

export interface ApproveContinueOutcome {
	stage: ApprovalStage;
	approval: GrantOutcome["kind"];
	authorizationId: string;
	continuation: Continuation;
}

/**
 * The whole post-fill decision, in the order that makes it safe to retry.
 *
 * 1. Eligibility — pure, and the security boundary: no second approval for one application, nothing
 *    after a submit was attempted.
 * 2. The grant — idempotent on the application, so a double-clicked button, a retried MCP call and
 *    a redelivered request converge on ONE authorization rather than minting a second.
 * 3. The continuation — attempted only after the decision is durable, because the authorization is
 *    the half that must survive a failed resume. If this were done first, a crash between the two
 *    would leave a released checkpoint with nobody's permission behind it.
 * 4. The trace — the approval, what it was spent on, and what happened to the resume, on the run's
 *    own timeline, which is what `applicationTrace` reads.
 */
export async function approveAndContinue(
	env: Env,
	uid: string,
	app: JobApplication,
	run: ApplyRun | null,
	input: { idempotencyKey: string; approvedBy?: string },
	now: number,
): Promise<ApproveContinueOutcome> {
	const runContext: ApprovalRunContext | null = run ? { status: run.status, pauseReason: run.pause?.reason ?? null } : null;
	const stage = approvalStageOf(app, runContext);
	if (stage !== "post_fill") throw new HttpError(409, `This application is ${app.status}; there is no filled form waiting for a submission decision.`);
	const existing = await getSubmitAuthorization(env, app.id, uid);
	// A LIVE authorization is this very decision, already recorded — a double-clicked button, a
	// retried MCP call, a repeated request after a lost response. #981 asks for an idempotent action,
	// so that converges on the authorization that exists instead of refusing with "already approved",
	// and the continuation below is re-attempted and re-reported for it. Everything else goes through
	// the eligibility rule, which is the security boundary: a SPENT authorization still refuses,
	// because a second grant would hide a second send.
	if (!(existing && approvalState(existing, app).usable)) {
		const eligible = approvalEligibility(app, existing, stage);
		if (!eligible.eligible) throw new HttpError(409, `This application cannot be approved: ${eligible.why}.`);
	}

	const granted = await grantSubmitAuthorization(env, { app, instanceId: app.instanceId, userId: uid, approvedBy: input.approvedBy ?? "owner", idempotencyKey: input.idempotencyKey }, now);
	const continuation = await continueCorrelatedRun(env, uid, run, `continue:${granted.authorization.id}`, now);

	if (run) {
		// On the RUN's trace, where `applicationTrace` already reads it — one timeline carrying the
		// decision, the resume attempt and (through the run that spends it) the employer's answer.
		await updateApplyRun(
			env,
			run,
			{
				events: [
					{
						type: "policy.decision",
						at: new Date(now).toISOString(),
						detail: {
							class: "submit",
							decision: "approved",
							basis: "owner_application_approval",
							stage,
							authorizationId: granted.authorization.id,
							approval: granted.kind,
							continued: continuation.kind === "continued",
							...(continuation.kind === "continued" ? { checkpointId: continuation.checkpointId, directive: continuation.directive, delivered: continuation.delivered } : { reason: continuation.reason, recovery: continuation.recovery }),
						},
					},
				],
			},
			now,
		).catch(() => undefined);
	}
	return { stage, approval: granted.kind, authorizationId: granted.authorization.id, continuation };
}

/**
 * The reply, shaped once (#981: "Console Board and MCP must expose exactly the same permitted
 * action and result"). Both surfaces call the same route and this is the only thing that builds
 * its body, so there is no second shape for one of them to drift into.
 *
 * `resumable` is the field a caller branches on, `reason`/`recovery` are the closed vocabulary
 * behind a false one, and `nextAction` is the sentence to show a person verbatim.
 */
export function approveContinueResult(out: ApproveContinueOutcome): Record<string, unknown> {
	const c = out.continuation;
	return {
		outcome: c.kind,
		approval: out.approval,
		stage: out.stage,
		authorizationId: out.authorizationId,
		runId: c.runId,
		resumable: c.kind === "continued",
		...(c.kind === "continued" ? { checkpointId: c.checkpointId, directive: c.directive, delivered: c.delivered } : { reason: c.reason, recovery: c.recovery }),
		nextAction: c.detail,
	};
}
