import type { Env, SessionPayload } from "../types.js";

/**
 * Admin-action audit log (issue #28). Every privileged mutation in a /v1/admin/*
 * handler MUST call this after it succeeds, so there's a durable record of who did
 * what to whom. Best-effort: a logging failure never breaks the action (mirrors
 * lib/error-log.ts / recordUsage). Read back via GET /v1/admin/audit.
 */
export async function recordAdminAction(
	env: Env,
	actor: SessionPayload,
	action: string,
	target?: { type?: string; id?: string },
	detail?: unknown,
): Promise<void> {
	try {
		await env.DB.prepare(
			`INSERT INTO admin_audit_log (id, actor_user_id, action, target_type, target_id, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
			.bind(
				crypto.randomUUID(),
				actor.uid,
				action,
				target?.type ?? null,
				target?.id ?? null,
				detail === undefined ? null : JSON.stringify(detail),
			)
			.run();
	} catch {
		// swallow — auditing must never break the underlying admin action
	}
}

export interface AdminAuditRow {
	id: string;
	created_at: string;
	actor_user_id: string;
	action: string;
	target_type: string | null;
	target_id: string | null;
	detail: string | null;
}

/** Read back the admin audit log (newest first), with optional filters. */
export async function listAdminAudit(
	env: Env,
	opts: { actor?: string; action?: string; targetId?: string; limit?: number } = {},
): Promise<AdminAuditRow[]> {
	const where: string[] = [];
	const binds: unknown[] = [];
	if (opts.actor) {
		binds.push(opts.actor);
		where.push(`actor_user_id = ?${binds.length}`);
	}
	if (opts.action) {
		binds.push(opts.action);
		where.push(`action = ?${binds.length}`);
	}
	if (opts.targetId) {
		binds.push(opts.targetId);
		where.push(`target_id = ?${binds.length}`);
	}
	const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
	const sql = `SELECT id, created_at, actor_user_id, action, target_type, target_id, detail
       FROM admin_audit_log
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC
       LIMIT ${limit}`;
	const res = await env.DB.prepare(sql)
		.bind(...binds)
		.all<AdminAuditRow>();
	return res.results ?? [];
}
