import type { Env, SessionPayload } from "../types.js";
import { agentCapabilities } from "./agent-capabilities.js";
import { registryTools } from "./tool-registry.js";

// toolName → { connector, scope } from the registry (built once).
const TOOL_META = new Map(registryTools().map((t) => [t.name, { connector: t.connector, scope: t.scope }] as const));

/** Distinct connector names an agent uses, derived from its declared capability tools. */
function connectorsForTools(tools?: string[]): string[] {
	const s = new Set<string>();
	for (const t of tools ?? []) { const m = TOOL_META.get(t); if (m) s.add(m.connector); }
	return [...s].sort();
}

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
	        (SELECT COALESCE(SUM(x.cost_micros), 0) FROM ai_usage x WHERE x.user_id = u.id AND x.created_at >= ?) AS spend_30d_micros
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

// ── Agents & Instances (operator cross-tenant views) ───────────────────────

export interface AdminAgentRow {
	id: string;
	slug: string;
	name: string;
	category: string;
	model: string;
	visibility: string;
	status: string;
	created_at: string;
	owner_login: string | null;
	instances: number;
	/** Distinct connectors this agent uses (derived from its declared capability tools). */
	connectors: string[];
}

export async function listAgents(
	env: Env,
	opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ agents: AdminAgentRow[]; total: number }> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
	const offset = Math.max(opts.offset ?? 0, 0);
	const search = opts.search?.trim();
	let sql = `SELECT a.id, a.slug, a.name, a.category, a.model, a.visibility, a.status, a.created_at, a.config,
	        u.github_login AS owner_login,
	        (SELECT COUNT(*) FROM agent_instances i WHERE i.agent_id = a.id AND i.status = 'active') AS instances
	 FROM agents a LEFT JOIN users u ON u.id = a.owner_id`;
	let countSql = "SELECT COUNT(*) AS n FROM agents a";
	const binds: unknown[] = [];
	const cbinds: unknown[] = [];
	if (search) {
		const like = `%${search}%`;
		const cond = " WHERE a.slug LIKE ? OR a.name LIKE ? OR u.github_login LIKE ?";
		sql += cond;
		countSql = "SELECT COUNT(*) AS n FROM agents a LEFT JOIN users u ON u.id = a.owner_id" + cond;
		binds.push(like, like, like);
		cbinds.push(like, like, like);
	}
	sql += " ORDER BY a.created_at DESC LIMIT ? OFFSET ?";
	binds.push(limit, offset);
	const [rows, count] = await Promise.all([
		env.DB.prepare(sql).bind(...binds).all<AdminAgentRow & { config: string | null }>(),
		env.DB.prepare(countSql).bind(...cbinds).first<{ n: number }>(),
	]);
	const agents = (rows.results ?? []).map((r) => {
		const caps = agentCapabilities({ slug: r.slug, category: r.category, config: r.config });
		const { config: _drop, ...rest } = r;
		return { ...rest, connectors: connectorsForTools(caps.tools) };
	});
	return { agents, total: count?.n ?? 0 };
}

export interface AdminAgentDetail {
	agent: AdminAgentRow;
	capabilities: { surfaces: string[]; runtime: string | null; workflow: string | null; tools: string[] };
	/** The agent's connector tools, grouped by connector, with each tool's scope. */
	connectorTools: Array<{ connector: string; tools: Array<{ name: string; scope: string }> }>;
	instances: Array<{ id: string; owner_login: string | null; status: string; created_at: string; consents: Array<{ connector: string; scope: string }> }>;
}

/** Full admin detail for one agent (by id or slug), incl. its connectors + instances' consents. */
export async function getAgentDetail(env: Env, idOrSlug: string): Promise<AdminAgentDetail | null> {
	const raw = await env.DB.prepare(
		`SELECT a.id, a.slug, a.name, a.category, a.model, a.visibility, a.status, a.created_at, a.config,
		        u.github_login AS owner_login,
		        (SELECT COUNT(*) FROM agent_instances i WHERE i.agent_id = a.id AND i.status = 'active') AS instances
		 FROM agents a LEFT JOIN users u ON u.id = a.owner_id WHERE a.id = ?1 OR a.slug = ?1`,
	).bind(idOrSlug).first<AdminAgentRow & { config: string | null }>();
	if (!raw) return null;
	const caps = agentCapabilities({ slug: raw.slug, category: raw.category, config: raw.config });
	const tools = caps.tools ?? [];

	// connector tools grouped by connector
	const byConnector = new Map<string, Array<{ name: string; scope: string }>>();
	for (const t of tools) {
		const m = TOOL_META.get(t);
		if (!m) continue;
		const arr = byConnector.get(m.connector) ?? [];
		arr.push({ name: t, scope: m.scope });
		byConnector.set(m.connector, arr);
	}
	const connectorTools = [...byConnector.entries()].map(([connector, ts]) => ({ connector, tools: ts }));

	const instRows = (await env.DB.prepare(
		`SELECT i.id, i.status, i.created_at, u.github_login AS owner_login
		 FROM agent_instances i LEFT JOIN users u ON u.id = i.user_id
		 WHERE i.agent_id = ?1 ORDER BY i.created_at DESC`,
	).bind(raw.id).all<{ id: string; status: string; created_at: string; owner_login: string | null }>()).results ?? [];

	const consentRows = (await env.DB.prepare(
		`SELECT c.instance_id, c.connector, c.scope
		 FROM instance_connector_consent c JOIN agent_instances i ON i.id = c.instance_id
		 WHERE i.agent_id = ?1`,
	).bind(raw.id).all<{ instance_id: string; connector: string; scope: string }>()).results ?? [];
	const consentsByInstance = new Map<string, Array<{ connector: string; scope: string }>>();
	for (const r of consentRows) {
		const arr = consentsByInstance.get(r.instance_id) ?? [];
		arr.push({ connector: r.connector, scope: r.scope });
		consentsByInstance.set(r.instance_id, arr);
	}

	const { config: _c, ...agentRow } = raw;
	return {
		agent: { ...agentRow, connectors: connectorsForTools(tools) },
		capabilities: { surfaces: caps.surfaces ?? [], runtime: caps.runtime ?? null, workflow: caps.workflow ?? null, tools },
		connectorTools,
		instances: instRows.map((i) => ({ ...i, consents: consentsByInstance.get(i.id) ?? [] })),
	};
}

export interface AdminInstanceRow {
	id: string;
	agent_id: string;
	agent_name: string | null;
	owner_login: string | null;
	status: string;
	created_at: string;
}

export async function listInstances(
	env: Env,
	opts: { limit?: number; offset?: number } = {},
): Promise<{ instances: AdminInstanceRow[]; total: number }> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
	const offset = Math.max(opts.offset ?? 0, 0);
	const [rows, count] = await Promise.all([
		env.DB.prepare(
			`SELECT i.id, i.agent_id, a.name AS agent_name, u.github_login AS owner_login, i.status, i.created_at
			 FROM agent_instances i
			 LEFT JOIN agents a ON a.id = i.agent_id
			 LEFT JOIN users u ON u.id = i.user_id
			 ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
		).bind(limit, offset).all<AdminInstanceRow>(),
		env.DB.prepare("SELECT COUNT(*) AS n FROM agent_instances").first<{ n: number }>(),
	]);
	return { instances: rows.results ?? [], total: count?.n ?? 0 };
}

// ── Overview stats (one round-trip for the dashboard header) ────────────────

export interface AdminOverviewStats {
	users: number;
	agents: number;
	agentsPublished: number;
	instancesActive: number;
	errors24h: number;
	aiCalls24h: number;
	spend30dMicros: number;
	platformSpend30dMicros: number;
}

export async function getOverviewStats(env: Env): Promise<AdminOverviewStats> {
	const d1 = sinceTs(1);
	const d30 = sinceTs(30);
	const one = async (sql: string, ...b: unknown[]) =>
		(await env.DB.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0;
	const [users, agents, agentsPublished, instancesActive, errors24h, aiCalls24h, spend30d, platformSpend30d] = await Promise.all([
		one("SELECT COUNT(*) AS n FROM users"),
		one("SELECT COUNT(*) AS n FROM agents"),
		one("SELECT COUNT(*) AS n FROM agents WHERE visibility = 'published'"),
		one("SELECT COUNT(*) AS n FROM agent_instances WHERE status = 'active'"),
		one("SELECT COUNT(*) AS n FROM error_log WHERE created_at >= ?", d1),
		one("SELECT COUNT(*) AS n FROM ai_usage WHERE created_at >= ?", d1),
		one("SELECT COALESCE(SUM(cost_micros),0) AS n FROM ai_usage WHERE created_at >= ?", d30),
		one("SELECT COALESCE(SUM(cost_micros),0) AS n FROM ai_usage WHERE provider = 'platform' AND created_at >= ?", d30),
	]);
	return { users, agents, agentsPublished, instancesActive, errors24h, aiCalls24h, spend30dMicros: spend30d, platformSpend30dMicros: platformSpend30d };
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
	// USER_SELECT's spend sub-query has the first `?` (since); the id is the second.
	const raw = await env.DB.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(sinceTs(30), id).first<RawUserRow>();
	if (!raw) return null;
	const [agents, instances, keys, errors] = await Promise.all([
		env.DB.prepare("SELECT id, slug, name, visibility, status, created_at FROM agents WHERE owner_id = ? ORDER BY created_at DESC").bind(id).all<AdminUserDetail["agents"][number]>(),
		env.DB.prepare("SELECT i.id, i.agent_id, a.name AS agent_name, i.status, i.created_at FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.user_id = ? ORDER BY i.created_at DESC").bind(id).all<AdminUserDetail["instances"][number]>(),
		env.DB.prepare("SELECT provider, created_at, last_used_at FROM user_api_keys WHERE user_id = ?").bind(id).all<AdminUserDetail["keyProviders"][number]>(),
		env.DB.prepare("SELECT id, created_at, source, status, message FROM error_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(id).all<AdminUserDetail["recentErrors"][number]>(),
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
