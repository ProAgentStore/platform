/**
 * The owner abandons a coding run (#1709, a slice of #1670).
 *
 * "Stop" (`requestCancel`) is a cooperative flag: it ends a run that is still working and leaves everything the run was
 * waiting on where it was. For a run parked on a question that is not enough. The question row stays open (the minute
 * sweep keeps nudging, the brain may still decide it), an answer that arrives later is recorded as `late` and kept
 * "for the resume", and a run closed `decision` (workflow gone, `park-recovery.ts`) leaves that answer unapplied for
 * whoever continues the work. Abandoning is the owner's explicit decision that this run is over, so it also
 * closes every question the run still holds and marks each one consumed, which is what `storedAnswer` and
 * `ANSWER_PENDING_SQL` read: nothing is left that could resume it, and a later answer is only a line in the history
 * (`already_applied`).
 *
 * Order matters. The questions are closed FIRST, so an answer racing the stop finds a consumed question and cannot wake
 * the run into applying it; then the cancel flag is set and the parked workflow woken so it leaves through its own
 * terminal path. A parked run whose workflow is already gone is settled `cancelled` here, since nothing would ever read
 * the flag (the sweeper would close it `decision`, continuable, which is the opposite of abandoning).
 *
 * It is an owner action. No agent tool reaches it: it is not in the tool registry, only in the owner's route and MCP.
 */
import { finishLoopRun, requestCancel } from "./agent-loop-store.js";
import { statusFor } from "./agent-loop.js";
import { setCodingSessionCardStatus } from "./coding-board.js";
import { OPEN_QUESTION_STATES } from "./coder-question-store.js";
import { wakeParkedRunDetailed } from "./coding-park.js";
import { logEvent } from "./events.js";
import { tryDequeueAndStart } from "./objective-queue-start.js";
import type { Env } from "../types.js";

export interface AbandonResult {
	runId: string;
	/** The run's status before this call. */
	was: string;
	/** Questions this call closed or marked consumed. */
	questionsCleared: number;
	/** `cancelling` while a live workflow finishes its step, `cancelled` when this call settled it, `already_ended` for a run that was not running. */
	outcome: "cancelling" | "cancelled" | "already_ended";
}

/** Close every unconsumed question of a run and mark it applied, so no answer can resume it. Returns how many rows changed. */
export async function clearRunQuestions(env: Pick<Env, "DB">, runId: string, now = Date.now()): Promise<number> {
	const open = OPEN_QUESTION_STATES.map((s) => `'${s}'`).join(",");
	const res = await env.DB.prepare(
		`UPDATE coder_questions
		    SET history = json_insert(history, '$[#]', json_object('at', ?2, 'from', state, 'to', CASE WHEN state IN (${open}) THEN 'expired' ELSE state END, 'note', 'abandoned by the owner: no answer to this question will resume the run')),
		        state = CASE WHEN state IN (${open}) THEN 'expired' ELSE state END,
		        resolved_at = COALESCE(resolved_at, ?2), applied_at = ?2, applied_run_id = ?1
		  WHERE run_id = ?1 AND applied_at IS NULL`,
	)
		.bind(runId, now)
		.run();
	return res.meta?.changes ?? 0;
}

/** Abandon one of the owner's runs. Null when the run is not theirs on this instance. Idempotent. */
export async function abandonRun(env: Env, input: { userId: string; instanceId: string; runId: string }, now = Date.now()): Promise<AbandonResult | null> {
	const run = await env.DB.prepare("SELECT status, waiting_reason, session_id FROM agent_loop_runs WHERE run_id = ?1 AND user_id = ?2 AND instance_id = ?3")
		.bind(input.runId, input.userId, input.instanceId)
		.first<{ status: string; waiting_reason: string | null; session_id: string | null }>();
	if (!run) return null;
	const questionsCleared = await clearRunQuestions(env, input.runId, now);
	const result: AbandonResult = { runId: input.runId, was: run.status, questionsCleared, outcome: "already_ended" };
	if (run.status === "running") {
		result.outcome = "cancelling";
		await requestCancel(env, input.userId, input.runId);
		if (run.waiting_reason === "decision" && (await wakeParkedRunDetailed(env, input.runId, "cancel")) === "gone") {
			const settled = await finishLoopRun(env, input.runId, "cancelled", "You abandoned this run while it was parked on a question; its workflow was no longer running, so the platform closed it. Its questions were cleared and nothing will resume it.", now);
			if (settled === "applied") {
				result.outcome = "cancelled";
				if (run.session_id) await setCodingSessionCardStatus(env, input.instanceId, input.userId, run.session_id, statusFor("cancelled")).catch(() => undefined);
				const repo = run.session_id ? await env.DB.prepare("SELECT repo_id FROM coding_sessions WHERE id = ?1").bind(run.session_id).first<{ repo_id: string | null }>() : null;
				if (repo?.repo_id) await tryDequeueAndStart(env, input.instanceId, repo.repo_id, input.userId).catch(() => undefined);
			}
		}
	}
	await logEvent(env, { source: "coding", event: "coding.run.abandoned", message: "the owner abandoned a run", userId: input.userId, instanceId: input.instanceId, traceId: input.runId, level: "info", context: { runId: input.runId, was: run.status, questionsCleared, outcome: result.outcome } }).catch(() => undefined);
	return result;
}
