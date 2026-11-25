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
//   - `issue_closed` the ticket's CACHED GitHub state is closed (migration 0183's `issue_cache`, kept
//                    fresh by `lib/issue-sync.ts`). Read ONLY from the cache, same rule as the board
//                    ("must never call GitHub") — a live read here would put a GitHub round trip, and
//                    that repo's live state, on every single start. An issue this platform has never
//                    ticketed has no cache and is not refused by this branch.
//   - `already_done` a run for this issue ended `done` within RECENTLY_DONE_DAYS. Same override.
// A forced start records its reason as a comment on the issue, so the next reader sees why.
//
// Checkout MAINTENANCE (a `repair_checkout` run, #1728) is neither of those: it never worked the issue. Its runs are kept out of
// all three readings below (`maintenance`, migration 0351), so a repair that ended `done` is not "finished", and one still
// running does not make the next feature start a "duplicate".
//
// A forced start the owner approved and that had to QUEUE keeps its approval to the drain (#1728): see `validQueuedApproval`.

import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { postIssueComment, readIssue } from "./github-issues.js";
import { namesOtherRepo, parseIssueCache } from "./issue-tickets.js";
import { referencedIssue } from "./objective-dedupe.js";
import { issueQuarantine } from "./issue-attempts.js";

export const RECENTLY_DONE_DAYS = 7;

/**
 * How long a queued entry's recorded approval stays good (#1728). An entry can wait behind a long run, an offline machine or a
 * backoff, but an approval is the owner's decision about the issue AS IT STOOD; a day later it is stale and the drain applies the
 * ordinary checks again — which refuse a finished or closed issue, so a stale approval fails closed rather than lingering.
 */
export const QUEUED_APPROVAL_MAX_AGE_MS = 24 * 60 * 60_000;

/** The owner's approval of one forced start, recorded when the start was queued instead of run (#1728). */
export interface QueuedForceApproval {
	/** The owner's own `force_reason`, exactly as validated when the start was accepted. */
	reason: string;
	/** The one issue it was given for. */
	issue: number;
	/** The one repository (its checkout id) it was given for. */
	repoId: string;
	/** When it was accepted, ms epoch. */
	approvedAt: number;
	/**
	 * Claim the right to post the audit comment, once, across every drain of the entry. True = this caller posts it. Absent for a start
	 * that is not a queue entry, which posts as it always has.
	 */
	claimAudit?: () => Promise<boolean>;
}

/**
 * Is a queued entry's recorded approval still good for THIS start? Null (so: no force, and the ordinary guard applies in full) unless
 * every one of these holds — it has a reason, it names the repository this start resolved to, it names the issue this start is
 * about (the objective's own reference, if it has one, must agree), and it is not stale. Anything else fails closed.
 */
export function validQueuedApproval(
	approval: QueuedForceApproval | null | undefined,
	ctx: { repoId: string; githubRepo: string | null; objective: string; now?: number },
): QueuedForceApproval | null {
	if (!approval?.reason?.trim()) return null;
	if (!Number.isInteger(approval.issue) || approval.issue <= 0) return null;
	if (approval.repoId !== ctx.repoId) return null;
	const named = startIssueFor({ objective: ctx.objective, githubRepo: ctx.githubRepo });
	if (named != null && named !== approval.issue) return null;
	const age = (ctx.now ?? Date.now()) - approval.approvedAt;
	if (!Number.isFinite(age) || age < 0 || age > QUEUED_APPROVAL_MAX_AGE_MS) return null;
	return approval;
}

export type StartIdempotencyRefusal = {
	reason: "duplicate" | "issue_closed" | "already_done" | "quarantined";
	error: string;
	detail: { issue: number; repoId: string; duplicate_of?: string; run_id?: string; finished_at?: number; issue_url?: string; incident_id?: string; attempts?: number; threshold?: number };
};

/** The issue a start is about: the explicit one, else the objective's subject unless it names another repo. */
export function startIssueFor(input: { issue?: number | null; objective: string; githubRepo: string | null }): number | null {
	if (typeof input.issue === "number" && Number.isInteger(input.issue) && input.issue > 0) return input.issue;
	return namesOtherRepo(input.objective, input.githubRepo) ? null : referencedIssue(input.objective);
}

/**
 * The per-issue hard stop (#1336): an issue with `threshold` unsuccessful attempts is refused on EVERY start path, `force`
 * included — only a verified success or the owner's audited release lifts it. Other issues are untouched.
 */
export async function quarantineRefusal(env: Env, input: { userId: string; githubRepo: string | null; repoId: string; issue: number }, now = Date.now()): Promise<StartIdempotencyRefusal | null> {
	if (!input.githubRepo) return null;
	const q = await issueQuarantine(env, input.userId, input.githubRepo, input.issue, now);
	if (!q) return null;
	return {
		reason: "quarantined",
		error: `Issue #${input.issue} was stopped after ${q.attemptCount} unsuccessful attempts (limit ${q.threshold}) and will not be started again until its owner releases it or a run on it succeeds. Other issues are unaffected.`,
		detail: { issue: input.issue, repoId: input.repoId, incident_id: q.incidentId ?? undefined, attempts: q.attemptCount, threshold: q.threshold },
	};
}

/**
 * A LIVE read of the linked issue's state (#1404) — for the one decision where the CACHED state
 * being stale costs hours rather than nothing: about to QUEUE an objective rather than run it now.
 * `checkStartIdempotency` above deliberately reads only the cache, because it runs on every start;
 * this runs only on the enqueue decision (a rarer path — reached only when the repo is busy), so one
 * extra GitHub round trip there does not repeat the cost that rule exists to avoid. A queued
 * objective whose issue had already closed used to be discovered only at drain time, sometimes
 * hours later, with nothing told to the owner in between.
 */
export async function liveIssueClosedRefusal(
	env: Env,
	input: { userId: string; githubRepo: string; repoId: string; issue: number },
): Promise<StartIdempotencyRefusal | null> {
	const detail = await readIssue(env, input.userId, input.githubRepo, input.issue).catch(() => null);
	if (detail?.state !== "closed") return null;
	return {
		reason: "issue_closed",
		error: `Issue #${input.issue} is closed on GitHub. Pass force: true with force_reason to start it anyway.`,
		detail: { issue: input.issue, repoId: input.repoId, issue_url: detail.url || undefined },
	};
}

/**
 * What a start that had to queue records of the owner's approval (#1728), or undefined when there is none to record: `force` was not exactly
 * true, the reason is blank, it is a repair, the repository was not resolved from the caller's own agent, or no issue is in question.
 * `audited` says the audit comment was already posted by the start that found the repository busy.
 */
export function approvalToRecord(i: { force: unknown; forceReason: unknown; repair: boolean; repoId: string | null; githubRepo: string | null; objective: string; issue?: number | null; audited: boolean }) {
	const reason = typeof i.forceReason === "string" ? i.forceReason.trim() : "";
	if (i.force !== true || !reason || i.repair || !i.repoId) return undefined;
	const issue = startIssueFor({ issue: i.issue, objective: i.objective, githubRepo: i.githubRepo });
	return issue == null ? undefined : { reason, issue, repoId: i.repoId, audited: i.audited };
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
		/** A queue entry's recorded approval (#1728): stands in for `force` only if it still names this repository and issue and is fresh. */
		approval?: QueuedForceApproval;
		now?: number;
	},
): Promise<StartIdempotencyRefusal | null> {
	const githubRepo = input.repo.githubRepo ?? null;
	const approved = input.force === true ? null : validQueuedApproval(input.approval, { repoId: input.repo.id, githubRepo, objective: input.objective, now: input.now });
	const issue = startIssueFor({ issue: input.issue ?? approved?.issue, objective: input.objective, githubRepo });
	if (issue == null) return null;
	// `t.instance_id` (#1654): a run's ticket is its own instance's, and naming it lets the planner find the one ticket through
	// idx_tickets_issue and its runs through idx_agent_loop_runs_ticket, instead of reading every run of the user.
	const where = (extra: string) =>
		`SELECT r.run_id, r.finished_at FROM agent_loop_runs r
		   JOIN tickets t ON t.id = r.ticket_id
		  WHERE r.user_id = ?1 AND r.instance_id = ?2 AND t.instance_id = ?2 AND t.repo_id = ?3 AND t.issue_number = ?4 AND COALESCE(r.maintenance, 0) = 0 AND ${extra}`;
	const base = [input.userId, input.instanceId, input.repo.id, issue] as const;

	// Before the force branch: a quarantine is the owner's to lift, not a caller's to override.
	const stopped = await quarantineRefusal(env, { userId: input.userId, githubRepo, repoId: input.repo.id, issue }, input.now);
	if (stopped) return stopped;

	const running = await env.DB.prepare(`${where("r.status = 'running' AND COALESCE(r.cancel_requested, 0) = 0")} ORDER BY r.started_at DESC LIMIT 1`).bind(...base).first<{ run_id: string }>();
	if (running) {
		return { reason: "duplicate", error: `Issue #${issue} is already being worked by run ${running.run_id} on this repo — not starting a second one.`, detail: { issue, repoId: input.repo.id, duplicate_of: running.run_id } };
	}

	const reason = (input.forceReason ?? approved?.reason)?.trim();
	if ((input.force === true || approved) && reason) {
		// One audit comment per approval (#1728): a queue entry may be drained, deferred and drained again, and each pass reaches here.
		if (githubRepo && (!approved?.claimAudit || (await approved.claimAudit().catch(() => false)))) {
			await postIssueComment(env, input.userId, githubRepo, issue, `Started again on purpose (force): ${clipMarked(reason, 500, { within: true, what: "characters in the force reason" })}`).catch(() => false);
		}
		return null;
	}

	const now = input.now ?? Date.now();
	const done = await env.DB.prepare(`${where("r.status = 'completed' AND r.stop_reason = 'done' AND r.finished_at > ?5")} ORDER BY r.finished_at DESC LIMIT 1`)
		.bind(...base, now - RECENTLY_DONE_DAYS * 86_400_000)
		.first<{ run_id: string; finished_at: number }>();
	const ticket = await env.DB.prepare("SELECT issue_cache FROM tickets WHERE instance_id = ?1 AND user_id = ?2 AND repo_id = ?3 AND issue_number = ?4")
		.bind(input.instanceId, input.userId, input.repo.id, issue)
		.first<{ issue_cache: string | null }>();
	const cache = parseIssueCache(ticket?.issue_cache);
	const how = "Pass force: true with force_reason to start it anyway.";
	if (cache?.state === "closed") {
		return { reason: "issue_closed", error: `Issue #${issue} is closed on GitHub${done ? ` (run ${done.run_id} finished it)` : ""}. ${how}`, detail: { issue, repoId: input.repo.id, issue_url: cache.url || undefined, ...(done ? { run_id: done.run_id, finished_at: done.finished_at } : {}) } };
	}
	if (done) {
		return { reason: "already_done", error: `Issue #${issue} was finished by run ${done.run_id} within the last ${RECENTLY_DONE_DAYS} days. ${how}`, detail: { issue, repoId: input.repo.id, run_id: done.run_id, finished_at: done.finished_at } };
	}
	return null;
}
