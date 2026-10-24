/**
 * The per-issue attempt counter and hard stop (#1336).
 *
 * After `threshold` (default 5) DISTINCT unsuccessful attempts on one issue, that issue — and only that issue — is
 * quarantined: every path that starts a coding run for it is refused with a reason (`checkStartIdempotency` is the one
 * start guard the cron wake, the queue drain, auto-resume and a manual start all pass), while the picker goes on to other
 * eligible work.
 *
 * ── What counts
 *   · an admission failure that never became a run (the drain's structural refusal of a queued objective);
 *   · a run that ended failed / escalated / out of iterations / no progress / engine error / constraint refused / turn lost / over budget.
 * What does not: a deferral, a poll, a duplicate receipt, a cancellation, a start-guard refusal (done, closed, duplicate,
 * quarantined), and every provider-credit, credential, usage-window, machine-away or owner-question stop — those are not the
 * issue's fault and have their own holds (#1314). A replayed event is a no-op: `attempt_key` is unique per owner.
 *
 * ── Key
 * owner + lower-cased `owner/repo` + issue number, so two instances on one repo share one counter and another owner's is separate.
 *
 * ── Reset
 * Nothing expires. The count restarts only at a verified success (a run that ended `done` on the issue) or an explicit owner
 * release, both of which move `floor_attempt_id` past every earlier attempt. Releasing is audited.
 *
 * ── Exactly once
 * The attempt row is `INSERT OR IGNORE` (a duplicate changes nothing). The quarantine row is opened by one conditional statement
 * that fires only when the count since the floor has reached the threshold and the row is not already quarantined, so of any
 * number of concurrent writers exactly one sees `changes = 1` and owns the incident.
 */
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { logEvent } from "./events.js";

export const ISSUE_ATTEMPT_THRESHOLD_DEFAULT = 5;
export const ISSUE_ATTEMPT_THRESHOLD_MIN = 1;
export const ISSUE_ATTEMPT_THRESHOLD_MAX = 50;

export function sanitizeAttemptThreshold(v: unknown): number {
	return typeof v === "number" && Number.isInteger(v) && v >= ISSUE_ATTEMPT_THRESHOLD_MIN && v <= ISSUE_ATTEMPT_THRESHOLD_MAX ? v : ISSUE_ATTEMPT_THRESHOLD_DEFAULT;
}

/** Stop reasons of a run that counts as an unsuccessful attempt. Everything else is not this issue's fault or is not an end. */
const UNSUCCESSFUL_STOPS = new Set(["failed", "escalated", "max_iterations", "no_progress", "engine_error", "constraint_refused", "turn_lost", "budget"]);
/** Start refusals that are the guard doing its job, never an attempt. */
const GUARD_REFUSALS = new Set(["duplicate", "issue_closed", "already_done", "quarantined"]);

export const canonicalRepo = (githubRepo: string): string => githubRepo.trim().toLowerCase();

export interface Quarantine {
	githubRepo: string;
	issue: number;
	state: "quarantined" | "released";
	threshold: number;
	attemptCount: number;
	incidentId: string | null;
	openedAt: number | null;
	releasedAt: number | null;
	releasedBy: string | null;
	releaseReason: string | null;
}

interface QRow {
	github_repo: string;
	issue_number: number;
	state: "quarantined" | "released";
	threshold: number;
	incident_id: string | null;
	opened_at: number | null;
	floor_attempt_id: number;
	released_at: number | null;
	released_by: string | null;
	release_reason: string | null;
	n: number;
}

const SELECT_Q = `SELECT q.github_repo, q.issue_number, q.state, q.threshold, q.incident_id, q.opened_at, q.floor_attempt_id, q.released_at, q.released_by, q.release_reason,
	 (SELECT COUNT(*) FROM issue_attempts a WHERE a.user_id = q.user_id AND a.github_repo = q.github_repo AND a.issue_number = q.issue_number AND a.id > q.floor_attempt_id) AS n
	 FROM issue_quarantine q`;

const view = (r: QRow): Quarantine => ({ githubRepo: r.github_repo, issue: r.issue_number, state: r.state, threshold: r.threshold, attemptCount: r.n, incidentId: r.incident_id, openedAt: r.opened_at, releasedAt: r.released_at, releasedBy: r.released_by, releaseReason: r.release_reason });

/** The open quarantine on this issue, or null. */
export async function issueQuarantine(env: Pick<Env, "DB">, userId: string, githubRepo: string, issue: number): Promise<Quarantine | null> {
	const row = await env.DB.prepare(`${SELECT_Q} WHERE q.user_id = ?1 AND q.github_repo = ?2 AND q.issue_number = ?3 AND q.state = 'quarantined'`).bind(userId, canonicalRepo(githubRepo), issue).first<QRow>();
	return row ? view(row) : null;
}

/** The owner's quarantines (open by default), newest first, bounded. */
export async function listIssueQuarantines(env: Pick<Env, "DB">, userId: string, opts: { includeReleased?: boolean; limit?: number } = {}): Promise<Quarantine[]> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
	const { results } = await env.DB.prepare(`${SELECT_Q} WHERE q.user_id = ?1 ${opts.includeReleased ? "" : "AND q.state = 'quarantined'"} ORDER BY COALESCE(q.opened_at, q.released_at) DESC LIMIT ?2`).bind(userId, limit).all<QRow>();
	return (results ?? []).map(view);
}

/** The instance's configured threshold (autoPickup.maxAttemptsPerIssue), validated; the default when unset or invalid. */
async function thresholdFor(env: Pick<Env, "DB">, userId: string, instanceId: string): Promise<number> {
	const row = await env.DB.prepare("SELECT json_extract(config, '$.autoPickup.maxAttemptsPerIssue') AS t FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ t: unknown }>().catch(() => null);
	return sanitizeAttemptThreshold(row?.t);
}

export interface AttemptInput {
	userId: string;
	instanceId: string;
	githubRepo: string;
	issue: number;
	attemptKey: string;
	kind: "admission_failed" | "run_unsuccessful";
	reason: string;
	queueEntryId?: string | null;
	runId?: string | null;
	now?: number;
}

export type AttemptResult = { recorded: false } | { recorded: true; count: number; threshold: number; quarantine: "opened" | "none" };

/** Record one distinct unsuccessful attempt; open the quarantine, once, when it brings the count to the threshold. Never throws. */
export async function recordIssueAttempt(env: Env, a: AttemptInput): Promise<AttemptResult> {
	try {
		const repo = canonicalRepo(a.githubRepo);
		const now = a.now ?? Date.now();
		const ins = await env.DB.prepare(
			`INSERT OR IGNORE INTO issue_attempts (user_id, github_repo, issue_number, attempt_key, instance_id, kind, reason, queue_entry_id, run_id, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
		)
			.bind(a.userId, repo, a.issue, a.attemptKey, a.instanceId, a.kind, clipMarked(a.reason, 300), a.queueEntryId ?? null, a.runId ?? null, now)
			.run();
		if ((ins.meta?.changes ?? 0) === 0) return { recorded: false }; // a replay of an attempt already counted
		const threshold = await thresholdFor(env, a.userId, a.instanceId);
		const incidentId = `iq-${crypto.randomUUID()}`;
		const opened = await env.DB.prepare(
			`INSERT INTO issue_quarantine (user_id, github_repo, issue_number, state, threshold, attempt_count, incident_id, opened_at, floor_attempt_id)
			 SELECT ?1, ?2, ?3, 'quarantined', ?4, c, ?5, ?6, COALESCE((SELECT floor_attempt_id FROM issue_quarantine WHERE user_id = ?1 AND github_repo = ?2 AND issue_number = ?3), 0)
			   FROM (SELECT COUNT(*) AS c FROM issue_attempts WHERE user_id = ?1 AND github_repo = ?2 AND issue_number = ?3
			           AND id > COALESCE((SELECT floor_attempt_id FROM issue_quarantine WHERE user_id = ?1 AND github_repo = ?2 AND issue_number = ?3), 0))
			  WHERE c >= ?4
			 ON CONFLICT (user_id, github_repo, issue_number) DO UPDATE SET state = 'quarantined', threshold = excluded.threshold, attempt_count = excluded.attempt_count,
			   incident_id = excluded.incident_id, opened_at = excluded.opened_at, released_at = NULL, released_by = NULL, release_reason = NULL
			 WHERE issue_quarantine.state = 'released'`,
		)
			.bind(a.userId, repo, a.issue, threshold, incidentId, now)
			.run();
		const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM issue_attempts WHERE user_id = ?1 AND github_repo = ?2 AND issue_number = ?3 AND id > COALESCE((SELECT floor_attempt_id FROM issue_quarantine WHERE user_id = ?1 AND github_repo = ?2 AND issue_number = ?3), 0)").bind(a.userId, repo, a.issue).first<{ n: number }>())?.n ?? 0;
		if ((opened.meta?.changes ?? 0) > 0) {
			await logEvent(env, {
				source: "issue-attempts", event: "issue_quarantine.opened", level: "warn", userId: a.userId, instanceId: a.instanceId,
				message: `${repo}#${a.issue} stopped after ${count} unsuccessful attempts (threshold ${threshold}); other work continues`,
				context: { githubRepo: repo, issue: a.issue, incidentId, count, threshold, lastAttempt: a.attemptKey },
			}).catch(() => undefined);
			return { recorded: true, count, threshold, quarantine: "opened" };
		}
		return { recorded: true, count, threshold, quarantine: "none" };
	} catch {
		return { recorded: false }; // a counter that cannot be written must not fail the run's own terminal path
	}
}

/** Move the floor past every attempt so far: the count restarts from zero. Creates the row if the issue never had one. */
async function resetFloor(env: Env, userId: string, repo: string, issue: number, by: string, why: string, now: number): Promise<boolean> {
	const res = await env.DB.prepare(
		`INSERT INTO issue_quarantine (user_id, github_repo, issue_number, state, threshold, attempt_count, floor_attempt_id, released_at, released_by, release_reason)
		 VALUES (?1, ?2, ?3, 'released', ?4, 0, (SELECT COALESCE(MAX(id), 0) FROM issue_attempts WHERE user_id = ?1 AND github_repo = ?2 AND issue_number = ?3), ?5, ?6, ?7)
		 ON CONFLICT (user_id, github_repo, issue_number) DO UPDATE SET state = 'released', floor_attempt_id = excluded.floor_attempt_id,
		   released_at = excluded.released_at, released_by = excluded.released_by, release_reason = excluded.release_reason`,
	)
		.bind(userId, repo, issue, ISSUE_ATTEMPT_THRESHOLD_DEFAULT, now, by, clipMarked(why, 300))
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/** A verified success on the issue (a run that ended `done`): the count restarts and any quarantine is lifted. Never throws. */
export async function recordIssueSuccess(env: Env, userId: string, githubRepo: string, issue: number, runId: string, now = Date.now()): Promise<void> {
	try {
		await resetFloor(env, userId, canonicalRepo(githubRepo), issue, `success:${runId}`, "a run on the issue ended done", now);
	} catch {
		// the next success or an owner release restarts it
	}
}

/** The owner's explicit, audited decision to try again. Returns false when the issue was not quarantined. */
export async function releaseIssueQuarantine(env: Env, userId: string, githubRepo: string, issue: number, reason: string, now = Date.now()): Promise<boolean> {
	const repo = canonicalRepo(githubRepo);
	if (!(await issueQuarantine(env, userId, repo, issue))) return false;
	const why = reason.trim();
	if (!why) throw new Error("A release needs a reason.");
	const done = await env.DB.prepare(
		`UPDATE issue_quarantine SET state = 'released', floor_attempt_id = (SELECT COALESCE(MAX(id), 0) FROM issue_attempts WHERE user_id = ?1 AND github_repo = ?2 AND issue_number = ?3),
		   released_at = ?4, released_by = ?5, release_reason = ?6
		 WHERE user_id = ?1 AND github_repo = ?2 AND issue_number = ?3 AND state = 'quarantined'`,
	)
		.bind(userId, repo, issue, now, `owner:${userId}`, clipMarked(why, 300))
		.run();
	if ((done.meta?.changes ?? 0) === 0) return false; // a concurrent release already did it
	await logEvent(env, { source: "issue-attempts", event: "issue_quarantine.released", level: "info", userId, message: `${repo}#${issue} released by its owner: ${clipMarked(why, 200)}`, context: { githubRepo: repo, issue, by: userId } }).catch(() => undefined);
	return true;
}

/** Is a start-guard refusal reason one that must never be counted as an attempt? */
export const isGuardRefusal = (reason: string | undefined): boolean => reason !== undefined && GUARD_REFUSALS.has(reason);

/** Does a run's stop reason make it an unsuccessful attempt? */
export const isUnsuccessfulStop = (stopReason: string): boolean => UNSUCCESSFUL_STOPS.has(stopReason);
