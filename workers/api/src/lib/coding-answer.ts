/**
 * Answering a coding run's question (#960) — the one delivery path for both doors.
 *
 * A coding pause lives in the runner's CODING takeover map, keyed by session, and is resolved by
 * `/coding/takeover/:sid/resolve`. The console's answer box and `answer_instance_input` post to
 * `POST /v1/instances/:id/input`, which only ever knew the BROWSER map (keyed by task) — so an
 * answer to a coding question missed and came back "That takeover session is gone (the runner
 * restarted)", a false statement about a live run. `/input` now asks {@link decisionRunForCard}
 * first and delivers here; the explicit `…/coding/sessions/:sid/resume` route delivers here too.
 */
import { HttpError } from "./auth.js";
import { parseWaitingAsk, type WaitingAsk } from "./agent-loop-store.js";
import { getSession, touchSessionActivity } from "./coding-store.js";
import { callRunner } from "./runner-client.js";
import { getSessionRunnerConn } from "../routes/coding-shared.js";
import type { Env } from "../types.js";

/**
 * The open coding run parked on a question asked on this card, or null. The run RECORD is the proof
 * a question is waiting: the runner's resolve answers `ok` whether or not a takeover is pending, so
 * delivering without this check would report an answer as landed that nothing was waiting for.
 */
export async function decisionRunForCard(env: Env, instanceId: string, userId: string, taskId: string): Promise<{ runId: string; sessionId: string; ask: WaitingAsk } | null> {
	const { results } = await env.DB.prepare(
		`SELECT run_id, session_id, waiting_ask FROM agent_loop_runs
		  WHERE instance_id = ?1 AND user_id = ?2 AND status = 'running' AND waiting_reason = 'decision' AND session_id IS NOT NULL`,
	)
		.bind(instanceId, userId)
		.all<{ run_id: string; session_id: string; waiting_ask: string | null }>();
	for (const r of results ?? []) {
		const ask = parseWaitingAsk(r.waiting_ask);
		if (ask && ask.taskId === taskId) return { runId: r.run_id, sessionId: r.session_id, ask };
	}
	return null;
}

/** Hand the owner's answer (or a bare "done") to the coding pause on this session's runner. */
export async function resolveCodingPause(env: Env, instanceId: string, userId: string, sessionId: string, value: string | undefined): Promise<void> {
	const session = await getSession(env, instanceId, userId, sessionId);
	if (!session) throw new HttpError(404, "Session not found");
	const conn = await getSessionRunnerConn(env, instanceId, userId, session);
	if (!conn) throw new HttpError(409, "No coding runner connected — the run is still waiting for your answer. Run `pags up` on its machine and answer again.");
	await touchSessionActivity(env, instanceId, userId, sessionId);
	// Swallowing a failed delivery reported it landed and threw it away: the Pilot polls
	// /coding/takeover-status, never sees `resolved`, and closes the run "not resolved in time" — a
	// run recorded as the HUMAN's timeout when the human did answer.
	const delivered = await callRunner(conn, `/coding/takeover/${encodeURIComponent(sessionId)}/resolve`, { value }).then(
		() => true,
		() => false,
	);
	if (!delivered) throw new HttpError(502, "Couldn't hand your answer to the coding runner — it's still waiting. Try again.");
}
