// One unit of work, started once: the idempotency check every coding start passes (#1253).
//
// The key is (instance, repo, issue). `repo` is the repo the start RESOLVED to, so `#12` in one repo is
// never `#12` in another. `issue` is the caller's explicit `issue`; only without one is the objective's
// text read (`referencedIssue`), and not at all when it names another repository.
//
// It runs inside the coding driver, so every path that starts a run — the start route, `start_work`,
// delegation, the queue drain — meets it, not only `queue_if_busy`. Three refusals, each saying why and
// naming the prior work:
//   - `duplicate`    a run for this issue is running now. `force` cannot override: a second writer on one
//                    issue is the failure this exists to stop.
//   - `issue_closed` the GitHub issue is closed. `force` + a reason reopens the question.
//   - `already_done` a run for this issue ended `done` within RECENTLY_DONE_DAYS. Same override.
// A forced start records its reason as a comment on the issue, so the next reader sees why.

import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { readIssue, postIssueComment } from "./github-issues.js";
import { namesOtherRepo } from "./issue-tickets.js";
import { referencedIssue } from "./objective-dedupe.js";

export const RECENTLY_DONE_DAYS = 7;

export type StartIdempotencyRefusal = {
	reason: "duplicate" | "issue_closed" | "already_done";
	error: string;
	detail: { issue: number; repoId: string; duplicate_of?: string; run_id?: string; finished_at?: number; issue_url?: string };
};

/** The issue a start is about: the explicit one, else the objective's subject unless it names another repo. */
export function startIssueFor(input: { issue?: number | null; objective: string; githubRepo: string | null }): number | null {
	if (typeof input.issue === "number" && Number.isInteger(input.issue) && input.issue > 0) return input.issue;
	return namesOtherRepo(input.objective, input.githubRepo) ? null : referencedIssue(input.objective);
}

export async function checkStartIdempotency(
	env: Env,
	input: {
		userId: string;
		instanceId: string;
		repo: { id: string; githubRepo?: string | null };
		objective: string;
		issue?: number | null;
		force?: boolean;
		forceReason?: string;
		now?: number;
	},
): Promise<StartIdempotencyRefusal | null> {
	const githubRepo = input.repo.githubRepo ?? null;
	const issue = startIssueFor({ issue: input.issue, objective: input.objective, githubRepo });
	if (issue == null) return null;
	const where = (extra: string) =>
		`SELECT r.run_id, r.finished_at FROM agent_loop_runs r
		   JOIN tickets t ON t.id = r.ticket_id
		  WHERE r.user_id = ?1 AND r.instance_id = ?2 AND t.repo_id = ?3 AND t.issue_number = ?4 AND ${extra}`;
	const base = [input.userId, input.instanceId, input.repo.id, issue] as const;

	const running = await env.DB.prepare(`${where("r.status = 'running' AND COALESCE(r.cancel_requested, 0) = 0")} ORDER BY r.started_at DESC LIMIT 1`).bind(...base).first<{ run_id: string }>();
	if (running) {
		return { reason: "duplicate", error: `Issue #${issue} is already being worked by run ${running.run_id} on this repo — not starting a second one.`, detail: { issue, repoId: input.repo.id, duplicate_of: running.run_id } };
	}

	const reason = input.forceReason?.trim();
	if (input.force === true && reason) {
		if (githubRepo) await postIssueComment(env, input.userId, githubRepo, issue, `Started again on purpose (force): ${clipMarked(reason, 500, { within: true, what: "characters in the force reason" })}`).catch(() => false);
		return null;
	}

	const now = input.now ?? Date.now();
	const done = await env.DB.prepare(`${where("r.status = 'completed' AND r.stop_reason = 'done' AND r.finished_at > ?5")} ORDER BY r.finished_at DESC LIMIT 1`)
		.bind(...base, now - RECENTLY_DONE_DAYS * 86_400_000)
		.first<{ run_id: string; finished_at: number }>();
	const closed = githubRepo ? await readIssue(env, input.userId, githubRepo, issue).catch(() => null) : null;
	const how = "Pass force: true with force_reason to start it anyway.";
	if (closed && closed.state === "closed") {
		return { reason: "issue_closed", error: `Issue #${issue} is closed on GitHub${done ? ` (run ${done.run_id} finished it)` : ""}. ${how}`, detail: { issue, repoId: input.repo.id, issue_url: closed.url, ...(done ? { run_id: done.run_id, finished_at: done.finished_at } : {}) } };
	}
	if (done) {
		return { reason: "already_done", error: `Issue #${issue} was finished by run ${done.run_id} within the last ${RECENTLY_DONE_DAYS} days. ${how}`, detail: { issue, repoId: input.repo.id, run_id: done.run_id, finished_at: done.finished_at } };
	}
	return null;
}
