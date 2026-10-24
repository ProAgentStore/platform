/**
 * Where the per-issue counter (#1336) learns of an attempt: a run settling, and the queue drain refusing an objective.
 * Resolution only — the counting rules live in `issue-attempts.ts`. Both hooks are best-effort and never throw: the run or
 * the drain has already happened, and a counter that could not be written must not undo it.
 *
 * Imports are dynamic where a static one would close a cycle through the run store.
 */
import type { Env } from "../types.js";
import { isGuardRefusal, isUnsuccessfulStop, recordIssueAttempt, recordIssueSuccess } from "./issue-attempts.js";

interface RunFacts {
	user_id: string;
	instance_id: string;
	objective: string;
	ticket_issue: number | null;
	github_repo: string | null;
	queue_entry_id: string | null;
}

/** A run settled: a verified success restarts the count; an unsuccessful end is one more attempt. */
export async function recordRunForIssue(env: Env, runId: string, stopReason: string, now: number): Promise<void> {
	try {
		const countable = isUnsuccessfulStop(stopReason);
		if (stopReason !== "done" && !countable) return;
		const run = await env.DB.prepare(
			`SELECT r.user_id, r.instance_id, r.objective, t.issue_number AS ticket_issue, cr.github_repo, r.queue_entry_id
			   FROM agent_loop_runs r
			   LEFT JOIN tickets t ON t.id = r.ticket_id
			   LEFT JOIN coding_sessions s ON s.id = r.session_id
			   LEFT JOIN coding_repos cr ON cr.id = COALESCE(s.repo_id, t.repo_id)
			  WHERE r.run_id = ?1`,
		).bind(runId).first<RunFacts>();
		if (!run?.github_repo) return;
		const { startIssueFor } = await import("./start-idempotency.js");
		const issue = run.ticket_issue ?? startIssueFor({ objective: run.objective, githubRepo: run.github_repo });
		if (issue == null) return;
		if (stopReason === "done") return void (await recordIssueSuccess(env, run.user_id, run.github_repo, issue, runId, now));
		await recordIssueAttempt(env, { userId: run.user_id, instanceId: run.instance_id, githubRepo: run.github_repo, issue, attemptKey: `run:${runId}`, kind: "run_unsuccessful", reason: `run ended ${stopReason}`, queueEntryId: run.queue_entry_id, runId, now });
	} catch {
		// see header
	}
}

/**
 * The drain refused a claimed objective for a structural reason: no run ever existed, but the issue was attempted. A start-guard
 * refusal (done, closed, duplicate, quarantined) is the guard working and is not an attempt.
 */
export async function recordDrainRefusal(
	env: Env,
	entry: { id: string; instanceId: string; userId: string; repoId: string | null; objective: string; metadata: string | null },
	fallbackRepoId: string | null,
	refusalReason: string | undefined,
	error: string,
	now = Date.now(),
): Promise<void> {
	try {
		if (isGuardRefusal(refusalReason)) return;
		const repoId = entry.repoId ?? fallbackRepoId;
		if (!repoId) return;
		const repo = await env.DB.prepare("SELECT github_repo FROM coding_repos WHERE id = ?1 AND user_id = ?2").bind(repoId, entry.userId).first<{ github_repo: string | null }>();
		if (!repo?.github_repo) return;
		let issue: number | null = null;
		try {
			const meta = entry.metadata ? (JSON.parse(entry.metadata) as { autoPickup?: { issue?: unknown; repo?: unknown } }) : null;
			const m = meta?.autoPickup;
			if (m && typeof m.issue === "number" && Number.isInteger(m.issue) && m.issue > 0 && typeof m.repo === "string" && m.repo.toLowerCase() === repo.github_repo.toLowerCase()) issue = m.issue;
		} catch {
			// metadata is the caller's; not JSON is simply "no issue named there"
		}
		if (issue == null) {
			const { startIssueFor } = await import("./start-idempotency.js");
			issue = startIssueFor({ objective: entry.objective, githubRepo: repo.github_repo });
		}
		if (issue == null) return;
		await recordIssueAttempt(env, { userId: entry.userId, instanceId: entry.instanceId, githubRepo: repo.github_repo, issue, attemptKey: `entry:${entry.id}`, kind: "admission_failed", reason: error, queueEntryId: entry.id, now });
	} catch {
		// see header
	}
}
