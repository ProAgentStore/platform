// A queued start that repeats one already waiting or running (#925).
//
// `request_id` only de-dupes a caller that REUSES its key. The live failure was a caller that, on a
// deferred ("provisioning") answer, retried with a NEW key — so the same GitHub issue was queued
// twice on the same repo and would have been worked twice. Nothing server-side looked at what the
// instance already had in flight.
//
// The key is the one the issue names: instance + repo + the GitHub issue the objective is about. No
// hashing of objective text: two phrasings of "work #925" are the same work, and two different
// objectives that merely mention #925 in passing are told apart by WHICH issue each one leads with.
//
// Consulted only on the queue_if_busy path, where the repo is already taken — so "already in
// flight" means a pending queue entry for this repo, or the run holding the repo right now.

import type { Env } from "../types.js";
import { listQueue, type ObjectiveQueueEntry } from "./objective-queue.js";

/**
 * The GitHub issue an objective is ABOUT, or null when it names none.
 *
 * An objective routinely mentions several ("Work issue #920 … the #919 run pushed …"), so this is
 * the FIRST reference, preferring an explicit one — `issue #920`, `issue 920`, `…/issues/920`,
 * `owner/repo#920` — over a bare `#920`, because objectives lead with their subject and a bare `#N`
 * later on is usually context. Pull-request URLs and `PR #N` are not issues and are ignored.
 */
export function referencedIssue(objective: string): number | null {
	const explicit = /\bissues?\s*#?\s*(\d+)\b|\/issues\/(\d+)\b|\b[\w.-]+\/[\w.-]+#(\d+)\b/i.exec(objective);
	if (explicit) return Number(explicit[1] ?? explicit[2] ?? explicit[3]);
	const bare = /(?<![\w/])(?<!\bPR\s?)(?<!\bpull request\s?)#(\d+)\b/i.exec(objective);
	return bare ? Number(bare[1]) : null;
}

export type DuplicateObjective = { kind: "queued"; entry: ObjectiveQueueEntry } | { kind: "running"; runId: string; objective: string };

/**
 * The non-terminal work on this repo that is about the same issue, or null.
 *
 * "This repo" uses the queue's own reading (`listQueue`): a named repo matches entries for it and
 * repo-agnostic ones; no repo matches the repo-agnostic ones. A run's repo is its session's.
 */
export async function findDuplicateObjective(
	env: Env,
	input: { userId: string; instanceId: string; repoId?: string; objective: string },
): Promise<DuplicateObjective | null> {
	const issue = referencedIssue(input.objective);
	if (issue == null) return null;
	const pending = await listQueue(env, input.instanceId, input.repoId ?? null);
	const entry = pending.find((e) => e.userId === input.userId && referencedIssue(e.objective) === issue);
	if (entry) return { kind: "queued", entry };
	const runs = await env.DB.prepare(
		`SELECT r.run_id, r.objective, s.repo_id FROM agent_loop_runs r
		   LEFT JOIN coding_sessions s ON s.id = r.session_id
		  WHERE r.user_id = ?1 AND r.instance_id = ?2 AND r.status = 'running'
		  ORDER BY r.started_at DESC`,
	)
		.bind(input.userId, input.instanceId)
		.all<{ run_id: string; objective: string; repo_id: string | null }>();
	const run = (runs.results ?? []).find(
		(r) => (input.repoId === undefined || r.repo_id == null || r.repo_id === input.repoId) && referencedIssue(r.objective) === issue,
	);
	return run ? { kind: "running", runId: run.run_id, objective: run.objective } : null;
}
