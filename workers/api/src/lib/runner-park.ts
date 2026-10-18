/**
 * A coding run parked on its MACHINE, at zero compute (#1160).
 *
 * The runner guard (`runner-availability.ts`) polls a disconnect for ten minutes, which covers a blip.
 * A machine away longer — a lid shut for lunch or overnight, an update that took it down — used to
 * end the run `runner_gone`, and nothing continued it when the machine came back. Now the guard parks
 * the run: the park is recorded on the run row (`runner_away`, with its `waiting_until`), the Workflow
 * waits on `step.waitForEvent`, and the machine's re-registration (`POST /:id/runtime`) sends the
 * event. The event carries nothing the run trusts: woken, the run asks the relay whether a socket is
 * up, so a stale or duplicate event is a look that finds nothing. The guard also looks on its own
 * every `RUNNER_PARK_CHECK_MS`, so a lost event costs minutes rather than the run.
 *
 * Same shape as the question park (`coding-park.ts`, #1076), and it shares its column: the run row's
 * `workflow_instance_id` is where an event for this run is sent.
 */
import type { WorkflowStep } from "cloudflare:workers";
import type { Env } from "../types.js";
import { recordLiveness } from "./agent-loop-store.js";
import { recordParkedWorkflow } from "./coding-park.js";
import { type RunnerParkDeps, runnerBackEventType, type RunStep } from "./runner-availability.js";

/** The durable park the guard drives, for a run that has a loop-run row to be woken through. */
export function runnerParkDeps(env: Env, step: WorkflowStep, run: RunStep, ids: { runId: string; workflowInstanceId: string }): RunnerParkDeps {
	return {
		now: async (label) => (await run(label, async () => Date.now())) as number,
		begin: async (label, until) => {
			await run(label, async () => {
				await recordParkedWorkflow(env, ids.runId, ids.workflowInstanceId);
				await recordLiveness(env, ids.runId, Date.now(), { reason: "runner_away", until });
				return null;
			});
		},
		waitForBack: (label, timeoutMs) =>
			step.waitForEvent(label, { type: runnerBackEventType(ids.runId), timeout: timeoutMs }).then(
				() => true,
				() => false,
			),
		end: async (label) => {
			await run(label, async () => {
				await recordLiveness(env, ids.runId, Date.now(), null);
				return null;
			});
		},
	};
}

/**
 * Wake every run of this instance parked on its machine — called when a machine registers. Returns
 * how many were sent an event. Never throws: registration must not fail for a wake, and every parked
 * run looks again on its own.
 */
export async function wakeRunnerParkedRuns(env: Pick<Env, "DB" | "CODING_SESSION">, instanceId: string, userId: string): Promise<number> {
	try {
		const { results } = await env.DB.prepare(
			`SELECT run_id, workflow_instance_id AS wf FROM agent_loop_runs
			  WHERE instance_id = ?1 AND user_id = ?2 AND status = 'running' AND waiting_reason = 'runner_away' AND workflow_instance_id IS NOT NULL
			  LIMIT 25`,
		)
			.bind(instanceId, userId)
			.all<{ run_id: string; wf: string }>();
		let woken = 0;
		for (const r of results ?? []) {
			try {
				const instance = await env.CODING_SESSION.get(r.wf);
				await instance.sendEvent({ type: runnerBackEventType(r.run_id), payload: { why: "registered" } });
				woken++;
			} catch {
				// The run looks again on its own within RUNNER_PARK_CHECK_MS.
			}
		}
		return woken;
	} catch {
		return 0;
	}
}
