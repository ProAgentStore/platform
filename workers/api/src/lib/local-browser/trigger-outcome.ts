/**
 * Carry a scheduled run's OUTCOME back to the trigger that started it (#1582).
 *
 * `dispatchTrigger` records that a `run_local_browser` trigger STARTED its run — the run itself
 * ends minutes later, on the runner. Without this a scan failing every day showed
 * `failureCount: 0, lastError: null` on its trigger. The link is the `runId` the dispatch already
 * wrote into its `agent_trigger_events` payload, so no column is needed.
 */
import type { Env } from "../../types.js";
import { clipMarked } from "../clip-marked.js";

/** Codes a run ends with when the machine was simply not there to take it: a skip, never a failure. */
export const SKIPPED_RUN_CODES: ReadonlySet<string> = new Set(["runner_offline", "runner_unreachable", "runner_overloaded"]);

export async function recordTriggerRunOutcome(
	env: Pick<Env, "DB">,
	run: { id: string; instanceId: string; userId: string },
	outcome: { status: "completed" | "failed" | "cancelled"; errorCode: string | null; error: string | null },
): Promise<void> {
	if (outcome.status === "cancelled") return;
	if (outcome.status === "failed" && outcome.errorCode && SKIPPED_RUN_CODES.has(outcome.errorCode)) return;
	const event = await env.DB.prepare(
		`SELECT trigger_id FROM agent_trigger_events
		  WHERE instance_id = ?1 AND user_id = ?2 AND status = 'succeeded' AND instr(payload, ?3) > 0
		  ORDER BY created_at DESC LIMIT 1`,
	)
		.bind(run.instanceId, run.userId, `"runId":"${run.id}"`)
		.first<{ trigger_id: string }>();
	if (!event) return;
	if (outcome.status === "completed") {
		await env.DB.prepare("UPDATE agent_triggers SET failure_count = 0, last_error = NULL, updated_at = datetime('now') WHERE id = ?1").bind(event.trigger_id).run();
		return;
	}
	const message = `Run ${run.id} failed${outcome.errorCode ? ` (${outcome.errorCode})` : ""}: ${outcome.error ?? "no error recorded"}`;
	await env.DB.prepare("UPDATE agent_triggers SET failure_count = failure_count + 1, last_error = ?2, updated_at = datetime('now') WHERE id = ?1")
		.bind(event.trigger_id, clipMarked(message, 1000, { within: true }))
		.run();
}
