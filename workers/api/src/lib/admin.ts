import type { Env, SessionPayload } from "../types.js";
import { agentCapabilities } from "./agent-capabilities.js";
import { relayConnected } from "./runner-client.js";
import { registryTools } from "./tool-registry.js";
import { CHARGED_SQL } from "./usage-payer.js";

// toolName → { connector, scope } for connector-provided registry tools (built once).
// Only tools that declare a connector are relevant to the connector admin views.
const TOOL_META = new Map(
	registryTools()
		.filter((t): t is typeof t & { connector: string; scope: "read" | "write" } => !!t.connector && !!t.scope)
		.map((t) => [t.name, { connector: t.connector, scope: t.scope }] as const),
);

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
	/**
	 * Notional list-price value of this user's AI consumption over 30 days — NOT a bill (#346).
	 *
	 * It was called `spend30dMicros` while summing every row, which is the claim #343 was made of:
	 * an engine session on the owner's Claude subscription accrues real tokens at a list-price
	 * figure nobody is charged. The sum still counts everything, deliberately — this column is how
	 * an operator sees who is USING the platform, and filtering it to charged rows would make a
	 * subscription-heavy account read as idle. It just no longer says "spend".
	 */
	value30dMicros: number;
	/** The subset that is money someone owes (`payer` byok-api / platform). The cost-governance one. */
	charged30dMicros: number;
	/** Moderation state (#34) — surfaced in the list so an operator can see who is blocked. */
	suspended: boolean;
	suspended_at: string | null;
	suspended_reason: string | null;
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
	value_30d_micros: number;
	charged_30d_micros: number;
	suspended: number | null;
	suspended_at: string | null;
	suspended_reason: string | null;
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
		value30dMicros: r.value_30d_micros || 0,
		charged30dMicros: r.charged_30d_micros || 0,
		suspended: !!r.suspended,
		suspended_at: r.suspended_at ?? null,
		suspended_reason: r.suspended_reason ?? null,
	};
}

const USER_SELECT = `SELECT u.id, u.github_login, u.github_name, u.avatar_url, u.roles, u.subscription_status,
	        u.created_at, u.updated_at, u.suspended, u.suspended_at, u.suspended_reason,
	        (SELECT COUNT(*) FROM agents a WHERE a.owner_id = u.id) AS agents_owned,
	        (SELECT COUNT(*) FROM agent_instances i WHERE i.user_id = u.id AND i.status = 'active') AS active_instances,
	        (SELECT GROUP_CONCAT(k.provider) FROM user_api_keys k WHERE k.user_id = u.id) AS key_providers,
	        (SELECT COALESCE(SUM(x.cost_micros), 0) FROM ai_usage x WHERE x.user_id = u.id AND x.created_at >= ?) AS value_30d_micros,
	        (SELECT COALESCE(SUM(x.cost_micros), 0) FROM ai_usage x WHERE x.user_id = u.id AND x.created_at >= ? AND ${CHARGED_SQL}) AS charged_30d_micros
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
	// Two `?` before any search term: the value rollup's window, then the charged rollup's.
	const listBinds: unknown[] = [since, since];
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
	updated_at: string;
	owner_id: string;
	owner_login: string | null;
	instances: number;
	/** Distinct connectors this agent uses (derived from its declared capability tools). */
	connectors: string[];
	/**
	 * Capability SUMMARY (surfaces/runtime/workflow) — deliberately not the full `tools`
	 * array, which on a 200-row page would dominate the payload. The complete tool list
	 * is on the detail endpoint.
	 */
	capabilities: { surfaces: string[]; runtime: string | null; workflow: string | null };
}

export interface AdminAgentFilters {
	search?: string;
	/** 'draft' | 'published' | 'unlisted' */
	visibility?: string;
	/** 'inactive' | 'active' | 'error' */
	status?: string;
	/** Owner by user id OR github_login — an operator has the login, rarely the uid. */
	owner?: string;
	limit?: number;
	offset?: number;
}

/**
 * Build the shared WHERE for the agents list. Returned as a fragment + binds so the
 * list and the COUNT run the SAME predicate — when they drifted, pagination lied
 * (page 2 of a filtered list showed a total from the unfiltered one).
 */
function agentWhere(opts: AdminAgentFilters): { where: string; binds: unknown[] } {
	const clauses: string[] = [];
	const binds: unknown[] = [];
	const search = opts.search?.trim();
	if (search) {
		const like = `%${search}%`;
		clauses.push("(a.slug LIKE ? OR a.name LIKE ? OR u.github_login LIKE ?)");
		binds.push(like, like, like);
	}
	if (opts.visibility) {
		clauses.push("a.visibility = ?");
		binds.push(opts.visibility);
	}
	if (opts.status) {
		clauses.push("a.status = ?");
		binds.push(opts.status);
	}
	if (opts.owner) {
		clauses.push("(a.owner_id = ? OR u.github_login = ?)");
		binds.push(opts.owner, opts.owner);
	}
	return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", binds };
}

/**
 * All agents across all tenants, INCLUDING drafts and unlisted — the public
 * /v1/agents deliberately shows only published ones, so an operator had no way to
 * see a broken draft a creator was complaining about.
 */
export async function listAgents(
	env: Env,
	opts: AdminAgentFilters = {},
): Promise<{ agents: AdminAgentRow[]; total: number }> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
	const offset = Math.max(opts.offset ?? 0, 0);
	const { where, binds: whereBinds } = agentWhere(opts);
	const from = " FROM agents a LEFT JOIN users u ON u.id = a.owner_id";
	const sql = `SELECT a.id, a.slug, a.name, a.category, a.model, a.visibility, a.status,
	        a.created_at, a.updated_at, a.owner_id, a.config,
	        u.github_login AS owner_login,
	        (SELECT COUNT(*) FROM agent_instances i WHERE i.agent_id = a.id AND i.status = 'active') AS instances
	${from}${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`;
	const countSql = `SELECT COUNT(*) AS n${from}${where}`;
	const [rows, count] = await Promise.all([
		env.DB.prepare(sql).bind(...whereBinds, limit, offset).all<AdminAgentRow & { config: string | null }>(),
		env.DB.prepare(countSql).bind(...whereBinds).first<{ n: number }>(),
	]);
	const agents = (rows.results ?? []).map((r) => {
		const caps = agentCapabilities({ slug: r.slug, category: r.category, config: r.config });
		const { config: _drop, ...rest } = r;
		return {
			...rest,
			connectors: connectorsForTools(caps.tools),
			capabilities: { surfaces: caps.surfaces ?? [], runtime: caps.runtime ?? null, workflow: caps.workflow ?? null },
		};
	});
	return { agents, total: count?.n ?? 0 };
}

export interface AdminAgentDetail {
	agent: AdminAgentRow;
	capabilities: { surfaces: string[]; runtime: string | null; workflow: string | null; tools: string[] };
	/** The agent's connector tools, grouped by connector, with each tool's scope. */
	connectorTools: Array<{ connector: string; tools: Array<{ name: string; scope: string }> }>;
	instances: Array<{ id: string; owner_login: string | null; status: string; created_at: string; consents: Array<{ connector: string; scope: string }> }>;
	/** Subscriber counts: every instance ever created vs the ones still active. */
	subscribers: { total: number; active: number };
	/** Newest agent_events across ALL of this agent's instances — "is it actually being used, and does it work". */
	recentActivity: Array<{ id: string; ts: number; instance_id: string | null; source: string; level: string; event: string; message: string | null }>;
}

/** Full admin detail for one agent (by id or slug), incl. its connectors + instances' consents. */
export async function getAgentDetail(env: Env, idOrSlug: string): Promise<AdminAgentDetail | null> {
	const raw = await env.DB.prepare(
		`SELECT a.id, a.slug, a.name, a.category, a.model, a.visibility, a.status,
		        a.created_at, a.updated_at, a.owner_id, a.config,
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

	// Recent activity across EVERY instance of this agent — the operator question is
	// "is this agent working for anyone", which no per-tenant trace can answer.
	const activity = (await env.DB.prepare(
		`SELECT e.id, e.ts, e.instance_id, e.source, e.level, e.event, e.message
		 FROM agent_events e JOIN agent_instances i ON i.id = e.instance_id
		 WHERE i.agent_id = ?1 ORDER BY e.ts DESC LIMIT 25`,
	).bind(raw.id).all<AdminAgentDetail["recentActivity"][number]>().catch(() => ({ results: [] }))).results ?? [];

	const { config: _c, ...agentRow } = raw;
	return {
		agent: {
			...agentRow,
			connectors: connectorsForTools(tools),
			capabilities: { surfaces: caps.surfaces ?? [], runtime: caps.runtime ?? null, workflow: caps.workflow ?? null },
		},
		capabilities: { surfaces: caps.surfaces ?? [], runtime: caps.runtime ?? null, workflow: caps.workflow ?? null, tools },
		connectorTools,
		instances: instRows.map((i) => ({ ...i, consents: consentsByInstance.get(i.id) ?? [] })),
		subscribers: { total: instRows.length, active: instRows.filter((i) => i.status === "active").length },
		recentActivity: activity,
	};
}

export interface AdminInstanceRow {
	id: string;
	agent_id: string;
	agent_name: string | null;
	agent_slug: string | null;
	user_id: string;
	owner_login: string | null;
	/** The subscriber's own name for this instance (config.displayName), if they renamed it. */
	display_name: string | null;
	status: string;
	created_at: string;
	updated_at: string;
	/** Machines that have ever registered a runner for this instance. */
	runtime_nodes: number;
	last_seen_at: string | null;
	/**
	 * Is a runner WebSocket connected RIGHT NOW (RelayDO, authoritative)?
	 * `null` = not checked, either because the instance has no registered runner or
	 * because the per-request live-check budget was exhausted. Never infer "offline"
	 * from `null` — the DB `status` column is not cleared on disconnect, which is the
	 * exact lie this field exists to replace.
	 */
	runtimeConnected: boolean | null;
}

export interface AdminInstanceFilters {
	/** Agent id or slug. */
	agent?: string;
	/** Owner by user id OR github_login. */
	owner?: string;
	/** 'active' | 'paused' | 'canceled' */
	status?: string;
	limit?: number;
	offset?: number;
	/** Skip the RelayDO live checks (they cost one DO round-trip per candidate row). */
	skipLive?: boolean;
}

/**
 * A live check is one RelayDO round-trip. A 200-row page of runner-backed instances
 * would fan out 200 of them, so the budget is capped and the overflow reports `null`
 * ("unknown") rather than a fabricated `false`. Mirrors the cap in /v1/admin/terminals.
 */
const LIVE_CHECK_BUDGET = 50;

export async function listInstances(
	env: Env,
	opts: AdminInstanceFilters = {},
): Promise<{ instances: AdminInstanceRow[]; total: number }> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
	const offset = Math.max(opts.offset ?? 0, 0);

	const clauses: string[] = [];
	const binds: unknown[] = [];
	if (opts.agent) {
		clauses.push("(i.agent_id = ? OR a.slug = ?)");
		binds.push(opts.agent, opts.agent);
	}
	if (opts.owner) {
		clauses.push("(i.user_id = ? OR u.github_login = ?)");
		binds.push(opts.owner, opts.owner);
	}
	if (opts.status) {
		clauses.push("i.status = ?");
		binds.push(opts.status);
	}
	const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
	const from = ` FROM agent_instances i
			 LEFT JOIN agents a ON a.id = i.agent_id
			 LEFT JOIN users u ON u.id = i.user_id`;

	const [rows, count] = await Promise.all([
		env.DB.prepare(
			`SELECT i.id, i.agent_id, a.name AS agent_name, a.slug AS agent_slug, i.user_id,
			        u.github_login AS owner_login, i.status, i.created_at, i.updated_at,
			        json_extract(i.config, '$.displayName') AS display_name,
			        (SELECT COUNT(*) FROM instance_runtime_nodes n WHERE n.instance_id = i.id) AS runtime_nodes,
			        (SELECT MAX(n.last_seen_at) FROM instance_runtime_nodes n WHERE n.instance_id = i.id) AS last_seen_at
			 ${from}${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
		).bind(...binds, limit, offset).all<Omit<AdminInstanceRow, "runtimeConnected">>(),
		env.DB.prepare(`SELECT COUNT(*) AS n${from}${where}`).bind(...binds).first<{ n: number }>(),
	]);

	const instances: AdminInstanceRow[] = (rows.results ?? []).map((r) => ({ ...r, runtimeConnected: null }));
	if (!opts.skipLive) {
		let budget = LIVE_CHECK_BUDGET;
		await Promise.all(
			instances.map(async (inst) => {
				if (!inst.runtime_nodes || budget-- <= 0) return; // no runner ever registered, or budget spent → stays null
				inst.runtimeConnected = await anyRunnerConnected(env, inst.id).catch(() => false);
			}),
		);
	}
	return { instances, total: count?.n ?? 0 };
}

/**
 * Is ANY of this instance's registered machines connected right now? Asks the RelayDO
 * (which holds the socket) per node, not `instance_runtime_nodes.status` — that column
 * is never cleared on an unclean disconnect, so it reads "online" for machines that
 * have been off for days.
 */
export async function anyRunnerConnected(env: Env, instanceId: string): Promise<boolean> {
	const { results } = await env.DB.prepare(
		"SELECT DISTINCT runner_node FROM instance_runtime_nodes WHERE instance_id = ?1",
	).bind(instanceId).all<{ runner_node: string | null }>();
	const nodes = (results ?? []).map((r) => r.runner_node).filter((n): n is string => !!n);
	if (!nodes.length) return relayConnected(env, instanceId, null);
	const checks = await Promise.all(nodes.map((n) => relayConnected(env, instanceId, n).catch(() => false)));
	return checks.some(Boolean);
}

// ── Overview stats (one round-trip for the dashboard header) ────────────────

export interface AdminOverviewStats {
	users: number;
	agents: number;
	agentsPublished: number;
	instancesActive: number;
	errors24h: number;
	aiCalls24h: number;
	/** List-price value of ALL AI in the window — the activity figure, not a bill (#346). */
	value30dMicros: number;
	/** What the platform itself is billed for: `payer = 'platform'`. Money, and ours. */
	platformSpend30dMicros: number;
}

export async function getOverviewStats(env: Env): Promise<AdminOverviewStats> {
	const d1 = sinceTs(1);
	const d30 = sinceTs(30);
	// Reads the first column whatever it is aliased, so each aggregate can carry a name that says
	// what it is (#346) rather than every one of them answering to `n`.
	const scalar = async (sql: string, ...b: unknown[]) => {
		const row = await env.DB.prepare(sql).bind(...b).first<Record<string, unknown>>();
		return Number(Object.values(row ?? {})[0] ?? 0) || 0;
	};
	const [users, agents, agentsPublished, instancesActive, errors24h, aiCalls24h, value30d, platformSpend30d] = await Promise.all([
		scalar("SELECT COUNT(*) AS n FROM users"),
		scalar("SELECT COUNT(*) AS n FROM agents"),
		scalar("SELECT COUNT(*) AS n FROM agents WHERE visibility = 'published'"),
		scalar("SELECT COUNT(*) AS n FROM agent_instances WHERE status = 'active'"),
		scalar("SELECT COUNT(*) AS n FROM error_log WHERE created_at >= ?", d1),
		scalar("SELECT COUNT(*) AS n FROM ai_usage WHERE created_at >= ?", d1),
		scalar("SELECT COALESCE(SUM(cost_micros),0) AS value_micros FROM ai_usage WHERE created_at >= ?", d30),
		// Platform-paid, on the payer axis rather than the vendor one. `recordPlatformUsage` writes
		// provider AND payer as 'platform' in the same INSERT, so for rows written since migration
		// 0092 the two are the same set; older rows have a NULL payer and are attributed by vendor,
		// which for OUR Workers AI binding states the same fact rather than inferring it.
		scalar(
			"SELECT COALESCE(SUM(cost_micros),0) AS charged_micros FROM ai_usage WHERE (payer = 'platform' OR (payer IS NULL AND provider = 'platform')) AND created_at >= ?",
			d30,
		),
	]);
	return { users, agents, agentsPublished, instancesActive, errors24h, aiCalls24h, value30dMicros: value30d, platformSpend30dMicros: platformSpend30d };
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
	// USER_SELECT's two usage sub-queries take the first two `?` (both the same window); the id
	// is the third.
	const since = sinceTs(30);
	const raw = await env.DB.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(since, since, id).first<RawUserRow>();
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
