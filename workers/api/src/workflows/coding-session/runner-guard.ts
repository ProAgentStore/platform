/**
 * The coding Workflow's runner guard (#1359): a disconnect is a pause, not an ending.
 *
 * Moved out of `workflow-run.ts` unchanged. It closes over four things the workflow keeps and reassigns — the connection to the
 * machine, the engine last seen, the objective being delivered, and the step counter — so those are passed as accessors rather
 * than copied. Every durable step name it emits is built by `lib/runner-wait-machine.ts` and frozen by
 * `runner-wait-labels.test.ts` and `workflow-step-names.test.ts`.
 */
import type { WorkflowStep } from "cloudflare:workers";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "../../lib/runner-client.js";
import { runtimeConnectivity } from "../../lib/instance-connectivity.js";
import { isRunnerSessionAbsent, makeRunnerGuard, RUNNER_PROBE_INTERVAL, type RunnerGuard, type RunStep } from "../../lib/runner-availability.js";
import { runnerParkDeps, runnerWaitState } from "../../lib/runner-park.js";
import { reassignSessionNode, touchSessionActivity, touchSessionDriver } from "../../lib/coding-store.js";
import { recordLiveness } from "../../lib/agent-loop-store.js";
import { normalizeRunnerNode } from "../../lib/runtime-nodes.js";
import type { ObjectiveDelivery, ObjectiveDeliveryState } from "../../lib/coding-objective-delivery.js";
import type { CodingPaneSnapshot } from "../../lib/coding-loop.js";
import type { Env } from "../../types.js";
import { START_RETRY } from "./step-retry-presets.js";

export interface CodingRunnerGuardCtx {
	env: Env;
	step: WorkflowStep;
	instanceId: string;
	userId: string;
	sessionId: string;
	/** The loop-run row, if the run has one (only such a run can be parked and woken). */
	loopRunId: string | null | undefined;
	driverId: string | null | undefined;
	/** This Workflow instance's id, for the park's wake event. */
	workflowInstanceId: string | undefined;
	runRetry: RunStep;
	runWith: (opts: unknown) => RunStep;
	postToChat: (content: string) => Promise<void>;
	/** The machine this run is talking to; the guard re-points it when a disconnect heals on a different one. */
	getConn: () => RunnerConn;
	setConn: (conn: RunnerConn) => void;
	/** (Re)launch the engine on the machine `getConn()` points at. */
	startOnRunner: () => Promise<unknown>;
	getLastEngine: () => CodingPaneSnapshot["engine"] | null;
	setLastEngine: (engine: CodingPaneSnapshot["engine"] | null) => void;
	getObjective: () => ObjectiveDelivery | null;
	reportObjective: (state: ObjectiveDeliveryState) => Promise<unknown>;
}

export function makeCodingRunnerGuard(ctx: CodingRunnerGuardCtx): RunnerGuard {
	const { env, step, instanceId, userId, sessionId, loopRunId, driverId, workflowInstanceId, runRetry, runWith, postToChat, getConn, setConn, startOnRunner, getLastEngine, setLastEngine, getObjective } = ctx;
	return makeRunnerGuard({
		wait: {
			// JOURNALLED when labelled (#1177): the body replays after every `step.sleep`, and a live read there answers differently the second
			// time (the machine is back), which made the replay take a different path than the original — a budget undercounted.
			probe: (label) =>
				label
					? (runRetry(label, () => runtimeConnectivity(env, instanceId, userId)) as Promise<Awaited<ReturnType<typeof runtimeConnectivity>>>)
					: runtimeConnectivity(env, instanceId, userId),
			// step.sleep, so a ten-minute pause survives the workflow being evicted.
			sleep: (label) => step.sleep(label, RUNNER_PROBE_INTERVAL),
			// Posted once per label however often the body replays past it (#1177).
			announce: async (message, label) => {
				if (!label) return postToChat(message);
				await runRetry(`say-${label}`, async () => {
					await postToChat(message);
					return null;
				});
			},
			// The run still owns this session while it waits. Without the heartbeat a long pause
			// would let its OWN single-flight claim go stale and a second Pilot could take the
			// session out from under it — the collision the claim exists to prevent. And its LIVENESS stays current (#1177) while the run row
			// says `runner_away`: alive and waiting, with no progress claimed.
			tick: async (_waitedMs, label) => {
				const beat = async () => {
					if (driverId) await touchSessionDriver(env, instanceId, userId, sessionId, driverId).catch(() => undefined);
					await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
					if (loopRunId) await recordLiveness(env, loopRunId, Date.now()).catch(() => undefined);
					return null;
				};
				if (label) await runRetry(label, beat);
				else await beat();
			},
			// The wait as run state: `runner_away` and the instant it gives up (#1177). A run without a loop-run row has no row to say it on.
			state: loopRunId ? runnerWaitState(env, runRetry, { runId: loopRunId }) : undefined,
			// After a command the runner did not answer, "back" means it answers `/health` (#1341) — journalled, and a
			// failed check is a plain "not yet" rather than a step error the workflow would retry.
			healthy: (label) =>
				runRetry(label, async () => {
					const live = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
					if (!live) return false;
					return callRunner(live, "/health", undefined, { timeoutMs: READ_TIMEOUT_MS }).then(() => true, () => false);
				}) as Promise<boolean>,
		},
		// The runner restarted and lost the session the run still owns (#1053) — never one the owner ended.
		sessionLost: async (e) =>
			isRunnerSessionAbsent(e) &&
			(await env.DB.prepare("SELECT status FROM coding_sessions WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(sessionId, instanceId, userId).first<{ status: string }>())?.status === "active",
		// A machine away past the poll parks the run until it re-registers (#1160); only a run with a loop-run row can be woken.
		park: loopRunId ? runnerParkDeps(env, step, runRetry, { runId: loopRunId, workflowInstanceId: workflowInstanceId ?? loopRunId }) : undefined,
		reconnect: async (label) => {
			// The machine that comes back may not be the machine that went away — a user closing
			// one laptop and opening another is the ordinary case. Re-resolve live (pin-aware),
			// relocate the session's owning node, then relaunch the engine there.
			const back = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
			if (back) {
				if (normalizeRunnerNode(back.runnerNode) !== normalizeRunnerNode(getConn().runnerNode)) {
					await reassignSessionNode(env, instanceId, userId, sessionId, back.runnerNode ?? null).catch(() => undefined);
				}
				setConn(back);
			}
			const started = (await runWith(START_RETRY)(`restart-${label}`, startOnRunner)) as CodingPaneSnapshot | null;
			setLastEngine(started?.engine ?? getLastEngine());
			// The engine back may be the same process, a replacement or another machine's, which may not render the
			// objective: re-read its capabilities (journalled per reconnect), and let its named identity decide (#1019).
			const objective = getObjective();
			if (objective) {
				const caps = await runRetry(`objective-capabilities-${label}`, () => callRunner(getConn(), "/capabilities", {})).catch(() => null);
				const settled = objective.capabilities(caps, { reconnected: true, runnerNode: getConn().runnerNode ?? null });
				objective.engine(started?.engine);
				if (settled) await ctx.reportObjective(settled);
			}
		},
	});
}
