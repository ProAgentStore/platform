/** #1315: reserve the rolling allowance and queue work in ONE SQLite statement. The migration's
 * trigger inserts the objective and started receipt in that statement's transaction: there is no
 * reservation-only crash state or expiring lease that could admit the same unfinished work twice.
 */
import type { Env } from "../types.js";
import { MAX_CONFIGURABLE_OBJECTIVE_CHARS } from "./loop-limits.js";
import type { ProviderAccountIdentity } from "./provider-account-hold.js";
import { RESERVATION_TTL_MS } from "./auto-pickup-legacy-reservations.js";

export interface AutoPickupAdmission {
	entryId: string;
	instanceId: string;
	userId: string;
	repoId: string;
	repo: string;
	issue: number;
	objective: string;
	maxIterations: number;
	detail: string;
	now: number;
	/** Last admission visible before reading GitHub: an intervening completed run also wins over this stale wake. */
	observedAdmission: number;
	providerAccount?: ProviderAccountIdentity | null;
}

export async function autoPickupAdmissionCursor(env: Pick<Env, "DB">, instanceId: string): Promise<number> {
	const row = await env.DB.prepare("SELECT COALESCE(MAX(admission_id), 0) AS n FROM auto_pickup_admissions WHERE instance_id = ?1").bind(instanceId).first<{ n: number }>();
	return row?.n ?? 0;
}

export async function admitAutoPickup(env: Pick<Env, "DB">, a: AutoPickupAdmission): Promise<boolean> {
	const result = await env.DB.prepare(
		`INSERT INTO auto_pickup_admissions
		 (queue_entry_id, instance_id, user_id, repo_id, repo, issue_number, objective, max_iterations, detail, created_at)
		 SELECT ?1, i.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 FROM agent_instances i
		 WHERE i.id = ?2 AND i.user_id = ?3 AND i.status = 'active' AND json_extract(i.config, '$.autoPickup.enabled') = 1
		   AND (SELECT COUNT(*) FROM auto_pickup_log l WHERE l.instance_id = i.id AND l.outcome = 'started' AND l.created_at > ?11)
		       < CASE WHEN json_type(i.config, '$.autoPickup.maxPerDay') IN ('integer', 'real')
		              AND json_extract(i.config, '$.autoPickup.maxPerDay') = CAST(json_extract(i.config, '$.autoPickup.maxPerDay') AS INTEGER)
		              AND json_extract(i.config, '$.autoPickup.maxPerDay') BETWEEN 1 AND 100
		              THEN json_extract(i.config, '$.autoPickup.maxPerDay') ELSE 10 END
		   AND NOT EXISTS (SELECT 1 FROM auto_pickup_log legacy WHERE legacy.instance_id = i.id
		     AND legacy.outcome = 'started' AND legacy.reserved = 1 AND legacy.created_at > ?15)
		   AND (?13 IS NULL OR NOT EXISTS (SELECT 1 FROM provider_account_holds h WHERE h.user_id = ?3
		     AND h.provider = ?13 AND h.credential_id = ?14 AND h.cleared_at IS NULL))
		   AND NOT EXISTS (SELECT 1 FROM auto_pickup_admissions previous WHERE previous.instance_id = i.id
		     AND previous.repo_id = ?4 AND previous.issue_number = ?6 AND previous.admission_id > ?12)
		   AND NOT EXISTS (SELECT 1 FROM instance_objective_queue q WHERE q.instance_id = i.id AND q.status IN ('pending', 'running'))
		   AND NOT EXISTS (SELECT 1 FROM agent_loop_runs r WHERE r.instance_id = i.id AND r.status = 'running'
		     AND (r.checkout_released_at IS NULL OR EXISTS (SELECT 1 FROM coder_questions cq WHERE cq.run_id = r.run_id
		       AND cq.applied_at IS NULL AND (cq.answered_at IS NOT NULL OR cq.state = 'unresolved'))))`,
	)
		.bind(a.entryId, a.instanceId, a.userId, a.repoId, a.repo, a.issue, a.objective.slice(0, MAX_CONFIGURABLE_OBJECTIVE_CHARS), a.maxIterations, a.detail, a.now, a.now - 86_400_000, a.observedAdmission, a.providerAccount?.provider ?? null, a.providerAccount?.credentialId ?? null, a.now - RESERVATION_TTL_MS)
		.run();
	// Pending rows include the first wake's trigger-written objective, even while it is being
	// admitted (queue.status=running, before agent_loop_runs exists). No model or runner is started here.
	return (result.meta?.changes ?? 0) > 0;
}

/** A commit whose process died before kicking its queue is retried through the existing atomic
 * dequeue, without claiming another allowance or making another objective. Timed deferrals retain
 * their clock; a real running admission/checkout retains its ownership.
 */
export async function pendingAutoPickupAdmission(env: Pick<Env, "DB">, instanceId: string, userId: string, now = Date.now()): Promise<{ entryId: string; repoId: string; repo: string; issue: number } | null> {
	const row = await env.DB.prepare(
		`SELECT l.entry_id AS entryId, q.repo_id AS repoId, l.repo, l.issue_number AS issue
		 FROM auto_pickup_log l JOIN instance_objective_queue q ON q.id = l.entry_id
		 WHERE l.instance_id = ?1 AND l.user_id = ?2 AND l.outcome = 'started' AND l.reserved = 0
		   AND q.repo_id IS NOT NULL AND l.repo IS NOT NULL AND l.issue_number IS NOT NULL AND q.status = 'pending' AND (q.next_retry_at IS NULL OR q.next_retry_at <= ?3)
		   AND NOT EXISTS (SELECT 1 FROM instance_objective_queue busy WHERE busy.instance_id = ?1 AND busy.status = 'running')
		   AND NOT EXISTS (SELECT 1 FROM agent_loop_runs r WHERE r.instance_id = ?1 AND r.status = 'running'
		     AND (r.checkout_released_at IS NULL OR EXISTS (SELECT 1 FROM coder_questions cq WHERE cq.run_id = r.run_id
		       AND cq.applied_at IS NULL AND (cq.answered_at IS NOT NULL OR cq.state = 'unresolved'))))
		 ORDER BY l.created_at, l.entry_id LIMIT 1`,
	).bind(instanceId, userId, now).first<{ entryId: string; repoId: string; repo: string; issue: number }>();
	return row;
}
