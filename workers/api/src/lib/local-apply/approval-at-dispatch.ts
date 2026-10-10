/**
 * The approval's lifecycle around ONE dispatch (#993) — claim it when the run reaches the machine,
 * hand it back when the run ends without asking the employer.
 *
 * Its own module for two reasons. `apply.ts` crossed the 800-line ratchet, and more usefully these
 * two decisions are a different subject from the dispatch plumbing around them: both are about who
 * holds the owner's one-time permission, and both are the kind of rule worth reading on its own.
 *
 * It takes the gate VERDICT rather than computing one, which is what keeps the dependency one-way:
 * `submitGateFor` lives in `apply.ts` and `apply.ts` imports this. The verdict arrives as a thunk
 * so the gate is only evaluated for a run that could actually be upgraded.
 */
import type { Env } from "../../types.js";
import { getOwnedApplication } from "../local-artifact/store.js";
import { consumeSubmitAuthorization, getSubmitAuthorization, releaseSubmitAuthorization } from "./approval-store.js";
import { type ApplyRun, type ApplyRunPolicy, type ApplyTraceEvent, updateApplyRun } from "./store.js";

const iso = (ms: number) => new Date(ms).toISOString();

/** What the gate decided, as much of it as this module needs. */
export interface GateVerdict {
	allowed: boolean;
	checks: Array<{ check: string; ok: boolean; why?: string }>;
	/** The usable authorization the verdict counted on, when there was one. */
	authorizationId: string | null;
	/** Required to consume a verified-one-click authorization at the durable dequeue consumer. */
	recoveryId?: string;
}

/**
 * Give an approval back when the run that spent it ended without ever asking the employer (#993).
 *
 * The approval is claimed at dispatch — that is the only moment two racing dispatches can be told
 * apart — so every path that ends a run BEFORE a submit was attempted has to hand it back, or the
 * owner's one-time approval is stranded: the application offers `retry_fill`, the retry finds no
 * usable authorization, and it fills-and-reviews again for ever. Live: application `cc90cd13…` ran
 * `auto_submit`, emitted `review.ready`, ended `awaiting_review` with `submitAttempted=false,
 * filled=0`, and the approval was gone with nothing to show for it.
 *
 * Three guards, and all three are the same question asked of different records — did anything
 * reach the employer?
 *
 *   · the application carries no `submit_attempted_at`;
 *   · this run's own trace has no `submit.attempted`;
 *   · the store releases only the row whose `consumed_run_id` IS this run.
 *
 * A run that DID attempt stays spent and terminal, which is the invariant #993 names under Safety:
 * `submitAttempted=true` is `submit_unconfirmed` and is never retried automatically.
 *
 * Best-effort by construction: a failure here must not fail the settle that noticed. The cost of a
 * missed release is the pre-#993 behaviour, which the owner can still resolve by approving again.
 */
export async function releaseApprovalIfNothingWasSent(env: Env, uid: string, run: ApplyRun): Promise<boolean> {
	if (run.policy.mode !== "auto_submit") return false;
	if (run.trace.some((e) => e.type === "submit.attempted")) return false;
	const app = await getOwnedApplication(env, uid, run.applicationId).catch(() => null);
	if (!app || app.submitAttemptedAt) return false;
	const auth = await getSubmitAuthorization(env, run.applicationId, uid).catch(() => null);
	if (!auth || auth.consumedRunId !== run.id) return false;
	return await releaseSubmitAuthorization(env, auth.id, uid, run.id).catch(() => false);
}

/**
 * Re-evaluate the submit gate for a run the queue is about to dispatch (#993).
 *
 * The gate is decided before the machine is asked, and `concurrency` is the one check an approval
 * deliberately does not satisfy — the machine fills one application at a time whatever the owner
 * approved. So an approved application asked to retry while another was filling was created
 * `fill_and_review` with `reason: concurrency`, and the mode was then frozen into the queued row:
 * on dequeue it was dispatched in the mode it earned while the machine was busy, not the mode its
 * approval earns now that it is free. Live: application `b6244557…` stopped `incomplete` at a
 * one-click control holding a usable approval it was never run with.
 *
 * What this does NOT do is as load-bearing as what it does:
 *
 *   · it never DOWNGRADES. A run already in `auto_submit` holds its approval (it spent it), so
 *     re-reading the gate would find `submission_approved` false — the approval is consumed, by
 *     this very run — and "re-evaluating" would strip the mode off exactly the run that earned it.
 *   · it never overrides a review the owner asked for. `review: true` pins `fill_and_review` and
 *     records `review_requested` on the gate; that is a decision, not a transient refusal.
 *   · it upgrades only when the FRESH verdict allows and the approval is still claimable, so a
 *     revoked approval, re-tailored materials or a disabled auto-submit setting all keep the run
 *     exactly where it is.
 */
export async function upgradeQueuedRunPolicy(
	env: Env,
	uid: string,
	run: ApplyRun,
	/** Evaluated only when the run is eligible — see the guards below. */
	gate: () => Promise<GateVerdict>,
	now: number,
): Promise<{ run: ApplyRun; upgraded: boolean }> {
	// Already `auto_submit` means this run spent the approval on an earlier attempt and still holds
	// it. `upgraded: false` is what tells the caller not to hand it back when the machine defers
	// again: the run keeps its mode across attempts, so it must keep the approval that earned it.
	if (run.policy.mode === "auto_submit") return { run, upgraded: false };
	if (run.policy.gate.checks.some((c) => c.check === "review_requested")) return { run, upgraded: false };
	const verdict = await gate();
	if (!verdict.allowed) return { run, upgraded: false };
	// An approval is ONE way the gate comes to allow a submit; the owner's standing auto-submit
	// policy is the other, and a queued run loses that intent in exactly the same way. So the
	// upgrade follows the verdict, and the approval is spent only when there is one to spend —
	// the same order `startApplicationFill` uses, for the same reason: `mode`, `gateId` and the
	// recorded gate all have to derive from one outcome.
	const spent = verdict.authorizationId ? await consumeSubmitAuthorization(env, verdict.authorizationId, uid, run.id, now, verdict.recoveryId ? { id: verdict.recoveryId, runnerInstanceId: run.instanceId } : undefined) : null;
	// A usable approval that another run spent first is a lost race, not a reason to submit anyway.
	if (verdict.authorizationId && !spent) return { run, upgraded: false };
	const gateId = crypto.randomUUID();
	const policy: ApplyRunPolicy = { ...run.policy, mode: "auto_submit", gate: { allowed: true, gateId, checks: verdict.checks } };
	const events: ApplyTraceEvent[] = [
		{ type: "policy.submit_gate", at: iso(now), detail: { mode: "auto_submit", decision: "allowed", gateId, from: "queue" } },
		...(spent ? [{ type: "policy.decision", at: iso(now), detail: { class: "submit", decision: "allowed", basis: "application_approval", authorizationId: spent.id } } as ApplyTraceEvent] : []),
	];
	const updated = await updateApplyRun(env, run, { policy, events }, now);
	// `upgraded` means "this attempt claimed the approval", which is the only thing the caller
	// needs it for: whether to hand one back if the machine defers again.
	if (updated) return { run: updated, upgraded: !!spent };
	// The row moved under us, so the policy was NOT written — hand the approval straight back
	// rather than leaving it spent on a run that is still fill-and-review.
	if (spent) await releaseSubmitAuthorization(env, spent.id, uid, run.id).catch(() => undefined);
	return { run, upgraded: false };
}
