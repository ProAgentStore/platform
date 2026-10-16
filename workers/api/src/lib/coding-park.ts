/**
 * A coding run parked on a QUESTION, at zero compute (#1076).
 *
 * The park used to be a live Workflow polling: a durable `step.sleep` every five seconds and a runner
 * call each time, for fifteen minutes, after which the run STOPPED and a later answer had nothing to
 * resume (`lib/coding-wait.ts` named the missing piece: "a resumption scheduler that does not exist").
 * Now the run records its park and waits on `step.waitForEvent` — no step runs, nothing is polled,
 * and Cloudflare does not count a waiting instance against concurrency. Whatever should make it look
 * again sends it an event:
 *
 *   * an answer (`POST /input`, MCP `answer_instance_input`, the takeover route — after #1075 wrote it)
 *   * the coder brain's decision or its unresolved instruction (the minute sweep)
 *   * a cancel (`requestCancel`, so `stop_work` reaches a parked run — the lesson of #790)
 *   * this module's backstop, for any of those whose event was lost
 *
 * The event carries nothing the run trusts. Woken, the run re-reads D1 — the answer from its question
 * row (#1075), the cancel from its run row — so a duplicate or stale event is a look that finds
 * nothing, never a wrong resume. The event TYPE names the question, so an event buffered for one
 * question can never satisfy the wait for the next one.
 *
 * Why an event and not ending the instance plus a continuation: measured and recorded on #1076.
 */
import type { Env } from "../types.js";
import { RESUME_WINDOW_MS, describeAge } from "./coding-session-continuity.js";
import { startSessionOnRunnerConn, type RelaunchInput } from "./coding-session-relaunch.js";
import { seedBriefForRepo } from "./coding-seed-brief.js";
import { claimSessionDriver } from "./coding-store.js";
import type { RunnerConn } from "./runner-client.js";

/**
 * How long a parked question waits before the run stops (`decision`, which is continuable). Thirty
 * days: far past any real gap inside one piece of work, well inside `waitForEvent`'s 365-day ceiling.
 */
export const DECISION_PARK_MS = 30 * 24 * 60 * 60_000;

/** Times one park may be woken without finding anything to act on before it stops looking (a bound, not an expectation). */
export const MAX_PARK_WAKES = 50;

/** How long an unapplied answer may sit before the backstop re-sends its event: the live path gets the first minute. */
export const PARK_WAKE_BACKSTOP_MS = 60_000;

/** The event a park on this question waits for. Cloudflare allows `[A-Za-z0-9_-]`, at most 100 characters: a question id is a uuid, so it fits whole. */
export function answerEventType(questionId: string): string {
	return `answer-${questionId}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Written by the park: the instance to send this run's events to. */
export async function recordParkedWorkflow(env: Pick<Env, "DB">, runId: string, workflowInstanceId: string): Promise<void> {
	await env.DB.prepare("UPDATE agent_loop_runs SET workflow_instance_id = ?2 WHERE run_id = ?1").bind(runId, workflowInstanceId).run();
}

/**
 * Wake a run parked on a question so it re-reads its answer (or its cancel) from D1. False when the
 * run is not parked on a question, or the event could not be sent — never throws: every caller has
 * already written the durable fact, and the minute backstop covers a send that failed.
 */
export async function wakeParkedRun(env: Pick<Env, "DB" | "CODING_SESSION">, runId: string, why: "answer" | "cancel" | "backstop"): Promise<boolean> {
	try {
		const row = await env.DB.prepare(
			`SELECT r.workflow_instance_id AS wf, q.id AS qid FROM agent_loop_runs r JOIN coder_questions q ON q.run_id = r.run_id
			  WHERE r.run_id = ?1 AND r.status = 'running' AND r.waiting_reason = 'decision' AND r.workflow_instance_id IS NOT NULL
			  ORDER BY q.asked_at DESC, q.rowid DESC LIMIT 1`,
		)
			.bind(runId)
			.first<{ wf: string; qid: string }>();
		if (!row) return false;
		const instance = await env.CODING_SESSION.get(row.wf);
		await instance.sendEvent({ type: answerEventType(row.qid), payload: { why } });
		return true;
	} catch {
		return false;
	}
}

/**
 * The backstop (one more pass on the every-minute tick): re-send the event for every parked run that
 * has something to act on and has not acted — an answer no run has applied yet, an unresolved
 * instruction, or a cancel — older than {@link PARK_WAKE_BACKSTOP_MS}. A run that already woke has
 * applied its answer, so it is not selected again; one that is gone stays selected until the run
 * sweeper closes it at its published deadline.
 */
export async function runDueParkWakes(env: Pick<Env, "DB" | "CODING_SESSION">, now = Date.now()): Promise<number> {
	const due = now - PARK_WAKE_BACKSTOP_MS;
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT r.run_id FROM agent_loop_runs r JOIN coder_questions q ON q.run_id = r.run_id
		  WHERE r.status = 'running' AND r.waiting_reason = 'decision' AND r.workflow_instance_id IS NOT NULL
		    AND ((r.cancel_requested = 1 AND COALESCE(r.cancel_requested_at, 0) < ?1)
		      OR (q.applied_at IS NULL AND ((q.answered_at IS NOT NULL AND q.answered_at < ?1) OR (q.state = 'unresolved' AND q.resolved_at < ?1))))
		  LIMIT 25`,
	)
		.bind(due)
		.all<{ run_id: string }>();
	let woken = 0;
	for (const r of results ?? []) if (await wakeParkedRun(env, r.run_id, "backstop")) woken++;
	return woken;
}

/**
 * Bring the engine back for a run resumed from a park (#1076). The park stopped the engine PROCESS;
 * the session row and the machine's resume key stayed. So within {@link RESUME_WINDOW_MS} a Claude
 * engine relaunched on the same session id adopts its own key and continues its conversation
 * (`--resume`). Past the window, or for an engine with no conversation to continue, it starts fresh
 * with the repo's seed brief. `resumed` is the MACHINE's answer, so the line said to the owner is what
 * happened, not what was asked for. The driver claim, unrefreshed while parked, is taken back first.
 */
export async function relaunchAfterPark(
	env: Env,
	conn: RunnerConn,
	input: RelaunchInput & { clientType?: string; repoName: string; driverId?: string; parkedForMs: number },
): Promise<{ resumed: boolean; line: string }> {
	if (input.driverId) await claimSessionDriver(env, input.instanceId, input.userId, input.sessionId, input.driverId).catch(() => false);
	const engine = input.clientType ?? "claude";
	const why = engine !== "claude" ? `the ${engine} engine has no conversation to continue` : input.parkedForMs > RESUME_WINDOW_MS ? `it was parked ${describeAge(input.parkedForMs)}, past the ${describeAge(RESUME_WINDOW_MS)} window for continuing a conversation` : null;
	const seed = await seedBriefForRepo(env, { instanceId: input.instanceId, userId: input.userId, repoId: input.repoId, repoName: input.repoName }).catch(() => "");
	const started = await startSessionOnRunnerConn(env, conn, { ...input, fresh: why !== null, seed: seed || undefined });
	if (started?.resumed === true) return { resumed: true, line: "The coding engine continued its own conversation." };
	return { resumed: false, line: `The coding engine started fresh (${why ?? "its saved conversation was not on the machine"}), briefed from this repository's record.` };
}
