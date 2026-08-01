import type { Env, SessionPayload } from "../types.js";

// ── Cross-user reads (issue #30) ───────────────────────────────────────────
// Every query is parameterized. NEVER selects key/credential/token material —
// only provider names. All callers are behind requireAdmin.

export interface AdminUserRow {
	id: string;
	github_login: string;
	github_name: string;
	avatar_url: string;
	roles: string[];
	subscription_status: string | null;
	created_at: string;
	updated_at: string;
	agents_owned: number;
	active_instances: number;
	key_providers: string[];
	spend30dMicros: number;
}

interface RawUserRow {
	id: string;
	github_login: string;
	github_name: string;
	avatar_url: string;
	roles: string | null;
	subscription_status: string | null;
	created_at: string;
	updated_at: string;
	agents_owned: number;
	active_instances: number;
	key_providers: string | null;
	spend_30d_micros: number;
}

function parseRoles(raw: string | null | undefined): string[] {
	if (!raw) return ["user"];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v : ["user"];
	} catch {
		return ["user"];
	}
}

function shapeUser(r: RawUserRow): AdminUserRow {
	return {
		id: r.id,
		github_login: r.github_login,
		github_name: r.github_name,
		avatar_url: r.avatar_url,
		roles: parseRoles(r.roles),
		subscription_status: r.subscription_status,
		created_at: r.created_at,
		updated_at: r.updated_at,
		agents_owned: r.agents_owned || 0,
		active_instances: r.active_instances || 0,
		key_providers: r.key_providers ? r.key_providers.split(",").filter(Boolean) : [],
		spend30dMicros: r.spend_30d_micros || 0,
	};
}

const USER_SELECT = `SELECT u.id, u.github_login, u.github_name, u.avatar_url, u.roles, u.subscription_status,
	        u.created_at, u.updated_at,
	        (SELECT COUNT(*) FROM agents a WHERE a.owner_id = u.id) AS agents_owned,
	        (SELECT COUNT(*) FROM agent_instances i WHERE i.user_id = u.id AND i.status = 'active') AS active_instances,
	        (SELECT GROUP_CONCAT(k.provider) FROM user_api_keys k WHERE k.user_id = u.id) AS key_providers,
	        (SELECT COALESCE(SUM(x.cost_micros), 0) FROM ai_usage x WHERE x.user_id = u.id AND x.created_at >= ?1) AS spend_30d_micros
	 FROM users u`;

/** "YYYY-MM-DD HH:MM:SS" for `days` ago (UTC), matching D1 datetime('now'). */
function sinceTs(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

/** Paginated, searchable list of all users with rollup counts + 30-day spend. */
export async function listUsers(
	env: Env,
	opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ users: AdminUserRow[]; total: number }> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
	const offset = Math.max(opts.offset ?? 0, 0);
	const since = sinceTs(30);
	const search = opts.search?.trim();

	let listSql = USER_SELECT;
	let countSql = "SELECT COUNT(*) AS n FROM users u";
	const listBinds: unknown[] = [since];
	const countBinds: unknown[] = [];
	if (search) {
		const like = `%${search}%`;
		const cond = " WHERE u.github_login LIKE ? OR u.github_name LIKE ? OR u.id = ?";
		listSql += cond;
		countSql += cond;
		listBinds.push(like, like, search);
		countBinds.push(like, like, search);
	}
	listSql += " ORDER BY u.created_at DESC LIMIT ? OFFSET ?";
	listBinds.push(limit, offset);

	const [listRes, countRes] = await Promise.all([
		env.DB.prepare(listSql).bind(...listBinds).all<RawUserRow>(),
		env.DB.prepare(countSql).bind(...countBinds).first<{ n: number }>(),
	]);
	return { users: (listRes.results ?? []).map(shapeUser), total: countRes?.n ?? 0 };
}

export interface AdminUserDetail {
	user: AdminUserRow;
	agents: Array<{ id: string; slug: string; name: string; visibility: string; status: string; created_at: string }>;
	instances: Array<{ id: string; agent_id: string; agent_name: string | null; status: string; created_at: string }>;
	keyProviders: Array<{ provider: string; created_at: string; last_used_at: string | null }>;
	recentErrors: Array<{ id: string; created_at: string; source: string; status: number | null; message: string }>;
}

/** Full detail for one user, or null if not found. Never returns key material. */
export async function getUserDetail(env: Env, id: string): Promise<AdminUserDetail | null> {
	const raw = await env.DB.prepare(`${USER_SELECT} WHERE u.id = ?2`).bind(sinceTs(30), id).first<RawUserRow>();
	if (!raw) return null;
	const [agents, instances, keys, errors] = await Promise.all([
		env.DB.prepare("SELECT id, slug, name, visibility, status, created_at FROM agents WHERE owner_id = ?1 ORDER BY created_at DESC").bind(id).all<AdminUserDetail["agents"][number]>(),
		env.DB.prepare("SELECT i.id, i.agent_id, a.name AS agent_name, i.status, i.created_at FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.user_id = ?1 ORDER BY i.created_at DESC").bind(id).all<AdminUserDetail["instances"][number]>(),
		env.DB.prepare("SELECT provider, created_at, last_used_at FROM user_api_keys WHERE user_id = ?1").bind(id).all<AdminUserDetail["keyProviders"][number]>(),
		env.DB.prepare("SELECT id, created_at, source, status, message FROM error_log WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20").bind(id).all<AdminUserDetail["recentErrors"][number]>(),
	]);
	return {
		user: shapeUser(raw),
		agents: agents.results ?? [],
		instances: instances.results ?? [],
		keyProviders: keys.results ?? [],
		recentErrors: errors.results ?? [],
	};
}

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
