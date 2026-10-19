// A parked run whose Workflow is gone (#1231).
//
// A run parked on a question waits on `step.waitForEvent` for up to thirty days (#1076), and that wait
// outlives deploys, evictions and the occasional Workflow that errors while parked. When the Workflow is
// gone, nothing will ever read the answer: the event is accepted by nobody, the run row stays `running`
// with its park until the month runs out, its card keeps asking, and its repo's queue waits behind it.
// On FGS Platform Coder that was two runs whose answers sat unapplied for 12 hours while
// `answer_instance_input` reported them delivered.
//
// Closing it is the only honest move left. The run ends `decision` (continuable, the same ending as a
// park that ran out), its answer stays unapplied on the question row and is posted on its issue, where
// the run that continues the work reads it, and the queue drains. Its set-aside work is named, not
// dropped. Kept out of `coding-park.ts` because it drains the queue, and the queue imports that module.

import { finishLoopRun } from "./agent-loop-store.js";
import { statusFor } from "./agent-loop.js";
import { setCodingSessionCardStatus } from "./coding-board.js";
import { clipMarked } from "./clip-marked.js";
import { logEvent } from "./events.js";
import { postIssueComment } from "./github-issues.js";
import { tryDequeueAndStart } from "./objective-queue-start.js";
import type { Env } from "../types.js";

/**
 * Close a parked run whose Workflow is gone, carry its answer to the issue, and drain its repo's
 * queue. False when there was nothing to close (it already ended, or it is not this kind of park).
 * Never throws past the close: every later step is best-effort.
 */
export async function recoverDeadParkedRun(env: Env, runId: string, now = Date.now()): Promise<boolean> {
	const run = await env.DB.prepare(
		`SELECT r.instance_id, r.user_id, r.session_id, r.checkout_snapshot, s.repo_id FROM agent_loop_runs r LEFT JOIN coding_sessions s ON s.id = r.session_id
		  WHERE r.run_id = ?1 AND r.status = 'running' AND r.waiting_reason = 'decision'`,
	)
		.bind(runId)
		.first<{ instance_id: string; user_id: string; session_id: string | null; checkout_snapshot: string | null; repo_id: string | null }>();
	if (!run) return false;
	const q = await env.DB.prepare("SELECT question, decision, repo, issue_number FROM coder_questions WHERE run_id = ?1 ORDER BY asked_at DESC, rowid DESC LIMIT 1")
		.bind(runId)
		.first<{ question: string; decision: string | null; repo: string | null; issue_number: number | null }>();
	const kept = run.checkout_snapshot
		? ` Its uncommitted work is still set aside as ${run.checkout_snapshot} (\`refs/pags/parked/${runId}\`); \`git stash apply ${run.checkout_snapshot}\` in the checkout brings it back.`
		: "";
	const answer = q?.decision ? " Your answer is saved on the question and posted on its issue, where the run that continues this work reads it." : "";
	const settled = await finishLoopRun(env, runId, "decision", `The run stopped while parked on your question: its workflow is no longer running, so nothing could resume it.${answer} Continue the run to carry the work on.${kept}`, now);
	if (settled !== "applied") return false;
	if (run.session_id) await setCodingSessionCardStatus(env, run.instance_id, run.user_id, run.session_id, statusFor("decision")).catch(() => undefined);
	const issue = q?.repo && q.issue_number ? q.issue_number : null;
	const posted =
		issue && q?.decision
			? await postIssueComment(env, run.user_id, q.repo as string, issue, `**The owner's answer, for the run that continues this work.** The question was: ${clipMarked(q.question, 300, { within: true })}\n\n> ${q.decision}\n\nThe run that asked could not resume (its workflow had stopped), so it was closed with this answer unapplied.`).catch(() => false)
			: false;
	await logEvent(env, { source: "coding", event: "coding.run.park_lost", message: "a parked run's workflow was gone; the run was closed so its answer and its queue are not held", userId: run.user_id, instanceId: run.instance_id, traceId: runId, level: "warn", context: { runId, sessionId: run.session_id, issue, postedToIssue: posted, snapshot: run.checkout_snapshot } }).catch(() => undefined);
	if (run.repo_id) await tryDequeueAndStart(env, run.instance_id, run.repo_id, run.user_id);
	return true;
}
