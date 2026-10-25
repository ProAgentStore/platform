/**
 * One capture of the coding pane, with everything a Pilot capture does on the way (#1359): the drained usage and acts are
 * persisted, the merge-authority and write-scope gates are read off the acts, the activity and claim heartbeats are throttled,
 * and the session's and the run's own stop signals are folded into `cancelled`.
 *
 * Moved out of `workflow-run.ts` unchanged. The two pieces of state only a capture used — when the activity heartbeat last cost
 * a subrequest, and which owner-directive ids were already credited — moved in with it.
 */
import { callRunner, READ_TIMEOUT_MS, type RunnerConn } from "../../lib/runner-client.js";
import { isCancelRequested, recordLiveness } from "../../lib/agent-loop-store.js";
import { touchSessionActivity, touchSessionDriver } from "../../lib/coding-store.js";
import { shouldTouchActivity } from "../../lib/coding-idle-poll.js";
import { pilotStopSignal } from "../../lib/coding-session-lifecycle.js";
import { markDirectivesProcessed } from "../../lib/coding-ownership.js";
import { recordEngineUsage } from "../../lib/usage.js";
import type { EngineAuthResolved } from "../../lib/usage-payer.js";
import { sanitizeEngineUsage } from "../../lib/engine-usage.js";
import { appendEngineUsageTimeline } from "../../lib/coding-timeline.js";
import { recordEngineActs, sanitizeEngineActs } from "../../lib/engine-acts.js";
import { recordAuthorityViolations, type MergePolicy } from "../../lib/coding-authority.js";
import { recordRepoScopeViolations } from "../../lib/repo-write-scope.js";
import type { CodingPaneSnapshot } from "../../lib/coding-loop.js";
import type { Env } from "../../types.js";

/**
 * How long one capture keeps the runner believing a platform run owns the session (#1178). The Pilot may spend up to 12 minutes
 * deciding between two captures (`decideRetry`), so the lease is longer than that; the next capture renews it and the closing
 * drain releases it. Capped by the runner at 20 minutes.
 */
export const RUN_OWNERSHIP_LEASE_MS = 15 * 60_000;

export interface CodingCaptureCtx {
	env: Env;
	instanceId: string;
	userId: string;
	sessionId: string;
	loopRunId: string | null | undefined;
	driverId: string | null | undefined;
	/** The repository's display label, for the violation notices. */
	repo: string;
	mergePolicy: MergePolicy;
	/** The repositories this run may write to (#676). */
	writeScope: string[];
	/** The board card the run reports on, for the acts' trace. */
	cardId: string | null;
	/** The machine this run is talking to — read at call time, because the runner guard re-points it. */
	getConn: () => RunnerConn;
}

export function makeCapture(ctx: CodingCaptureCtx): () => Promise<CodingPaneSnapshot & { sessionId: string }> {
	const { env, instanceId, userId, sessionId, loopRunId, driverId, repo, mergePolicy, writeScope, cardId, getConn } = ctx;
	/** When the activity heartbeat last cost a subrequest (#523) — see `shouldTouchActivity`. */
	let lastActivityTouchAt = 0;
	/** Owner-directive ids this run has already recorded as consumed (#1019) — so a poll writes only on news. */
	const creditedInputs = new Set<string>();
	/**
	 * Read the pane AND whether the run should stop.
	 *
	 * `runCodingLoop` branches on `snap.cancelled` in two places and both workflow poll loops
	 * test it — but nothing ever SET it: `CodingSnapshot` has no such field and neither the
	 * runner nor the routes produce one. So the outcome "cancelled" was unreachable in
	 * production, and a user who started a run with the wrong objective had no way to stop it
	 * short of killing the session; the Pilot kept going for up to 12 rounds × 40 steps of
	 * BYOK Claude decisions.
	 *
	 * The signal already exists and is already user-driven: Kill / End / Restart set the
	 * `coding_sessions` row out of 'active'. Reading it here makes those buttons a clean stop
	 * — the loop finishes its current step and returns `cancelled` — instead of the run only
	 * ending indirectly when a later capture happens to fail.
	 *
	 * The SECOND signal is the loop run's own cancel flag (#374). `POST /loop/:runId/cancel`
	 * has always written it and `AgentLoopWorkflow` has always read it; this workflow did not,
	 * which was survivable only while the Coding tab's Loop ran in the browser and Stop meant
	 * "stop scheduling the next setTimeout". Now that Stop reaches the Pilot, it has to be read
	 * here or the button would be recorded and ignored. Which of the two wins, and what is
	 * deliberately NOT a stop, is `pilotStopSignal`.
	 */
	return async (): Promise<CodingPaneSnapshot & { sessionId: string }> => {
		const [snap, row, cancelRequested] = await Promise.all([
			// `drainUsage` — an autonomous Pilot run is exactly the case where no console is
			// open, so this is the only path collecting the Engine's own spend (#267) for the
			// longest and most expensive sessions the platform has.
			callRunner<CodingPaneSnapshot & { sessionId: string; usage?: unknown; acts?: unknown }>(
				getConn(),
				"/coding/capture",
				// `platformRun`: this run owns the session for the next decision (#1178). The lease outlives a Pilot decision (12 min) and is
				// refreshed by the next capture, so the runner's update guard never reads the gap between turns as idle.
				{ sessionId, drainUsage: true, platformRun: { leaseMs: RUN_OWNERSHIP_LEASE_MS } },
				{ timeoutMs: READ_TIMEOUT_MS },
			),
			env.DB.prepare("SELECT status FROM coding_sessions WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
				.bind(sessionId, instanceId, userId)
				.first<{ status: string }>()
				.catch(() => null),
			// Degrades to "not cancelled" on a read failure, for the same reason an unreadable
			// session status does: a D1 blip must not abort a run that is working.
			loopRunId
				? isCancelRequested(env, loopRunId).catch(() => false)
				: Promise.resolve(false),
		]);
		const { usage, acts, ...pane } = snap;
		// The SAME snapshot carries how the engine authenticated (runtime.ts sets it on every
		// capture), so the payer is in hand here exactly as it is on the route drain. Dropping
		// it made the Pilot-driven sessions — the longest and most expensive the platform runs —
		// the only ones recording an unknown payer (#356).
		const pilotUsageRecords = sanitizeEngineUsage(usage);
		await recordEngineUsage(
			env,
			{ userId, sessionId, instanceId, authResolved: (snap as { authResolved?: EngineAuthResolved | null }).authResolved ?? null },
			pilotUsageRecords,
		);
		await appendEngineUsageTimeline(env, { sessionId, instanceId, userId }, pilotUsageRecords);
		const reported = sanitizeEngineActs(acts);
		// An owner directive the runner says a completed turn READ is processed (#1019) — the steer of a
		// running Pilot otherwise never got past "queued", because only a direct turn's watcher marked any.
		const fresh = (pane.consumedInputs ?? []).filter((id) => !creditedInputs.has(id));
		if (fresh.length) {
			await markDirectivesProcessed(env, { instanceId, userId, sessionId, consumed: fresh }).catch(() => 0);
			for (const id of fresh) creditedInputs.add(id);
		}
		// What this run actually DID (#294). Stamped with the loop-run id when there is one, so
		// `/trace?trace_id=<runId>` reconstructs exactly what a delegation did — the record whose
		// absence let run 73ffc073 merge its own PRs to `main` and report only "done".
		await recordEngineActs(
			env,
			{ userId, sessionId, instanceId, traceId: loopRunId ?? null, cardId: cardId },
			reported,
		).catch(() => undefined);
		// MERGE AUTHORITY, the enforcing half (#314). The instruction screen keeps the Pilot from
		// ASKING for a merge; this catches one that happened anyway — the Engine's own initiative,
		// or an engine that ignored the prompt. Protocol fact, not prose: the act came from a
		// `tool_use` event carrying the literal command. The run HALTS on a hit, which is the whole
		// difference from #294: 73ffc073 merged three times because nothing stopped it after the
		// first. It cannot undo that first merge — it bounds the blast radius and asks the owner.
		const stopReason = await recordAuthorityViolations(
			env,
			{ userId, instanceId, sessionId, repoLabel: repo, traceId: loopRunId ?? null },
			mergePolicy,
			reported,
		).catch(() => null);
		if (stopReason) return { ...pane, cancelled: true, stopReason };
		// WRITE SCOPE (#676). The same shape as the merge gate above and independent of it: this
		// asks WHERE the act landed, not what it was. Run `csess_f686f1ff` opened a pull request
		// in another organisation and reported success, because nothing compared the repository
		// it wrote to against the one it was registered for. Halting here cannot undo that first
		// write — the Engine holds the machine's own `gh` login — but it stops the run and names
		// the repository, instead of letting the run finish and claim the work landed.
		const scopeStop = await recordRepoScopeViolations(
			env,
			{ userId, instanceId, sessionId, repoLabel: repo, traceId: loopRunId ?? null },
			writeScope,
			reported,
		).catch(() => null);
		if (scopeStop) return { ...pane, cancelled: true, stopReason: scopeStop };
		// A Pilot capturing is the session being USED (#275). The claim heartbeat already says
		// so on every action, but a single round can sit in `waitIdle` for minutes with no
		// action at all — so the invariant "anything driving the engine keeps it alive" is
		// stated here too rather than inferred from the loop's step budget. ASKED before it is
		// paid for (#523): the store throttles the WRITE to once a minute in a WHERE clause,
		// which left the SUBREQUEST unconditional — a quarter of every poll's cost buying a row
		// update one time in thirty, against a ceiling spent for the life of the whole run.
		// The RUN's heartbeat rides the same throttle (#580). A capture means the orchestrator is
		// driving, so `last_alive_at` is true by construction here — and this is the only place a
		// working run touches D1 at all, since `waitIdle` can poll for minutes with no action.
		// Without it, liveness would only ever be written by the PAUSE tick, i.e. only by runs
		// that stopped, and `isStalled` would read a healthy long turn as dead. `null` clears any
		// park: a run that is capturing is by definition no longer waiting for anything.
		if (shouldTouchActivity(lastActivityTouchAt, Date.now())) {
			lastActivityTouchAt = Date.now();
			await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
			// The CLAIM too (#1019): one engine turn can outlast STALE_DRIVER_MS with no action between it, and a stale claim is stolen and reported lost.
			if (driverId) await touchSessionDriver(env, instanceId, userId, sessionId, driverId).catch(() => undefined);
			if (loopRunId) await recordLiveness(env, loopRunId, Date.now(), null).catch(() => undefined);
		}
		// Which signals stop a run, which deliberately do not (`suspended`, an unreadable
		// status), and which reason the human is given when both fire — all of it is the pure
		// `pilotStopSignal`, so it can be stated as a table rather than as a comment defending
		// an inline ternary nothing could execute.
		//
		// `pane`, not `snap`: the drained usage AND acts have been persisted and must not be
		// carried into the workflow's step state, where a replay would drag them around forever.
		const stop = pilotStopSignal({ sessionStatus: row?.status, cancelRequested });
		return stop.stop ? { ...pane, cancelled: true, stopReason: stop.reason } : pane;
	};
}
