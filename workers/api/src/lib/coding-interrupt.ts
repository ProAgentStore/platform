/**
 * Resuming a coding run through an interruption — inside the workflow, with a published clock (#855).
 *
 * ── What was broken
 *
 * Since #583 an interruption the platform could resume through was handled by rethrowing it out of
 * `CodingSessionWorkflow.run()`, on the understanding that Cloudflare would replay the instance from
 * its journal. An error escaping `run()` does not do that — it ends the instance. So the run row sat
 * `running` / `waiting: platform_interrupt`, with `parkedSince` and `lastAliveAt` frozen, while every
 * surface told the owner it "was interrupted by something other than the work and is being resumed".
 * Nothing was. Instance HeartFull App Coder hit it at the iteration-1→2 handoff of a fresh session and
 * sat for 13 minutes until a person sent the engine a message; an earlier run on the same instance
 * sat until the sweeper closed it ("parked waiting to be resumed and never came back").
 *
 * ── What this is
 *
 * The two halves of a resume the workflow now performs itself, split out so they can be driven in a
 * test without a Cloudflare Workflow:
 *
 *   - {@link planInterruptionResume} — the bookkeeping. Classify, apply the durable bound
 *     (`driverResumePlan`), record the interruption, tell the owner, and park the run WITH the instant
 *     it will retry, so the park has a real `waitingUntil` and every reader can say a resume is
 *     scheduled. Null when the death is not resumable, which the caller turns into an ending.
 *   - {@link roundThroughInterruptions} — run a round; on a resumable death, wait out the backoff on a
 *     durable sleep and run it again, carrying a note that the last instruction may already have landed.
 *
 * The give-up clock is the park itself: published `waitingUntil`, then `PARK_LIMIT_MS` past it, after
 * which `run-sweeper.ts` closes the run as interrupted. A retry that never happens therefore ends
 * loudly on a stated clock instead of hanging under a note that says it is being handled.
 */
import { recordLiveness } from "./agent-loop-store.js";
import { classifyCodingFailure, driverResumePlan, interruptBackoffMs, MAX_PLATFORM_RESUMES, type CodingFailureClass } from "./coding-failure.js";
import { interruptedRoundNote, resumeNotice } from "./coding-run-report.js";
import type { Env } from "../types.js";

/** A resume that has been decided and published: why, and how long to wait before retrying. */
export interface InterruptionResume {
	why: string;
	delayMs: number;
}

export interface InterruptionBookkeeping {
	env: Env;
	/** The loop-run row — the durable bound and the park live on it. Null ⇒ never resumed. */
	runId: string | null;
	/** File the interruption in `error_log` as `resumed` (#546). Best-effort. */
	record: (err: unknown) => Promise<void>;
	/** Say it in the trace. Best-effort. */
	trace: (why: string, meta: { attempt: number; failureClass: CodingFailureClass; retryInMs: number }) => Promise<void>;
	/** Say it in the chat — a silent recovery is still an unexplained one. */
	announce: (text: string) => Promise<void>;
	now: () => number;
}

/**
 * Decide and publish a resume for this death, or return null when it must end the run.
 *
 * MUST NOT throw: it is called from the round's catch, where the alternative is the terminal
 * teardown, so a failure to decide degrades to "do not resume" — `driverResumePlan`'s own contract.
 */
export async function planInterruptionResume(err: unknown, deps: InterruptionBookkeeping): Promise<InterruptionResume | null> {
	const failure = classifyCodingFailure(err);
	const decision = await driverResumePlan(deps.env, failure, deps.runId).catch(() => null);
	if (!decision?.resume || !failure) return null;
	const delayMs = interruptBackoffMs(decision.attempts);
	await deps.record(err).catch(() => undefined);
	await deps.trace(decision.why, { attempt: decision.attempts, failureClass: failure.class, retryInMs: delayMs }).catch(() => undefined);
	await deps.announce(resumeNotice(failure.class, decision.why, decision.attempts, MAX_PLATFORM_RESUMES)).catch(() => undefined);
	// Parked WITH the instant it retries — the difference between "a resume is scheduled" and the
	// false "is being resumed" the park used to carry with nothing behind it.
	if (deps.runId) {
		const at = deps.now();
		await recordLiveness(deps.env, deps.runId, at, { reason: "platform_interrupt", until: at + delayMs }).catch(() => undefined);
	}
	return { why: decision.why, delayMs };
}

export interface RoundDeps {
	/** The bookkeeping for the k-th interruption this execution has seen — journalled by the caller. */
	plan: (err: unknown, k: number) => Promise<InterruptionResume | null>;
	/** A DURABLE sleep in the workflow (`step.sleep`), so the backoff survives an eviction. */
	sleep: (label: string, ms: number) => Promise<unknown>;
	/** Hand the Pilot the platform note before the retried round. */
	resumed: (note: string) => void;
}

/**
 * Run one round, retrying it through interruptions until it returns or a death may not be resumed.
 *
 * Bounded by `plan`, whose durable counter (`driverResumePlan`, {@link MAX_PLATFORM_RESUMES}) returns
 * null past the limit — so this can loop at most that many times, and a death it will not retry is
 * rethrown untouched for the caller's terminal handling.
 *
 * `ordinal` numbers the interruptions this EXECUTION has seen. It lives in the caller because the
 * caller's step names are built from it: a workflow replay re-runs the same code and re-derives the
 * same numbers, so a replayed interruption returns its journalled plan instead of counting again.
 */
export async function roundThroughInterruptions<T>(run: () => Promise<T>, deps: RoundDeps, ordinal: { next: () => number }): Promise<T> {
	for (;;) {
		try {
			return await run();
		} catch (err) {
			const k = ordinal.next();
			const plan = await deps.plan(err, k);
			if (!plan) throw err;
			await deps.sleep(`interrupt-backoff-${k}`, plan.delayMs);
			deps.resumed(interruptedRoundNote(plan.why));
		}
	}
}
