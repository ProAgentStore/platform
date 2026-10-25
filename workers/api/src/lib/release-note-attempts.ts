/** The append-only receipt trail for release-note sends (#1348, migration 0290). Rows are only ever inserted. */
import type { Env } from "../types.js";

export type AttemptKind = "send" | "retry" | "reconcile_delivered" | "reconcile_abandoned" | "reconcile_retry";

export interface AttemptInput {
	id?: string;
	queueId: string;
	userId: string;
	instanceId: string;
	kind: AttemptKind;
	outcome: string;
	reason?: string | null;
	permalink?: string | null;
	evidence?: unknown;
	/** Unique across the table: a repeat of the same key is the same attempt. */
	key: string;
	now?: number;
}

/** Insert one attempt. Returns its id, or null when the key was already used (the earlier attempt stands). */
export async function recordAttempt(env: Env, a: AttemptInput): Promise<string | null> {
	const id = a.id ?? crypto.randomUUID();
	const res = await env.DB.prepare("INSERT OR IGNORE INTO release_note_attempts (id,queue_id,user_id,instance_id,kind,outcome,reason,permalink,evidence_json,idempotency_key,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)")
		.bind(id, a.queueId, a.userId, a.instanceId, a.kind, a.outcome, a.reason ?? null, a.permalink ?? null, a.evidence === undefined ? null : JSON.stringify(a.evidence), a.key, a.now ?? Date.now()).run();
	return res.meta.changes ? id : null;
}
