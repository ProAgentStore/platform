/**
 * How a chat (agent) loop run is settled: its terminal write, the event, the escalation up the supervision ladder and the
 * owner's push. Moved out of `workflows/agent-loop.ts`'s `finish` step unchanged (#1362) so it can be tested — the
 * workflow has no harness — and so the rule it now carries is checked: a run something else settled first is not
 * logged, escalated or pushed with a reason it never recorded.
 */
import { needsHuman, type LoopStopReason } from "./agent-loop.js";
import { finishLoopRun, type FinishOutcome } from "./agent-loop-store.js";
import { deepLinkFor } from "./console-links.js";
import { logEvent } from "./events.js";
import { logError } from "./error-log.js";
import { escalationNote, escalationTarget } from "./escalation.js";
import { loadGraph } from "./supervision.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

export async function settleChatLoopRun(
	env: Env,
	run: { runId: string; userId: string; instanceId: string; objective: string },
	stop: { reason: LoopStopReason; message: string },
): Promise<FinishOutcome> {
	const { runId, userId, instanceId, objective } = run;
	const now = Date.now();
	const finished = await finishLoopRun(env, runId, stop.reason, stop.message, now);
	// Something else settled the run first — the owner's stop, landed by the cancel sweep (#1362). Its verdict stands, so
	// this one must not be logged, escalated to a supervisor or pushed as "Your agent needs you" with a reason the run
	// never recorded. Same rule as the coding workflow's `superseded` return (#1015).
	if (finished === "superseded") return finished;
	await logEvent(env, {
		source: "loop",
		event: stop.reason,
		message: `Loop ${stop.reason}: ${stop.message}`.slice(0, 500),
		userId,
		instanceId,
		traceId: runId,
		level: needsHuman(stop.reason) ? "warn" : "info",
	}).catch(() => undefined);
	// #157: climb the ladder before waking anyone. Three subordinates under one Lead means
	// three pings to the same person otherwise, each missing the context the Lead has —
	// a hierarchy that amplifies interrupts instead of absorbing them.
	if (needsHuman(stop.reason)) {
		const graph = await loadGraph(env, userId).catch(() => []);
		const target = escalationTarget(graph, instanceId, 0);
		if (target.kind === "supervisor") {
			const note = escalationNote({
				subordinateName: instanceId,
				objective,
				reason: stop.reason,
				detail: stop.message,
			});
			// Told, not triggered: a board card the supervisor can see plus a note in its
			// thread. Auto-resolution would start spending unprompted and is a bigger
			// decision than routing an interrupt.
			// The card IS the escalation. Swallowing this INSERT and returning anyway meant a
			// run that needed a human ended with NOBODY told — no supervisor card, and the
			// `notifyUser` fallback below skipped by the early return. Silence is the one
			// outcome #157 must never produce, so a failed card falls through to waking the
			// human instead of pretending the ladder was climbed.
			const escalated = await env.DB.prepare(
				`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
				 VALUES (?1, ?2, ?3, 'escalation', 'needs_human', ?4, datetime('now'), datetime('now'))`,
			)
				.bind(
					`esc-${runId}`,
					target.instanceId,
					userId,
					JSON.stringify({
						id: `esc-${runId}`,
						type: "escalation",
						status: "needs_human",
						title: `A supervised agent needs a decision`,
						reasoning: note,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					}),
				)
				.run()
				.then(
					() => true,
					async (e: unknown) => {
						await logError(env, {
							source: "loop",
							userId,
							message: `escalation card for ${instanceId} → ${target.instanceId} could not be written; waking the human instead: ${e instanceof Error ? e.message : String(e)}`,
							context: { instanceId, supervisorId: target.instanceId, runId },
						}).catch(() => undefined);
						return false;
					},
				);
			if (escalated) {
				await logEvent(env, {
					source: "loop",
					event: "escalated_to_supervisor",
					message: `${instanceId} → ${target.instanceId} (hop ${target.hops})`,
					userId,
					instanceId: target.instanceId,
					traceId: runId,
					level: "warn",
				}).catch(() => undefined);
				return finished; // the human is NOT interrupted at this level
			}
		}
	}
	if (needsHuman(stop.reason)) {
		// The Assistant, where the loop's own conversation is — and where a human answers it.
		// This used to be `/console/#/instances/<id>`, a hash path on a BrowserRouter: the
		// router never reads a fragment, so the tap opened the console and stopped at
		// whatever screen the user had last (#344).
		await notifyUser(
			env,
			userId,
			"loop",
			"Your agent needs you",
			stop.message.slice(0, 200),
			deepLinkFor({ kind: "assistant", instanceId }),
			// One run stops once. `alert` because the run has STOPPED and only a human
			// restarts it — never muted (#360).
			{ key: `loop:${runId}:${stop.reason}`, kind: "alert", instanceId },
		).catch(() => undefined);
	}
	return finished;
}
